import { backupChecksum, maintenanceGuard, removeGuard } from '@/lib/cloud/recovery-storage';
import { CloudRecoveryError, SNAPSHOT_TABLES, type SnapshotTable } from '@/lib/cloud/recovery-contract';
import { MANIFEST_PART_CHUNKS, SnapshotArtifactError, readPrivateSnapshotChunk,
  readPrivateSnapshotPart, readPrivateSnapshotRoot } from '@/lib/cloud/snapshot-artifact';

type DB = CloudflareEnv['DB'];
type Assets = CloudflareEnv['PRIVATE_ASSETS'];
type ReadEnv = { DB: DB; PRIVATE_ASSETS: Assets };

export type SnapshotReadJob = {
  id: string;
  workspace_id: string;
  capture_job_id: string;
  manifest_sha256: string;
  state: 'reading' | 'verified' | 'invalid';
  part_index: number;
  chunk_index: number;
  part_chain: string;
  row_counts: string;
  last_table_index: number;
  last_cursor_key: string;
  lease_token: string | null;
  lease_until: string | null;
};

const LEASE_MS = 5 * 60_000;
const encoder = new TextEncoder();

async function getJob(db: DB, workspaceId: string, id: string): Promise<SnapshotReadJob> {
  const job = await db.prepare('SELECT * FROM cloud_snapshot_read_jobs WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, id).first<SnapshotReadJob>();
  if (!job) throw new CloudRecoveryError('Snapshot read job not found.', 404);
  return job;
}

function readGuard(db: DB, job: SnapshotReadJob, token: string) {
  return maintenanceGuard(db, `${token}-read`, `EXISTS (
    SELECT 1 FROM cloud_snapshot_read_jobs reader
    JOIN cloud_snapshot_capture_jobs capture ON capture.id = reader.capture_job_id
    JOIN workspaces workspace ON workspace.id = reader.workspace_id
    WHERE reader.id = ? AND reader.workspace_id = ? AND reader.state = 'reading'
      AND reader.lease_token = ? AND reader.part_index = ? AND reader.chunk_index = ?
      AND reader.part_chain = ? AND reader.row_counts = ?
      AND reader.last_table_index = ? AND reader.last_cursor_key = ?
      AND capture.workspace_id = reader.workspace_id AND capture.state = 'manifest_ready'
      AND capture.manifest_sha256 = reader.manifest_sha256 AND workspace.lifecycle = 'active'
  )`, [job.id, job.workspace_id, token, job.part_index, job.chunk_index,
    job.part_chain, job.row_counts, job.last_table_index, job.last_cursor_key]);
}

function checkedCounts(value: string): Record<SnapshotTable, number> {
  let source: unknown;
  try { source = JSON.parse(value); }
  catch { throw new SnapshotArtifactError('Snapshot read counts are malformed.'); }
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || Object.keys(source).some((table) => !SNAPSHOT_TABLES.includes(table as SnapshotTable))) {
    throw new SnapshotArtifactError('Snapshot read counts are malformed.');
  }
  const counts = source as Record<string, unknown>;
  for (const table of SNAPSHOT_TABLES) {
    const count = counts[table] ?? 0;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new SnapshotArtifactError('Snapshot read counts are malformed.');
    }
  }
  return Object.fromEntries(SNAPSHOT_TABLES.map((table) => [table, counts[table] || 0])) as Record<SnapshotTable, number>;
}

