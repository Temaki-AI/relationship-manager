import { backupChecksum, maintenanceGuard, removeGuard } from '@/lib/cloud/recovery-storage';
import { CloudRecoveryError, SNAPSHOT_TABLES, snapshotColumns, type SnapshotRow, type SnapshotTable } from '@/lib/cloud/recovery-contract';
import { type SnapshotCaptureJob } from '@/lib/cloud/snapshot-capture';
import { MANIFEST_PART_CHUNKS, SnapshotArtifactError, readPrivateSnapshotChunk,
  snapshotManifestKey, snapshotManifestPartKey, type SnapshotChunkDescriptor } from '@/lib/cloud/snapshot-artifact';

type DB = CloudflareEnv['DB'];
type Assets = CloudflareEnv['PRIVATE_ASSETS'];
type ManifestEnv = { DB: DB; PRIVATE_ASSETS: Assets };
type Chunk = SnapshotChunkDescriptor;

const LEASE_MS = 5 * 60_000;
const encoder = new TextEncoder();

class CaptureIntegrityError extends CloudRecoveryError {
  constructor(message: string) { super(message, 409); }
}

function guard(db: DB, job: SnapshotCaptureJob, token: string, suffix: string) {
  return maintenanceGuard(db, `${token}-${suffix}`, `EXISTS (
    SELECT 1 FROM cloud_snapshot_capture_jobs job JOIN workspaces workspace ON workspace.id = job.workspace_id
    WHERE job.id = ? AND job.workspace_id = ? AND job.state = 'awaiting_verification'
      AND job.revision = ? AND job.lease_token = ? AND job.verify_index = ?
      AND job.chunk_count = ? AND job.manifest_part_count = ? AND job.manifest_chain = ?
      AND workspace.lifecycle = 'active' AND workspace.recovery_revision = job.revision
  )`, [job.id, job.workspace_id, job.revision, token, job.verify_index,
    job.chunk_count, job.manifest_part_count, job.manifest_chain]);
}

