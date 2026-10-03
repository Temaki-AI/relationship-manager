import { getCloudflareContext } from '@opennextjs/cloudflare';
import { IdempotencyError, requireIdempotencyKey } from '@/lib/idempotency';
import { readFormDataBody, MULTIPART_OVERHEAD_BYTES, RequestBodyError } from '@/lib/request-body';
import { readCloudObject } from '@/lib/cloud/request';
import { recoveryErrorResponse } from '@/lib/cloud/recovery-contract';
import { MAX_CLOUD_IMPORT_BYTES, parseImportPreview } from '@/lib/import-preview';
import { IMPORT_ROW_STATES, type ImportReportRow } from '@/lib/import-report';

type DB = CloudflareEnv['DB'];
type ReportSqlRow = Omit<ImportReportRow, 'matches' | 'fileMatches'> & { matches: string; file_matches: string };
type Job = { id: string; workspace_id: string; fingerprint: string; filename: string; format: 'csv' | 'vcard'; state: string; total: number; source_bytes: number; created_at: string; updated_at: string };
class ImportError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const json = (body: unknown, status = 200) => Response.json(body, { status });
const states = IMPORT_ROW_STATES;
const SOURCE_CHUNK_BYTES = 1_000_000;
const MAX_NORMALIZED_BYTES = 24_000_000;
const MAX_REPORTS = 20;
const MAX_SOURCE_STORAGE = 50 * 1024 * 1024;
const rowColumns = ['row_number', 'name', 'email', 'phone', 'birthday', 'payload', 'state', 'message'];
const contactColumns = ['name', 'nickname', 'email', 'phone', 'photo_url', 'birthday', 'birthday_reminder_days', 'how_we_met', 'tags', 'notes', 'gift_ideas', 'custom_fields', 'last_contacted', 'contact_frequency'];

function phone(column: string) {
  return `replace(replace(replace(replace(replace(replace(COALESCE(${column}, ''), ' ', ''), '+', ''), '-', ''), '(', ''), ')', ''), '.', '')`;
}
function match(a: string, b: string) {
  return `(lower(trim(${a}.name)) = lower(trim(${b}.name))
    OR (${b}.email IS NOT NULL AND lower(trim(${a}.email)) = lower(trim(${b}.email)))
    OR (length(${phone(`${b}.phone`)}) >= 7 AND ${phone(`${a}.phone`)} = ${phone(`${b}.phone`)}))`;
}
const existingMatch = `EXISTS (SELECT 1 FROM contacts c WHERE c.workspace_id = r.workspace_id AND ${match('c', 'r')})`;
const fileMatch = `EXISTS (SELECT 1 FROM contact_import_rows earlier WHERE earlier.job_id = r.job_id AND earlier.workspace_id = r.workspace_id
  AND earlier.row_number < r.row_number AND earlier.state NOT IN ('invalid', 'skipped') AND ${match('earlier', 'r')})`;