export async function beginCloudSnapshotRead(workspaceId: string, captureJobId: string, env: ReadEnv): Promise<SnapshotReadJob> {
  const capture = await env.DB.prepare(`SELECT revision, manifest_sha256 FROM cloud_snapshot_capture_jobs
    WHERE id = ? AND workspace_id = ? AND state = 'manifest_ready'`)
    .bind(captureJobId, workspaceId).first<{ revision: number; manifest_sha256: string }>();
  if (!capture?.manifest_sha256) throw new CloudRecoveryError('Verified private manifest not found.', 404);
  const root = await readPrivateSnapshotRoot({ workspaceId, jobId: captureJobId }, capture.manifest_sha256, env.PRIVATE_ASSETS);
  if (root.revision !== capture.revision) throw new SnapshotArtifactError('Snapshot revision does not match the published manifest.');
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO cloud_snapshot_read_jobs (id, workspace_id, capture_job_id, manifest_sha256)
    VALUES (?, ?, ?, ?)`).bind(id, workspaceId, captureJobId, capture.manifest_sha256).run();
  return getJob(env.DB, workspaceId, id);
}

export async function advanceCloudSnapshotRead(workspaceId: string, id: string, env: ReadEnv): Promise<SnapshotReadJob> {
  const { DB, PRIVATE_ASSETS } = env;
  const now = new Date();
  const token = crypto.randomUUID();
  const job = await DB.prepare(`UPDATE cloud_snapshot_read_jobs SET lease_token = ?, lease_until = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ? AND state = 'reading'
      AND (lease_token IS NULL OR lease_until < ?)
      AND EXISTS (SELECT 1 FROM cloud_snapshot_capture_jobs capture
        WHERE capture.id = cloud_snapshot_read_jobs.capture_job_id
          AND capture.workspace_id = cloud_snapshot_read_jobs.workspace_id
          AND capture.state = 'manifest_ready' AND capture.manifest_sha256 = cloud_snapshot_read_jobs.manifest_sha256)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active')
    RETURNING *`).bind(token, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString(),
    workspaceId, id, now.toISOString(), workspaceId).first<SnapshotReadJob>();
  if (!job) {
    const current = await getJob(DB, workspaceId, id);
    if (current.state === 'verified') return current;
    if (current.state === 'invalid') throw new CloudRecoveryError('This snapshot read is invalid. Start again.', 409);
    throw new CloudRecoveryError('Another snapshot read step is running, or the manifest is unavailable.', 409);
  }
  try {
    const root = await readPrivateSnapshotRoot({ workspaceId, jobId: job.capture_job_id }, job.manifest_sha256, PRIVATE_ASSETS);
    if (job.chunk_index < 0 || job.chunk_index > root.chunkCount || job.part_index < 0 || job.part_index > root.partCount
      || job.part_index !== Math.floor(job.chunk_index / MANIFEST_PART_CHUNKS) && job.chunk_index < root.chunkCount
      || job.last_table_index < -1 || job.last_table_index >= SNAPSHOT_TABLES.length) {
      throw new SnapshotArtifactError('Snapshot read cursor is inconsistent.');
    }
    const counts = checkedCounts(job.row_counts);
    let nextPart = job.part_index;
    let nextChunk = job.chunk_index;
    let chain = job.part_chain;
    let tableIndex = job.last_table_index;
    let cursorKey = job.last_cursor_key;
    if (job.chunk_index < root.chunkCount) {
      const part = await readPrivateSnapshotPart(root, job.part_index, PRIVATE_ASSETS);
      const offset = job.chunk_index - job.part_index * MANIFEST_PART_CHUNKS;
      const descriptor = part.chunks[offset];
      if (!descriptor || descriptor.sequence !== job.chunk_index) throw new SnapshotArtifactError('Snapshot read sequence has a gap.');
      const result = await readPrivateSnapshotChunk(root, descriptor,
        { tableIndex, cursorKey }, PRIVATE_ASSETS);
      counts[descriptor.table_name] += result.rows.length;
      tableIndex = result.next.tableIndex;
      cursorKey = result.next.cursorKey;
      nextChunk++;
      if (offset + 1 === part.chunks.length) {
        chain = await backupChecksum(encoder.encode(`${chain}:${part.sha256}`));
        nextPart++;
      }
    }
    const complete = nextChunk === root.chunkCount;
    if (complete && (nextPart !== root.partCount || chain !== root.partsChainSha256
      || SNAPSHOT_TABLES.some((table) => counts[table] !== root.rowCounts[table]))) {
      throw new SnapshotArtifactError('Snapshot read totals or manifest chain do not match.');
    }
    await DB.batch([
      readGuard(DB, job, token),
      DB.prepare(`UPDATE cloud_snapshot_read_jobs SET state = ?, part_index = ?, chunk_index = ?,
        part_chain = ?, row_counts = ?, last_table_index = ?, last_cursor_key = ?,
        lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND lease_token = ?`)
        .bind(complete ? 'verified' : 'reading', nextPart, nextChunk, chain, JSON.stringify(counts),
          tableIndex, cursorKey, new Date().toISOString(), workspaceId, id, token),
      removeGuard(DB, `${token}-read`),
    ]);
    return getJob(DB, workspaceId, id);
  } catch (error) {
    if (error instanceof SnapshotArtifactError) {
      await DB.prepare(`UPDATE cloud_snapshot_read_jobs SET state = 'invalid', updated_at = ?
        WHERE workspace_id = ? AND id = ? AND lease_token = ?`)
        .bind(new Date().toISOString(), workspaceId, id, token).run();
    }
    if (error instanceof Error && error.message.includes('CLOUD_RECOVERY_CONFLICT')) {
      throw new CloudRecoveryError('Snapshot read state changed. Retry in a moment.', 409);
    }
    throw error;
  } finally {
    await DB.prepare(`UPDATE cloud_snapshot_read_jobs SET lease_token = NULL, lease_until = NULL
      WHERE workspace_id = ? AND id = ? AND lease_token = ?`).bind(workspaceId, id, token).run();
  }
}

export async function discardCloudSnapshotRead(workspaceId: string, id: string, db: DB): Promise<void> {
  const now = new Date().toISOString();
  const removed = await db.prepare(`DELETE FROM cloud_snapshot_read_jobs WHERE workspace_id = ? AND id = ?
    AND (lease_token IS NULL OR lease_until < ?)
    AND NOT EXISTS (SELECT 1 FROM cloud_snapshot_restore_jobs
      WHERE workspace_id = ?
        AND (target_read_job_id = ? OR rollback_read_job_id = ?))
    RETURNING id`).bind(workspaceId, id, now, workspaceId, id, id).first<{ id: string }>();
  if (removed) return;
  await getJob(db, workspaceId, id);
  throw new CloudRecoveryError('Snapshot read is still running or reserved by a restore preparation. Retry after it is released.', 409);
}
