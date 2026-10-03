import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { Contact } from '@/lib/db';
import { CONTACT_CSV_HEADERS, serializeContactToCSVRow } from '@/lib/contact-export';
import { serializeContactToVCard } from '@/lib/vcard';
import { IdempotencyError, requireIdempotencyKey } from '@/lib/idempotency';
import { readCloudObject } from '@/lib/cloud/request';
import { RequestBodyError } from '@/lib/request-body';
import { appendExportBatch, completeExportUpload, MAX_EXPORT_BATCH_BYTES, type ExportPart } from '@/lib/cloud/export-assembly';

type DB = CloudflareEnv['DB'];
type Bucket = CloudflareEnv['PRIVATE_ASSETS'];
type Format = 'csv' | 'vcard';
type Job = {
  id: string; workspace_id: string; request_key: string; format: Format; state: string;
  revision: number; total: number; max_id: number; exported: number; cursor_id: number;
  upload_id: string | null; part_etags: string; scratch_size: number;
  lease_token: string | null; lease_until: string | null;
  created_at: string; updated_at: string; expires_at: string;
};

class ExportError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const PAGE_SIZE = 25;
const MAX_JOBS = 3;
const CLEANUP_BATCH_SIZE = 10;
const EXPIRY_MS = 6 * 24 * 60 * 60 * 1000;
const LEASE_MS = 10 * 60 * 1000;
const encoder = new TextEncoder();

function objectKey(job: Job): string {
  return `${job.workspace_id}/exports/${job.id}/contacts.${job.format === 'csv' ? 'csv' : 'vcf'}`;
}

function scratchKey(job: Job, cursorId: number): string {
  return `${job.workspace_id}/exports/${job.id}/scratch-${cursorId}`;
}

function publicJob(job: Job) {
  return {
    id: job.id, format: job.format, state: job.state, total: job.total,
    exported: job.exported, createdAt: job.created_at, updatedAt: job.updated_at,
    expiresAt: job.expires_at,
  };
}