async function getJob(db: DB, workspaceId: string, id: string) {
  const job = await db.prepare('SELECT * FROM contact_import_jobs WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).first<Job>();
  if (!job) throw new ImportError('Import report not found.', 404);
  return job;
}

async function view(db: DB, workspaceId: string, id: string, url = new URL('https://crm.invalid/')) {
  const job = await getJob(db, workspaceId, id);
  const counts = Object.fromEntries(states.map((state) => [state, 0]));
  const totals = await db.prepare('SELECT state, COUNT(*) AS count FROM contact_import_rows WHERE workspace_id = ? AND job_id = ? GROUP BY state').bind(workspaceId, id).all<{ state: string; count: number }>();
  for (const row of totals.results as Array<{ state: string; count: number }>) counts[row.state] = row.count;
  const filter = url.searchParams.get('filter') || 'all';
  if (filter !== 'all' && !states.includes(filter as typeof states[number])) throw new ImportError('Unknown import filter.');
  const total = filter === 'all' ? job.total : counts[filter];
  const pages = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(Math.max(1, Number(url.searchParams.get('page')) || 1), pages);
  if (!Number.isInteger(page)) throw new ImportError('Invalid report page.');
  const rows = await db.prepare(`SELECT row_number, name, email, phone, birthday, state, message, contact_id,
    (SELECT json_group_array(json_object('id', id, 'name', name)) FROM
      (SELECT c.id, c.name FROM contacts c WHERE r.state = 'review' AND c.workspace_id = r.workspace_id AND ${match('c', 'r')} ORDER BY c.id LIMIT 5)) AS matches,
    (SELECT json_group_array(json_object('row', row_number, 'name', name)) FROM
      (SELECT earlier.row_number, earlier.name FROM contact_import_rows earlier WHERE r.state = 'review' AND earlier.workspace_id = r.workspace_id
        AND earlier.job_id = r.job_id AND earlier.row_number < r.row_number AND earlier.state NOT IN ('invalid', 'skipped')
        AND ${match('earlier', 'r')} ORDER BY earlier.row_number LIMIT 5)) AS file_matches
    FROM contact_import_rows r WHERE r.workspace_id = ? AND r.job_id = ? AND (? = 'all' OR r.state = ?)
    ORDER BY r.row_number LIMIT 25 OFFSET ?`).bind(workspaceId, id, filter, filter, (page - 1) * 25)
    .all<ReportSqlRow>();
  return { job: { id: job.id, filename: job.filename, format: job.format, state: job.state, total: job.total, createdAt: job.created_at, sourceBytes: job.source_bytes }, counts,
    rows: rows.results.map(({ matches, file_matches, ...row }: ReportSqlRow) => ({ ...row, matches: JSON.parse(matches), fileMatches: JSON.parse(file_matches) })),
    pagination: { page, total, totalPages: pages, pageSize: 25 },
    retention: 'The original file and report remain until you remove this report or erase the workspace. Removing a report does not delete imported contacts.' };
}

export async function createCloudImport(request: Request, workspaceId: string, format: 'csv' | 'vcard') {
  try {
    const db = getCloudflareContext().env.DB;
    const requestKey = requireIdempotencyKey(request.headers);
    const workspace = await db.prepare("SELECT recovery_revision FROM workspaces WHERE id = ? AND lifecycle = 'active'").bind(workspaceId).first<{ recovery_revision: number }>();
    if (!workspace) throw new ImportError('Workspace erasure is in progress. Finish it before importing.', 409);
    const form = await readFormDataBody(request, { maximumBytes: MAX_CLOUD_IMPORT_BYTES + MULTIPART_OVERHEAD_BYTES });
    const file = form.get('file');
    if (!(file instanceof File)) throw new ImportError('Choose a contact file.');
    if (file.size > MAX_CLOUD_IMPORT_BYTES) throw new ImportError('Contact files are limited to 10 MB.', 413);
    const source = new Uint8Array(await file.arrayBuffer());
    const filename = file.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || `contacts.${format === 'csv' ? 'csv' : 'vcf'}`;
    const prefix = new TextEncoder().encode(`${format}\0${filename}\0`);
    const fingerprintBytes = new Uint8Array(prefix.length + source.length);
    fingerprintBytes.set(prefix); fingerprintBytes.set(source, prefix.length);
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', fingerprintBytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const existing = await db.prepare('SELECT id, fingerprint FROM contact_import_jobs WHERE workspace_id = ? AND request_key = ?').bind(workspaceId, requestKey).first<{ id: string; fingerprint: string }>();
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ImportError('This upload retry key belongs to a different file.', 409);
      return json(await view(db, workspaceId, existing.id));
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(source); } catch { throw new ImportError('The contact file must use UTF-8 text.'); }
    const createdAt = new Date().toISOString();
    let rows;
    try { rows = parseImportPreview(text, format, createdAt); } catch (error) { throw new ImportError(error instanceof Error ? error.message : 'The contact file could not be read.'); }
    const id = crypto.randomUUID();
    const statements = [db.prepare(`INSERT INTO contact_import_jobs(id, workspace_id, request_key, fingerprint, filename, format, total, source_bytes, state, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ? WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active' AND recovery_revision = ?)
      AND (SELECT COUNT(*) FROM contact_import_jobs WHERE workspace_id = ?) < ?
      AND COALESCE((SELECT SUM(source_bytes) FROM contact_import_jobs WHERE workspace_id = ?), 0) + ? <= ?
      ON CONFLICT(workspace_id, request_key) DO NOTHING`).bind(id, workspaceId, requestKey, fingerprint, filename, format, rows.length, source.length, createdAt, createdAt, workspaceId, workspace.recovery_revision, workspaceId, MAX_REPORTS, workspaceId, source.length, MAX_SOURCE_STORAGE)];
    let chunk: typeof rows = [];
    let bytes = 2;
    let totalBytes = 0;
    const flush = () => {
      if (!chunk.length) return;
      statements.push(db.prepare(`INSERT INTO contact_import_rows(workspace_id, job_id, ${rowColumns.join(', ')})
        SELECT ?, ?, ${rowColumns.map((column) => `json_extract(value, '$.${column}')`).join(', ')} FROM json_each(?)
        WHERE EXISTS (SELECT 1 FROM contact_import_jobs WHERE id = ? AND workspace_id = ?)`)
        .bind(workspaceId, id, JSON.stringify(chunk), id, workspaceId));
      chunk = []; bytes = 2;
    };
    for (const row of rows) {
      const size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
      totalBytes += size;
      if (size > SOURCE_CHUNK_BYTES || totalBytes > MAX_NORMALIZED_BYTES) throw new ImportError('This file expands beyond the safe preview size. Split it into smaller files.', 413);
      if (bytes + size > SOURCE_CHUNK_BYTES) flush();
      chunk.push(row); bytes += size;
    }
    flush();
    // Segmented source storage shares the transaction with its job and rows, so
    // retries, report removal, restore cancellation, and erasure cannot orphan files.
    for (let offset = 0, part = 0; offset < source.length; offset += SOURCE_CHUNK_BYTES, part++) {
      statements.push(db.prepare(`INSERT INTO contact_import_sources(workspace_id, job_id, part, data)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM contact_import_jobs WHERE id = ? AND workspace_id = ?)`)
        .bind(workspaceId, id, part, source.slice(offset, offset + SOURCE_CHUNK_BYTES), id, workspaceId));
    }
    if (statements.length > 40) throw new ImportError('Split this file into smaller files to prepare it safely.', 413);
    await db.batch(statements);
    const saved = await db.prepare('SELECT id, fingerprint FROM contact_import_jobs WHERE workspace_id = ? AND request_key = ?').bind(workspaceId, requestKey).first<{ id: string; fingerprint: string }>();
    if (!saved) throw new ImportError('The workspace changed during upload, or import storage is full (20 reports / 50 MB of source files). Refresh, remove old reports if needed, and retry.', 409);
    if (saved.fingerprint !== fingerprint) throw new ImportError('This upload retry key belongs to a different file.', 409);
    return json(await view(db, workspaceId, saved.id), 201);
  } catch (error) { return importFailure(error); }
}