async function getJob(db: DB, workspaceId: string, jobId: string): Promise<SnapshotCaptureJob> {
  const job = await db.prepare('SELECT * FROM cloud_snapshot_capture_jobs WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, jobId).first<SnapshotCaptureJob>();
  if (!job) throw new CloudRecoveryError('Capture job not found.', 404);
  return job;
}

async function verifySourceRows(db: DB, job: SnapshotCaptureJob, table: SnapshotTable, rows: SnapshotRow[]) {
  const source = table === 'contact_group_members'
    ? (await db.prepare(`SELECT * FROM contact_group_members WHERE workspace_id = ? AND
        (${rows.map(() => '(contact_id = ? AND group_id = ?)').join(' OR ')})
        ORDER BY contact_id, group_id`)
      .bind(job.workspace_id, ...rows.flatMap((row) => [row.contact_id, row.group_id])).all<SnapshotRow>()).results
    : (await db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? AND id IN (${rows.map(() => '?').join(', ')})
        ORDER BY id`).bind(job.workspace_id, ...rows.map((row) => row.id)).all<SnapshotRow>()).results;
  const columns = snapshotColumns(table);
  if (source.length !== rows.length || rows.some((row, index) => columns.some((column) =>
    source[index][column.name] !== row[column.name]))) {
    throw new CaptureIntegrityError('Capture rows no longer match the source workspace.');
  }
}

async function verifyChunk(job: SnapshotCaptureJob, env: ManifestEnv): Promise<void> {
  const { DB, PRIVATE_ASSETS } = env;
  const chunk = await DB.prepare(`SELECT sequence, table_name, cursor_key, row_count, byte_length, sha256
    FROM cloud_snapshot_capture_chunks WHERE job_id = ? AND workspace_id = ? AND sequence = ?`)
    .bind(job.id, job.workspace_id, job.verify_index).first<Chunk>();
  if (!chunk || chunk.sequence !== job.verify_index) throw new CaptureIntegrityError('Capture chunk metadata is incomplete.');
  const previous = job.verify_index > 0
    ? await DB.prepare(`SELECT table_name, cursor_key FROM cloud_snapshot_capture_chunks
        WHERE job_id = ? AND workspace_id = ? AND sequence = ?`)
      .bind(job.id, job.workspace_id, job.verify_index - 1).first<Pick<Chunk, 'table_name' | 'cursor_key'>>()
    : null;
  if (job.verify_index > 0 && !previous) throw new CaptureIntegrityError('Capture chunk sequence has a gap.');
  const previousIndex = previous ? SNAPSHOT_TABLES.indexOf(previous.table_name) : -1;
  if (previous && previousIndex < 0) throw new CaptureIntegrityError('Capture references an unsupported table.');
  const { rows } = await readPrivateSnapshotChunk(
    { workspaceId: job.workspace_id, jobId: job.id, revision: job.revision }, chunk,
    { tableIndex: previousIndex, cursorKey: previous?.cursor_key || '' }, PRIVATE_ASSETS);
  await verifySourceRows(DB, job, chunk.table_name, rows);
}

async function writeManifestPart(job: SnapshotCaptureJob, nextIndex: number, env: ManifestEnv) {
  const start = job.manifest_part_count * MANIFEST_PART_CHUNKS;
  const expected = nextIndex - start;
  const rows = (await env.DB.prepare(`SELECT sequence, table_name, cursor_key, row_count, byte_length, sha256
    FROM cloud_snapshot_capture_chunks WHERE job_id = ? AND workspace_id = ? AND sequence >= ? AND sequence < ?
    ORDER BY sequence LIMIT ?`).bind(job.id, job.workspace_id, start, nextIndex, MANIFEST_PART_CHUNKS).all<Chunk>()).results as Chunk[];
  if (expected < 1 || expected > MANIFEST_PART_CHUNKS || rows.length !== expected
    || rows.some((row, index) => row.sequence !== start + index)) throw new CaptureIntegrityError('Manifest part is missing capture chunks.');
  const bytes = encoder.encode(JSON.stringify({ format: 'everclose-cloud-manifest-part', version: 1,
    workspaceId: job.workspace_id, jobId: job.id, revision: job.revision,
    index: job.manifest_part_count, chunks: rows }));
  if (bytes.byteLength > 32_000) throw new CaptureIntegrityError('Manifest part exceeded its size bound.');
  const sha256 = await backupChecksum(bytes);
  const key = snapshotManifestPartKey(job.workspace_id, job.id, job.manifest_part_count);
  await env.PRIVATE_ASSETS.put(key, bytes, { customMetadata: { sha256, workspaceId: job.workspace_id, jobId: job.id } });
  const object = await env.PRIVATE_ASSETS.get(key);
  if (!object || object.size !== bytes.byteLength || await backupChecksum(new Uint8Array(await object.arrayBuffer())) !== sha256) {
    throw new CloudRecoveryError('Manifest part could not be verified. Retry.', 503);
  }
  return await backupChecksum(encoder.encode(`${job.manifest_chain}:${sha256}`));
}

async function verifySourceGraph(job: SnapshotCaptureJob, db: DB, token: string) {
  const workspaceId = job.workspace_id;
  const contactTables = SNAPSHOT_TABLES.filter((table) => snapshotColumns(table).some((column) => column.name === 'contact_id'));
  const referenceChecks = [
    ...contactTables.map((table) => `SELECT 1 AS invalid FROM ${table} item LEFT JOIN contacts target
      ON target.id = item.contact_id AND target.workspace_id = item.workspace_id
      WHERE item.workspace_id = ? AND target.id IS NULL LIMIT 1`),
    `SELECT 1 AS invalid FROM contact_group_members item LEFT JOIN contact_groups target
      ON target.id = item.group_id AND target.workspace_id = item.workspace_id
      WHERE item.workspace_id = ? AND target.id IS NULL LIMIT 1`,
    `SELECT 1 AS invalid FROM contact_relationships item LEFT JOIN contacts target
      ON target.id = item.related_contact_id AND target.workspace_id = item.workspace_id
      WHERE item.workspace_id = ? AND (target.id IS NULL OR item.contact_id = item.related_contact_id) LIMIT 1`,
    `SELECT 1 AS invalid FROM contact_relationships WHERE workspace_id = ?
      GROUP BY MIN(contact_id, related_contact_id), MAX(contact_id, related_contact_id)
      HAVING COUNT(*) > 1 LIMIT 1`,
    `SELECT 1 AS invalid FROM contact_children item LEFT JOIN contacts target
      ON target.id = item.linked_contact_id AND target.workspace_id = item.workspace_id
      WHERE item.workspace_id = ? AND item.linked_contact_id IS NOT NULL
        AND (target.id IS NULL OR item.contact_id = item.linked_contact_id) LIMIT 1`,
    `SELECT 1 AS invalid FROM daily_snoozes item LEFT JOIN reminders target
      ON target.id = item.reminder_id AND target.workspace_id = item.workspace_id
      WHERE item.workspace_id = ? AND item.reminder_id IS NOT NULL
        AND (target.id IS NULL OR target.contact_id <> item.contact_id) LIMIT 1`,
  ];
  const results = await db.batch([
    guard(db, job, token, 'source'),
    db.prepare('SELECT name, persona FROM workspaces WHERE id = ?').bind(workspaceId),
    ...SNAPSHOT_TABLES.map((table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`).bind(workspaceId)),
    db.prepare(`SELECT COUNT(*) AS count FROM cloud_snapshot_capture_chunks WHERE workspace_id = ? AND job_id = ?`)
      .bind(workspaceId, job.id),
    db.prepare(`SELECT table_name, SUM(row_count) AS count FROM cloud_snapshot_capture_chunks
      WHERE workspace_id = ? AND job_id = ? GROUP BY table_name`).bind(workspaceId, job.id),
    ...referenceChecks.map((sql) => db.prepare(sql).bind(workspaceId)),
    removeGuard(db, `${token}-source`),
  ]);
  const workspace = results[1].results[0] as { name: string; persona: string | null } | undefined;
  if (!workspace?.name?.trim()) throw new CaptureIntegrityError('Workspace metadata is incomplete.');
  let expected: Record<string, number>;
  try { expected = JSON.parse(job.row_counts) as Record<string, number>; }
  catch { throw new CaptureIntegrityError('Capture count metadata is malformed.'); }
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new CaptureIntegrityError('Capture count metadata is malformed.');
  }
  const rowCounts = {} as Record<SnapshotTable, number>;
  for (const [index, table] of SNAPSHOT_TABLES.entries()) {
    const actual = Number((results[2 + index].results[0] as { count: number }).count);
    if (!Number.isSafeInteger(actual) || actual !== (expected[table] || 0)) throw new CaptureIntegrityError('Capture row counts do not match the source.');
    rowCounts[table] = actual;
  }
  const statsOffset = 2 + SNAPSHOT_TABLES.length;
  if (Number((results[statsOffset].results[0] as { count: number }).count) !== job.chunk_count) {
    throw new CaptureIntegrityError('Capture chunk count does not match.');
  }
  const chunkCounts = results[statsOffset + 1].results as Array<{ table_name: string; count: number }>;
  if (chunkCounts.some((row) => !SNAPSHOT_TABLES.includes(row.table_name as SnapshotTable)
    || row.count !== rowCounts[row.table_name as SnapshotTable])) throw new CaptureIntegrityError('Capture chunk counts do not match.');
  if (results.slice(statsOffset + 2, -1).some((result: { results: unknown[] }) => result.results.length > 0)) {
    throw new CaptureIntegrityError('Capture source contains broken references.');
  }
  return { workspace, rowCounts };
}