async function getJob(db: DB, workspaceId: string, id: string): Promise<Job> {
  const job = await db.prepare('SELECT * FROM contact_export_jobs WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, id).first<Job>();
  if (!job) throw new ExportError('Export job not found.', 404);
  return job;
}

async function stableRevision(db: DB, job: Job): Promise<boolean> {
  const workspace = await db.prepare("SELECT recovery_revision FROM workspaces WHERE id = ? AND lifecycle = 'active'")
    .bind(job.workspace_id).first<{ recovery_revision: number }>();
  return workspace?.recovery_revision === job.revision;
}

async function createJob(request: Request, workspaceId: string, db: DB): Promise<Response> {
  const key = requireIdempotencyKey(request.headers);
  const body = await readCloudObject(request);
  const format = body.format;
  if (format !== 'csv' && format !== 'vcard') throw new ExportError('Choose CSV or vCard.');
  const existing = await db.prepare('SELECT * FROM contact_export_jobs WHERE workspace_id = ? AND request_key = ?')
    .bind(workspaceId, key).first<Job>();
  if (existing) {
    if (existing.format !== format) throw new ExportError('This retry key belongs to a different export format.', 409);
    return Response.json({ job: publicJob(existing) });
  }
  const snapshot = await db.prepare(`SELECT recovery_revision AS revision,
    (SELECT COUNT(*) FROM contacts WHERE workspace_id = w.id) AS total,
    COALESCE((SELECT MAX(id) FROM contacts WHERE workspace_id = w.id), 0) AS max_id
    FROM workspaces w WHERE id = ? AND lifecycle = 'active'`).bind(workspaceId)
    .first<{ revision: number; total: number; max_id: number }>();
  if (!snapshot) throw new ExportError('Workspace erasure is in progress.', 409);
  if (!snapshot.total) throw new ExportError('Add a contact before creating an export.');
  const now = new Date();
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO contact_export_jobs
    (id, workspace_id, request_key, format, revision, total, max_id, created_at, updated_at, expires_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active' AND recovery_revision = ?)
    AND (SELECT COUNT(*) FROM contact_export_jobs WHERE workspace_id = ?) < ?
    ON CONFLICT(workspace_id, request_key) DO NOTHING`)
    .bind(id, workspaceId, key, format, snapshot.revision, snapshot.total, snapshot.max_id,
      now.toISOString(), now.toISOString(), new Date(now.getTime() + EXPIRY_MS).toISOString(),
      workspaceId, snapshot.revision, workspaceId, MAX_JOBS).run();
  const saved = await db.prepare('SELECT * FROM contact_export_jobs WHERE workspace_id = ? AND request_key = ?')
    .bind(workspaceId, key).first<Job>();
  if (!saved) throw new ExportError('The workspace changed, or three export jobs already exist. Refresh, remove an old job, and retry.', 409);
  if (saved.format !== format) throw new ExportError('This retry key belongs to a different export format.', 409);
  return Response.json({ job: publicJob(saved) }, { status: saved.id === id ? 201 : 200 });
}

async function claimJob(db: DB, job: Job): Promise<{ job: Job; token: string }> {
  if (job.state === 'complete') return { job, token: '' };
  if (job.state !== 'running' && job.state !== 'finalizing') throw new ExportError('This export cannot be advanced.', 409);
  const now = new Date();
  if (job.expires_at <= now.toISOString()) throw new ExportError('This export expired. Remove it and start a new one.', 409);
  const token = crypto.randomUUID();
  const claim = await db.prepare(`UPDATE contact_export_jobs SET lease_token = ?, lease_until = ?
    WHERE workspace_id = ? AND id = ? AND state IN ('running', 'finalizing')
    AND (lease_token IS NULL OR lease_until < ?)
    AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active' AND recovery_revision = contact_export_jobs.revision)`)
    .bind(token, new Date(now.getTime() + LEASE_MS).toISOString(), job.workspace_id, job.id,
      now.toISOString(), job.workspace_id).run();
  if (claim.meta.changes !== 1) {
    if (!(await stableRevision(db, job))) {
      await db.prepare("UPDATE contact_export_jobs SET state = 'invalid' WHERE workspace_id = ? AND id = ? AND lease_token IS NULL AND state IN ('running', 'finalizing')")
        .bind(job.workspace_id, job.id).run();
      throw new ExportError('Workspace changed while this export was being prepared. Start a new export.', 409);
    }
    throw new ExportError('Another export request is running. Refresh or retry in a moment.', 409);
  }
  return { job: await getJob(db, job.workspace_id, job.id), token };
}

function serializeBatch(job: Job, contacts: Contact[], final: boolean): Uint8Array {
  if (job.format === 'csv') {
    const rows = contacts.map(serializeContactToCSVRow).join('\n');
    return encoder.encode(`${job.exported === 0 ? `${CONTACT_CSV_HEADERS.join(',')}\n` : '\n'}${rows}`);
  }
  const rows = contacts.map(serializeContactToVCard).join('\r\n');
  return encoder.encode(`${job.exported ? '\r\n' : ''}${rows}${final ? '\r\n' : ''}`);
}

async function advanceJob(db: DB, bucket: Bucket, original: Job): Promise<Response> {
  const { job, token } = await claimJob(db, original);
  if (!token) return Response.json({ job: publicJob(job) });
  const key = objectKey(job);
  try {
    let uploadId = job.upload_id;
    if (!uploadId) {
      const upload = await bucket.createMultipartUpload(key);
      const saved = await db.prepare('UPDATE contact_export_jobs SET upload_id = ? WHERE workspace_id = ? AND id = ? AND lease_token = ? AND upload_id IS NULL')
        .bind(upload.uploadId, job.workspace_id, job.id, token).run();
      if (saved.meta.changes !== 1) {
        await upload.abort();
        throw new ExportError('Export state changed. Refresh and retry.', 409);
      }
      uploadId = upload.uploadId;
    }
    if (!uploadId) throw new ExportError('Export storage could not be initialized.', 503);
    if (job.state === 'finalizing') {
      const existing = await bucket.head(key);
      if (!existing) {
        await completeExportUpload(bucket, {
          key, uploadId, parts: JSON.parse(job.part_etags) as ExportPart[],
          scratchKey: job.scratch_size ? scratchKey(job, job.cursor_id) : null,
          scratchSize: job.scratch_size,
        });
      }
      const completed = await db.prepare(`UPDATE contact_export_jobs SET state = 'complete', lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND lease_token = ? AND state = 'finalizing'
        AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active' AND recovery_revision = contact_export_jobs.revision)`)
        .bind(new Date().toISOString(), job.workspace_id, job.id, token, job.workspace_id).run();
      if (completed.meta.changes !== 1) throw new ExportError('Workspace changed during export finalization. This file is not available.', 409);
      if (job.scratch_size) await bucket.delete(scratchKey(job, job.cursor_id));
      return Response.json({ job: publicJob(await getJob(db, job.workspace_id, job.id)) });
    }
    const rows = await db.prepare(`SELECT id, name, nickname, email, phone, photo_url, birthday,
      birthday_reminder_days, how_we_met, tags, notes, gift_ideas, custom_fields,
      last_contacted, contact_frequency, created_at, updated_at
      FROM contacts WHERE workspace_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT ?`)
      .bind(job.workspace_id, job.cursor_id, job.max_id, PAGE_SIZE).all<Contact>();
    let contacts = rows.results;
    if (!contacts.length || contacts.length > job.total - job.exported) {
      throw new ExportError('Workspace changed during export. Start a new export.', 409);
    }
    let final = job.exported + contacts.length === job.total;
    let bytes = serializeBatch(job, contacts, final);
    while (bytes.byteLength > MAX_EXPORT_BATCH_BYTES && contacts.length > 1) {
      contacts = contacts.slice(0, Math.ceil(contacts.length / 2));
      final = job.exported + contacts.length === job.total;
      bytes = serializeBatch(job, contacts, final);
    }
    if (bytes.byteLength > MAX_EXPORT_BATCH_BYTES) throw new ExportError('A contact is too large to export safely. Review its photo and notes.', 413);
    const nextCursor = contacts.at(-1)!.id;
    const nextExported = job.exported + contacts.length;
    const assembled = await appendExportBatch(bucket, {
      key, uploadId, parts: JSON.parse(job.part_etags) as ExportPart[],
      scratchKey: job.scratch_size ? scratchKey(job, job.cursor_id) : null,
      scratchSize: job.scratch_size,
      nextScratchKey: scratchKey(job, nextCursor),
      bytes,
    });
    const updated = await db.prepare(`UPDATE contact_export_jobs SET exported = ?, cursor_id = ?, part_etags = ?, scratch_size = ?,
      state = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND lease_token = ? AND cursor_id = ? AND state = 'running'
      AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active' AND recovery_revision = contact_export_jobs.revision)`)
      .bind(nextExported, nextCursor, JSON.stringify(assembled.parts), assembled.scratchSize,
        final ? 'finalizing' : 'running', new Date().toISOString(), job.workspace_id, job.id,
        token, job.cursor_id, job.workspace_id).run();
    if (updated.meta.changes !== 1) throw new ExportError('Workspace changed while exporting. This batch was not saved.', 409);
    if (job.scratch_size) {
      try { await bucket.delete(scratchKey(job, job.cursor_id)); }
      catch (error) { console.error('cloud.export.scratch_cleanup_failed', error); }
    }
    return Response.json({ job: publicJob(await getJob(db, job.workspace_id, job.id)) });
  } catch (error) {
    if (error instanceof ExportError && !(await stableRevision(db, job))) {
      await db.prepare("UPDATE contact_export_jobs SET state = 'invalid' WHERE workspace_id = ? AND id = ? AND lease_token = ?")
        .bind(job.workspace_id, job.id, token).run();
      if (await bucket.head(key)) await bucket.delete(key);
    }
    throw error;
  } finally {
    await db.prepare('UPDATE contact_export_jobs SET lease_token = NULL, lease_until = NULL WHERE workspace_id = ? AND id = ? AND lease_token = ?')
      .bind(job.workspace_id, job.id, token).run();
  }
}

async function removeJob(db: DB, bucket: Bucket, job: Job): Promise<boolean> {
  if (job.state !== 'deleting') {
    const marked = await db.prepare(`UPDATE contact_export_jobs
      SET state = 'deleting', lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND (lease_token IS NULL OR lease_until < ?)`)
      .bind(new Date().toISOString(), job.workspace_id, job.id, new Date().toISOString()).run();
    if (marked.meta.changes !== 1) throw new ExportError('An export request is still running. Retry removal when it finishes.', 409);
  }
  const key = objectKey(job);
  if (job.upload_id) {
    if (!(await bucket.head(key))) await bucket.resumeMultipartUpload(key, job.upload_id).abort();
    await db.prepare("UPDATE contact_export_jobs SET upload_id = NULL WHERE workspace_id = ? AND id = ? AND state = 'deleting'")
      .bind(job.workspace_id, job.id).run();
  }
  const prefix = `${job.workspace_id}/exports/${job.id}/`;
  const objects = await bucket.list({ prefix, limit: 100 });
  if (objects.objects.length) await bucket.delete(objects.objects.map((object: { key: string }) => object.key));
  const remaining = await bucket.list({ prefix, limit: 1 });
  if (remaining.objects.length) return false;
  await db.prepare("DELETE FROM contact_export_jobs WHERE workspace_id = ? AND id = ? AND state = 'deleting'")
    .bind(job.workspace_id, job.id).run();
  return true;
}

export async function cleanupWorkspaceExportJobs(workspaceId: string): Promise<boolean> {
  const { DB, PRIVATE_ASSETS } = getCloudflareContext().env;
  const result = await DB.prepare('SELECT * FROM contact_export_jobs WHERE workspace_id = ? ORDER BY created_at LIMIT 3')
    .bind(workspaceId).all<Job>();
  for (const job of result.results) {
    if (!(await removeJob(DB, PRIVATE_ASSETS, job))) return false;
  }
  const remaining = await DB.prepare('SELECT id FROM contact_export_jobs WHERE workspace_id = ? LIMIT 1')
    .bind(workspaceId).first<{ id: string }>();
  return !remaining;
}

export async function cleanupExpiredExportJobs(
  db: DB,
  bucket: Bucket,
  now = new Date()
): Promise<{ attempted: number; removed: number; pending: number; failed: number }> {
  const cutoff = now.toISOString();
  const result = await db.prepare(`SELECT * FROM contact_export_jobs
    WHERE (expires_at <= ? OR state = 'deleting')
    AND (lease_token IS NULL OR lease_until < ?)
    ORDER BY updated_at, id LIMIT ?`)
    .bind(cutoff, cutoff, CLEANUP_BATCH_SIZE).all<Job>();
  let removed = 0;
  let pending = 0;
  let failed = 0;
  for (const job of result.results) {
    try {
      if (await removeJob(db, bucket, job)) removed++;
      else pending++;
    } catch (error) {
      failed++;
      console.error('cloud.export.retention_cleanup_failed', { jobId: job.id }, error);
      try {
        await db.prepare('UPDATE contact_export_jobs SET updated_at = ? WHERE workspace_id = ? AND id = ?')
          .bind(new Date().toISOString(), job.workspace_id, job.id).run();
      } catch (updateError) {
        console.error('cloud.export.retention_retry_timestamp_failed', { jobId: job.id }, updateError);
      }
    }
  }
  return { attempted: result.results.length, removed, pending, failed };
}

export async function handleCloudExportJobs(request: Request, workspaceId: string, id?: string, action?: string): Promise<Response> {
  const { DB, PRIVATE_ASSETS } = getCloudflareContext().env;
  try {
    if (!id) {
      if (request.method === 'POST') return await createJob(request, workspaceId, DB);
      if (request.method !== 'GET') throw new ExportError('Method not allowed.', 405);
      const result = await DB.prepare('SELECT * FROM contact_export_jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 3')
        .bind(workspaceId).all<Job>();
      return Response.json({ jobs: result.results.map(publicJob) });
    }
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ExportError('Export job not found.', 404);
    const job = await getJob(DB, workspaceId, id);
    if (action === 'download' && request.method === 'GET') {
      if (job.state !== 'complete' || job.expires_at <= new Date().toISOString()) throw new ExportError('This export is not ready to download.', 409);
      const object = await PRIVATE_ASSETS.get(objectKey(job));
      if (!object) throw new ExportError('The export file is unavailable. Start a new export.', 503);
      const date = job.created_at.slice(0, 10);
      return new Response(object.body, { headers: {
        'Content-Type': job.format === 'csv' ? 'text/csv; charset=utf-8' : 'text/vcard; charset=utf-8',
        'Content-Disposition': `attachment; filename="everclose-contacts-${date}.${job.format === 'csv' ? 'csv' : 'vcf'}"`,
        'Content-Length': String(object.size), 'Cache-Control': 'no-store',
      } });
    }
    if (action) throw new ExportError('Export endpoint not found.', 404);
    if (request.method === 'GET') return Response.json({ job: publicJob(job) });
    if (request.method === 'POST') return await advanceJob(DB, PRIVATE_ASSETS, job);
    if (request.method === 'DELETE') {
      const complete = await removeJob(DB, PRIVATE_ASSETS, job);
      return Response.json({ complete }, { status: complete ? 200 : 202 });
    }
    throw new ExportError('Method not allowed.', 405);
  } catch (error) {
    if (error instanceof ExportError || error instanceof IdempotencyError || error instanceof RequestBodyError) return Response.json({ error: error.message }, { status: error.status });
    console.error('cloud.export.failed', error);
    return Response.json({ error: 'Export progress could not be confirmed. Refresh the job and retry; saved batches will not be repeated.' }, { status: 503 });
  }
}