async function prepare(db: DB, workspaceId: string, id: string) {
  await db.batch([
    db.prepare(`UPDATE contact_import_rows AS r SET state = CASE WHEN ${existingMatch} OR ${fileMatch} THEN 'review' ELSE 'ready' END,
      message = CASE WHEN ${existingMatch} THEN 'Possible match in your contacts. Review before importing.' WHEN ${fileMatch} THEN 'Possible match earlier in this file. Review before importing.' ELSE NULL END
      WHERE r.workspace_id = ? AND r.job_id = ? AND r.state = 'pending'
      AND r.row_number IN (SELECT row_number FROM contact_import_rows WHERE workspace_id = ? AND job_id = ? AND state = 'pending' ORDER BY row_number LIMIT 100)
      AND EXISTS (SELECT 1 FROM contact_import_jobs WHERE id = ? AND workspace_id = ? AND state = 'preparing')`)
      .bind(workspaceId, id, workspaceId, id, id, workspaceId),
    db.prepare(`UPDATE contact_import_jobs SET state = CASE WHEN EXISTS (SELECT 1 FROM contact_import_rows WHERE job_id = ? AND workspace_id = ? AND state = 'pending') THEN 'preparing' ELSE 'review' END,
      updated_at = ? WHERE id = ? AND workspace_id = ? AND state = 'preparing'`).bind(id, workspaceId, new Date().toISOString(), id, workspaceId),
  ]);
}