export async function advanceCloudSnapshotVerification(workspaceId: string, jobId: string, env: ManifestEnv): Promise<SnapshotCaptureJob> {
  const { DB, PRIVATE_ASSETS } = env;
  const now = new Date();
  const token = crypto.randomUUID();
  const job = await DB.prepare(`UPDATE cloud_snapshot_capture_jobs
    SET lease_token = ?, lease_until = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ? AND state = 'awaiting_verification'
      AND (lease_token IS NULL OR lease_until < ?)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active'
        AND recovery_revision = cloud_snapshot_capture_jobs.revision)
    RETURNING *`).bind(token, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString(),
    workspaceId, jobId, now.toISOString(), workspaceId).first<SnapshotCaptureJob>();
  if (!job) {
    const current = await getJob(DB, workspaceId, jobId);
    if (current.state === 'manifest_ready') return current;
    const workspace = await DB.prepare('SELECT recovery_revision, lifecycle FROM workspaces WHERE id = ?')
      .bind(workspaceId).first<{ recovery_revision: number; lifecycle: string }>();
    if (workspace?.recovery_revision !== current.revision || workspace.lifecycle !== 'active') {
      await DB.prepare(`UPDATE cloud_snapshot_capture_jobs SET state = 'invalid', updated_at = ?
        WHERE workspace_id = ? AND id = ? AND state = 'awaiting_verification'
          AND (lease_token IS NULL OR lease_until < ?)`)
        .bind(now.toISOString(), workspaceId, jobId, now.toISOString()).run();
      throw new CloudRecoveryError('Workspace changed during verification. Start a new capture.', 409);
    }
    if (current.state === 'invalid') throw new CloudRecoveryError('This capture is invalid. Start a new job.', 409);
    if (current.state === 'capturing') throw new CloudRecoveryError('Capture must finish before verification.', 409);
    throw new CloudRecoveryError('Another verification request is running. Retry shortly.', 409);
  }
  let rootKey: string | null = null;
  let rootHash: string | null = null;
  try {
    if (job.verify_index < job.chunk_count) {
      await verifyChunk(job, env);
      const nextIndex = job.verify_index + 1;
      const writePart = nextIndex % MANIFEST_PART_CHUNKS === 0 || nextIndex === job.chunk_count;
      const nextChain = writePart ? await writeManifestPart(job, nextIndex, env) : job.manifest_chain;
      await DB.batch([
        guard(DB, job, token, 'advance'),
        DB.prepare(`UPDATE cloud_snapshot_capture_jobs SET verify_index = ?, manifest_part_count = ?,
          manifest_chain = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND lease_token = ?`)
          .bind(nextIndex, job.manifest_part_count + Number(writePart), nextChain,
            new Date().toISOString(), workspaceId, jobId, token),
        removeGuard(DB, `${token}-advance`),
      ]);
      return getJob(DB, workspaceId, jobId);
    }
    if (job.verify_index !== job.chunk_count || job.manifest_part_count !== Math.ceil(job.chunk_count / MANIFEST_PART_CHUNKS)) {
      throw new CaptureIntegrityError('Capture verification progress is inconsistent.');
    }
    const { workspace, rowCounts } = await verifySourceGraph(job, DB, token);
    const manifest = { format: 'everclose-cloud-manifest', version: 1, snapshotSchemaVersion: 4,
      workspaceId, jobId, revision: job.revision, createdAt: new Date().toISOString(), workspace,
      tableOrder: SNAPSHOT_TABLES, rowCounts, chunkCount: job.chunk_count,
      partCount: job.manifest_part_count, partsChainSha256: job.manifest_chain };
    const bytes = encoder.encode(JSON.stringify(manifest));
    const sha256 = await backupChecksum(bytes);
    const key = snapshotManifestKey(workspaceId, jobId, sha256);
    rootKey = key;
    rootHash = sha256;
    await PRIVATE_ASSETS.put(key, bytes, { customMetadata: { sha256, workspaceId, jobId } });
    const object = await PRIVATE_ASSETS.get(key);
    if (!object || object.size !== bytes.byteLength || await backupChecksum(new Uint8Array(await object.arrayBuffer())) !== sha256) {
      throw new CloudRecoveryError('Manifest could not be verified. Retry.', 503);
    }
    await DB.batch([
      guard(DB, job, token, 'publish'),
      DB.prepare(`UPDATE cloud_snapshot_capture_jobs SET state = 'manifest_ready', manifest_sha256 = ?,
        manifest_bytes = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND lease_token = ?`)
        .bind(sha256, bytes.byteLength, new Date().toISOString(), workspaceId, jobId, token),
      removeGuard(DB, `${token}-publish`),
    ]);
    return getJob(DB, workspaceId, jobId);
  } catch (error) {
    if (rootKey) {
      const current = await DB.prepare('SELECT * FROM cloud_snapshot_capture_jobs WHERE workspace_id = ? AND id = ?')
        .bind(workspaceId, jobId).first<SnapshotCaptureJob>();
      if (current?.manifest_sha256 === rootHash && current.state === 'manifest_ready') return current;
      try { await PRIVATE_ASSETS.delete(rootKey); }
      catch { console.error('cloud.capture.manifest_cleanup_pending'); }
    }
    if (error instanceof CaptureIntegrityError || error instanceof SnapshotArtifactError) {
      await DB.prepare(`UPDATE cloud_snapshot_capture_jobs SET state = 'invalid', updated_at = ?
        WHERE workspace_id = ? AND id = ? AND lease_token = ?`)
        .bind(new Date().toISOString(), workspaceId, jobId, token).run();
      throw error;
    }
    if (error instanceof Error && error.message.includes('CLOUD_RECOVERY_CONFLICT')) {
      const workspace = await DB.prepare('SELECT recovery_revision, lifecycle FROM workspaces WHERE id = ?')
        .bind(workspaceId).first<{ recovery_revision: number; lifecycle: string }>();
      if (workspace?.recovery_revision !== job.revision || workspace.lifecycle !== 'active') {
        await DB.prepare(`UPDATE cloud_snapshot_capture_jobs SET state = 'invalid', updated_at = ?
          WHERE workspace_id = ? AND id = ? AND lease_token = ?`)
          .bind(new Date().toISOString(), workspaceId, jobId, token).run();
        throw new CloudRecoveryError('Workspace changed during verification. Start a new capture.', 409);
      }
      throw new CloudRecoveryError('Verification state changed. Retry in a moment.', 409);
    }
    throw error;
  } finally {
    await DB.prepare(`UPDATE cloud_snapshot_capture_jobs SET lease_token = NULL, lease_until = NULL
      WHERE workspace_id = ? AND id = ? AND lease_token = ?`).bind(workspaceId, jobId, token).run();
  }
}