async function advance(db: DB, workspaceId: string, id: string) {
  const rows = await db.prepare("SELECT row_number FROM contact_import_rows WHERE workspace_id = ? AND job_id = ? AND state = 'ready' ORDER BY row_number LIMIT 10").bind(workspaceId, id).all<{ row_number: number }>();
  const statements = [];
  for (const row of rows.results as Array<{ row_number: number }>) {
    statements.push(db.prepare(`INSERT INTO contacts(workspace_id, ${contactColumns.join(', ')})
      SELECT r.workspace_id, ${contactColumns.map((column) => `json_extract(r.payload, '$.${column}')`).join(', ')} FROM contact_import_rows r
      WHERE r.workspace_id = ? AND r.job_id = ? AND r.row_number = ? AND r.state = 'ready'
      AND EXISTS (SELECT 1 FROM contact_import_jobs WHERE id = ? AND workspace_id = ? AND state = 'importing')
      AND (r.force_create = 1 OR NOT ${existingMatch})`).bind(workspaceId, id, row.row_number, id, workspaceId));
    statements.push(db.prepare(`UPDATE contact_import_rows SET state = CASE WHEN changes() = 1 THEN 'imported' ELSE 'review' END,
      contact_id = CASE WHEN changes() = 1 THEN last_insert_rowid() ELSE NULL END,
      message = CASE WHEN changes() = 1 THEN NULL ELSE 'A possible match appeared after preview. Review this row before continuing.' END
      WHERE workspace_id = ? AND job_id = ? AND row_number = ? AND state = 'ready'
      AND EXISTS (SELECT 1 FROM contact_import_jobs WHERE id = ? AND workspace_id = ? AND state = 'importing')`)
      .bind(workspaceId, id, row.row_number, id, workspaceId));
  }
  statements.push(db.prepare(`UPDATE contact_import_jobs SET state = CASE
    WHEN EXISTS (SELECT 1 FROM contact_import_rows WHERE job_id = ? AND workspace_id = ? AND state = 'ready') THEN 'importing'
    WHEN EXISTS (SELECT 1 FROM contact_import_rows WHERE job_id = ? AND workspace_id = ? AND state = 'review') THEN 'review' ELSE 'complete' END,
    updated_at = ? WHERE id = ? AND workspace_id = ? AND state = 'importing'`).bind(id, workspaceId, id, workspaceId, new Date().toISOString(), id, workspaceId));
  await db.batch(statements);
}

export async function handleCloudImportJobs(request: Request, workspaceId: string, id?: string, actionPath?: string) {
  const db = getCloudflareContext().env.DB;
  try {
    if (!id) {
      if (request.method !== 'GET') throw new ImportError('Method not allowed.', 405);
      const result = await db.prepare('SELECT id, filename, format, total, state, created_at FROM contact_import_jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20').bind(workspaceId).all();
      return json({ jobs: result.results });
    }
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ImportError('Import report not found.', 404);
    const job = await getJob(db, workspaceId, id);
    if (request.method === 'GET' && actionPath === 'source') {
      let part = 0;
      const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
        try {
          const row = await db.prepare('SELECT data FROM contact_import_sources WHERE workspace_id = ? AND job_id = ? AND part = ?').bind(workspaceId, id, part++).first<{ data: number[] | ArrayBuffer }>();
          if (!row) { if ((part - 1) * SOURCE_CHUNK_BYTES < job.source_bytes) throw new Error('Original file is unavailable.'); controller.close(); }
          else controller.enqueue(new Uint8Array(row.data));
        } catch (error) { controller.error(error); }
      } });
      return new Response(stream, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="original-contacts.${job.format === 'csv' ? 'csv' : 'vcf'}"`, 'Content-Length': String(job.source_bytes), 'Cache-Control': 'no-store' } });
    }
    if (actionPath) throw new ImportError('Import endpoint not found.', 404);
    if (request.method === 'GET') return json(await view(db, workspaceId, id, new URL(request.url)));
    if (request.method === 'DELETE') {
      await db.prepare('DELETE FROM contact_import_jobs WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).run();
      return json({ success: true });
    }
    if (request.method !== 'POST') throw new ImportError('Method not allowed.', 405);
    const body = await readCloudObject(request);
    if (body.action === 'prepare') await prepare(db, workspaceId, id);
    else if (body.action === 'advance') await advance(db, workspaceId, id);
    else if (body.action === 'cancel') await db.prepare("UPDATE contact_import_jobs SET state = 'cancelled', updated_at = ? WHERE workspace_id = ? AND id = ? AND state <> 'complete'").bind(new Date().toISOString(), workspaceId, id).run();
    else if (body.action === 'confirm') {
      if (body.confirm !== true) throw new ImportError('Confirm the selected contacts before importing.');
      await db.prepare(`UPDATE contact_import_jobs SET state = 'importing', updated_at = ? WHERE workspace_id = ? AND id = ? AND state = 'review'
        AND NOT EXISTS (SELECT 1 FROM contact_import_rows WHERE workspace_id = ? AND job_id = ? AND state IN ('pending', 'review'))`)
        .bind(new Date().toISOString(), workspaceId, id, workspaceId, id).run();
      const state = (await getJob(db, workspaceId, id)).state;
      if (state === 'review') throw new ImportError('Resolve possible duplicates before importing.', 409);
      if (state !== 'importing' && state !== 'complete') throw new ImportError('This import cannot start in its current state. Refresh the report.', 409);
    } else if (body.action === 'decide' || body.action === 'skip-matches') {
      if (job.state !== 'review') throw new ImportError('This import is not ready for review.', 409);
      if (body.action === 'skip-matches') {
        await db.prepare(`UPDATE contact_import_rows SET state = 'skipped', message = 'Skipped by you.' WHERE workspace_id = ? AND job_id = ? AND state = 'review'
          AND EXISTS (SELECT 1 FROM contact_import_jobs WHERE workspace_id = ? AND id = ? AND state = 'review')`).bind(workspaceId, id, workspaceId, id).run();
      } else {
        if (!Number.isInteger(body.rowNumber) || Number(body.rowNumber) < 1 || !['create', 'skip'].includes(String(body.decision))) throw new ImportError('Choose a valid row and decision.');
        await db.prepare(`UPDATE contact_import_rows SET state = ?, force_create = ?, message = ? WHERE workspace_id = ? AND job_id = ? AND row_number = ? AND state IN ('ready', 'review', 'skipped')
          AND EXISTS (SELECT 1 FROM contact_import_jobs WHERE workspace_id = ? AND id = ? AND state = 'review')`)
          .bind(body.decision === 'create' ? 'ready' : 'skipped', body.decision === 'create' ? 1 : 0, body.decision === 'create' ? 'Import as a separate contact, chosen by you.' : 'Skipped by you.', workspaceId, id, body.rowNumber, workspaceId, id).run();
      }
    } else throw new ImportError('Unknown import action.');
    return json(await view(db, workspaceId, id, new URL(request.url)));
  } catch (error) { return importFailure(error); }
}

function importFailure(error: unknown) {
  if (error instanceof ImportError || error instanceof RequestBodyError || error instanceof IdempotencyError) return json({ error: error.message }, error.status);
  const recovery = recoveryErrorResponse(error);
  if (recovery) return recovery;
  console.error('cloud.import.failed', error);
  return json({ error: 'Import progress could not be saved. Refresh this report and resume; committed rows will not be imported again.' }, 503);
}
