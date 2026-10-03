import { backupChecksum, maintenanceGuard, removeGuard } from '@/lib/cloud/recovery-storage';
import { CloudRecoveryError, SNAPSHOT_TABLES, type SnapshotRow, type SnapshotTable } from '@/lib/cloud/recovery-contract';

type DB = CloudflareEnv['DB'];
type Assets = CloudflareEnv['PRIVATE_ASSETS'];
type CaptureEnv = { DB: DB; PRIVATE_ASSETS: Assets };

export type SnapshotCaptureJob = {
  id: string;
  workspace_id: string;
  revision: number;
  state: 'capturing' | 'awaiting_verification' | 'manifest_ready' | 'invalid';
  table_index: number;
  cursor_key: string;
  chunk_count: number;
  row_counts: string;
  verify_index: number;
  manifest_part_count: number;
  manifest_chain: string;
  manifest_sha256: string | null;
  manifest_bytes: number | null;
  lease_token: string | null;
  lease_until: string | null;
};

export const CAPTURE_PAGE_ROWS = 8;
export const MAX_CAPTURE_CHUNK_BYTES = 3_000_000;
const LEASE_MS = 5 * 60_000;
const encoder = new TextEncoder();

export function snapshotChunkKey(workspaceId: string, jobId: string, sequence: number, sha256: string) {
  return `${workspaceId}/recovery-jobs/${jobId}/chunks/${sequence}-${sha256}.json`;
}

export function snapshotCursor(table: SnapshotTable, row: SnapshotRow): string {
  if (table === 'contact_group_members') return JSON.stringify([row.contact_id, row.group_id]);
  return String(row.id);
}

function pageStatement(db: DB, job: SnapshotCaptureJob, table: SnapshotTable, cursorKey: string) {
  if (table === 'contact_group_members') {
    const [contactId, groupId] = cursorKey ? JSON.parse(cursorKey) as [number, number] : [0, 0];
    return db.prepare(`SELECT * FROM contact_group_members WHERE workspace_id = ?
      AND (contact_id > ? OR (contact_id = ? AND group_id > ?))
      ORDER BY contact_id, group_id LIMIT ?`)
      .bind(job.workspace_id, contactId, contactId, groupId, CAPTURE_PAGE_ROWS);
  }
  const cursor = table === 'daily_snoozes' ? cursorKey : Number(cursorKey || 0);
  return db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT ?`)
    .bind(job.workspace_id, cursor, CAPTURE_PAGE_ROWS);
}

async function getJob(db: DB, workspaceId: string, id: string): Promise<SnapshotCaptureJob> {
  const job = await db.prepare('SELECT * FROM cloud_snapshot_capture_jobs WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, id).first<SnapshotCaptureJob>();
  if (!job) throw new CloudRecoveryError('Capture job not found.', 404);
  return job;
}

function captureGuard(db: DB, job: SnapshotCaptureJob, token: string) {
  return maintenanceGuard(db, `${token}-capture`, `EXISTS (
    SELECT 1 FROM cloud_snapshot_capture_jobs job
    JOIN workspaces workspace ON workspace.id = job.workspace_id
    WHERE job.id = ? AND job.workspace_id = ? AND job.state = 'capturing'
      AND job.revision = ? AND job.lease_token = ? AND job.table_index = ?
      AND job.cursor_key = ? AND job.chunk_count = ?
      AND workspace.lifecycle = 'active' AND workspace.recovery_revision = job.revision
  )`, [job.id, job.workspace_id, job.revision, token, job.table_index, job.cursor_key, job.chunk_count]);
}

export async function beginCloudSnapshotCapture(workspaceId: string, env: CaptureEnv): Promise<SnapshotCaptureJob> {
  const { DB } = env;
  const workspace = await DB.prepare("SELECT recovery_revision FROM workspaces WHERE id = ? AND lifecycle = 'active'")
    .bind(workspaceId).first<{ recovery_revision: number }>();
  if (!workspace) throw new CloudRecoveryError('Workspace is not available for capture.', 409);
  await DB.prepare(`UPDATE cloud_snapshot_capture_jobs SET state = 'invalid', updated_at = ?
    WHERE workspace_id = ? AND state IN ('capturing', 'awaiting_verification')
      AND revision <> ? AND (lease_token IS NULL OR lease_until < ?)`)
    .bind(new Date().toISOString(), workspaceId, workspace.recovery_revision, new Date().toISOString()).run();
  const id = crypto.randomUUID();
  await DB.prepare(`INSERT INTO cloud_snapshot_capture_jobs (id, workspace_id, revision)
    SELECT ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM cloud_snapshot_capture_jobs
      WHERE workspace_id = ? AND state IN ('capturing', 'awaiting_verification')
    ) ON CONFLICT DO NOTHING`).bind(id, workspaceId, workspace.recovery_revision, workspaceId).run();
  const job = await DB.prepare(`SELECT * FROM cloud_snapshot_capture_jobs WHERE workspace_id = ?
    AND state IN ('capturing', 'awaiting_verification') ORDER BY created_at DESC LIMIT 1`)
    .bind(workspaceId).first<SnapshotCaptureJob>();
  if (!job || job.revision !== workspace.recovery_revision) throw new CloudRecoveryError('Workspace changed during capture setup. Retry.', 409);
  return job;
}

export async function advanceCloudSnapshotCapture(workspaceId: string, id: string, env: CaptureEnv): Promise<SnapshotCaptureJob> {
  const { DB, PRIVATE_ASSETS } = env;
  const now = new Date();
  const token = crypto.randomUUID();
  const claimed = await DB.prepare(`UPDATE cloud_snapshot_capture_jobs
    SET lease_token = ?, lease_until = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ? AND state = 'capturing'
      AND (lease_token IS NULL OR lease_until < ?)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active'
        AND recovery_revision = cloud_snapshot_capture_jobs.revision)
    RETURNING *`)
    .bind(token, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString(),
      workspaceId, id, now.toISOString(), workspaceId).first<SnapshotCaptureJob>();
  if (!claimed) {
    const current = await getJob(DB, workspaceId, id);
    const workspace = await DB.prepare('SELECT recovery_revision, lifecycle FROM workspaces WHERE id = ?')
      .bind(workspaceId).first<{ recovery_revision: number; lifecycle: string }>();
    if (current.state === 'manifest_ready') return current;
    if (workspace?.recovery_revision !== current.revision || workspace.lifecycle !== 'active') {
      await DB.prepare(`UPDATE cloud_snapshot_capture_jobs SET state = 'invalid', updated_at = ?
        WHERE workspace_id = ? AND id = ? AND state IN ('capturing', 'awaiting_verification')
          AND (lease_token IS NULL OR lease_until < ?)`)
        .bind(now.toISOString(), workspaceId, id, now.toISOString()).run();
      throw new CloudRecoveryError('Workspace changed during capture. Start a new job.', 409);
    }
    if (current.state === 'awaiting_verification') return current;
    if (current.state === 'invalid') throw new CloudRecoveryError('This capture is invalid. Start a new job.', 409);
    throw new CloudRecoveryError('Another capture request is running. Retry shortly.', 409);
  }

  let uploadedKey: string | null = null;
  let uploadedHash: string | null = null;
  try {
    let tableIndex = claimed.table_index;
    let cursorKey = claimed.cursor_key;
    let table: SnapshotTable | undefined;
    let rows: SnapshotRow[] = [];
    while (tableIndex < SNAPSHOT_TABLES.length) {
      table = SNAPSHOT_TABLES[tableIndex];
      rows = (await pageStatement(DB, claimed, table, cursorKey).all<SnapshotRow>()).results;
      if (rows.length) break;
      tableIndex++;
      cursorKey = '';
    }
    if (!table || !rows.length) {
      await DB.batch([
        captureGuard(DB, claimed, token),
        DB.prepare(`UPDATE cloud_snapshot_capture_jobs SET state = 'awaiting_verification',
          table_index = ?, cursor_key = '', lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND lease_token = ?`)
          .bind(SNAPSHOT_TABLES.length, new Date().toISOString(), workspaceId, id, token),
        removeGuard(DB, `${token}-capture`),
      ]);
      return getJob(DB, workspaceId, id);
    }
    const selected: SnapshotRow[] = [];
    let byteLength = 0;
    for (const row of rows) {
      const rowBytes = encoder.encode(JSON.stringify(row)).byteLength;
      if (rowBytes > MAX_CAPTURE_CHUNK_BYTES) throw new CloudRecoveryError('A CRM row is too large for bounded capture.', 413);
      if (selected.length && byteLength + rowBytes > MAX_CAPTURE_CHUNK_BYTES) break;
      selected.push(row);
      byteLength += rowBytes;
    }
    const nextCursor = snapshotCursor(table, selected.at(-1)!);
    const payload = encoder.encode(JSON.stringify({ format: 'everclose-cloud-chunk', version: 1,
      workspaceId, jobId: id, revision: claimed.revision, table, sequence: claimed.chunk_count, rows: selected }));
    if (payload.byteLength > MAX_CAPTURE_CHUNK_BYTES + 1024) throw new CloudRecoveryError('Capture chunk exceeded its size bound.', 413);
    const sha256 = await backupChecksum(payload);
    const key = snapshotChunkKey(workspaceId, id, claimed.chunk_count, sha256);
    uploadedKey = key;
    uploadedHash = sha256;
    await PRIVATE_ASSETS.put(key, payload, { customMetadata: { sha256, workspaceId, jobId: id, table } });
    const verified = await PRIVATE_ASSETS.get(key);
    if (!verified || verified.size !== payload.byteLength || await backupChecksum(new Uint8Array(await verified.arrayBuffer())) !== sha256) {
      throw new CloudRecoveryError('The capture chunk could not be verified.', 503);
    }
    const counts = JSON.parse(claimed.row_counts) as Record<string, number>;
    counts[table] = (counts[table] || 0) + selected.length;
    await DB.batch([
      captureGuard(DB, claimed, token),
      DB.prepare(`INSERT INTO cloud_snapshot_capture_chunks
        (job_id, workspace_id, sequence, table_name, cursor_key, row_count, byte_length, sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, workspaceId, claimed.chunk_count, table, nextCursor, selected.length, payload.byteLength, sha256),
      DB.prepare(`UPDATE cloud_snapshot_capture_jobs SET table_index = ?, cursor_key = ?,
        chunk_count = chunk_count + 1, row_counts = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND lease_token = ?`)
        .bind(tableIndex, nextCursor, JSON.stringify(counts), new Date().toISOString(), workspaceId, id, token),
      removeGuard(DB, `${token}-capture`),
    ]);
    return getJob(DB, workspaceId, id);
  } catch (error) {
    if (uploadedKey) {
      const committed = await DB.prepare('SELECT sha256 FROM cloud_snapshot_capture_chunks WHERE job_id = ? AND sequence = ?')
        .bind(id, claimed.chunk_count).first<{ sha256: string }>();
      if (committed?.sha256 === uploadedHash) return getJob(DB, workspaceId, id);
      try { await PRIVATE_ASSETS.delete(uploadedKey); }
      catch { console.error('cloud.capture.orphan_cleanup_pending'); }
    }
    if (error instanceof Error && error.message.includes('CLOUD_RECOVERY_CONFLICT')) {
      const workspace = await DB.prepare('SELECT recovery_revision, lifecycle FROM workspaces WHERE id = ?')
        .bind(workspaceId).first<{ recovery_revision: number; lifecycle: string }>();
      if (workspace?.recovery_revision !== claimed.revision || workspace.lifecycle !== 'active') {
        await DB.prepare(`UPDATE cloud_snapshot_capture_jobs SET state = 'invalid', updated_at = ?
          WHERE workspace_id = ? AND id = ? AND lease_token = ?`)
          .bind(new Date().toISOString(), workspaceId, id, token).run();
        throw new CloudRecoveryError('Workspace changed during capture. Start a new job.', 409);
      }
      throw new CloudRecoveryError('Capture state changed. Retry in a moment.', 409);
    }
    throw error;
  } finally {
    await DB.prepare(`UPDATE cloud_snapshot_capture_jobs SET lease_token = NULL, lease_until = NULL
      WHERE workspace_id = ? AND id = ? AND lease_token = ?`).bind(workspaceId, id, token).run();
  }
}

export async function discardCloudSnapshotCapture(workspaceId: string, id: string, env: CaptureEnv, clock = new Date()): Promise<{ pending: boolean }> {
  const { DB, PRIVATE_ASSETS } = env;
  const now = clock.toISOString();
  const marked = await DB.prepare(`UPDATE cloud_snapshot_capture_jobs
    SET state = 'invalid', lease_token = NULL, lease_until = NULL, updated_at = ?
    WHERE workspace_id = ? AND id = ? AND (lease_token IS NULL OR lease_until < ?)
      AND NOT EXISTS (SELECT 1 FROM cloud_snapshot_read_jobs
        WHERE capture_job_id = ? AND workspace_id = ? AND lease_token IS NOT NULL AND lease_until >= ?)
      AND NOT EXISTS (SELECT 1 FROM cloud_snapshot_restore_jobs
        WHERE workspace_id = ?
          AND (target_capture_job_id = ? OR rollback_capture_job_id = ?))
    RETURNING id`).bind(now, workspaceId, id, now, id, workspaceId, now,
      workspaceId, id, id).first<{ id: string }>();
  if (!marked) {
    await getJob(DB, workspaceId, id);
    throw new CloudRecoveryError('Capture is still running or reserved by a snapshot read or restore preparation. Retry after it is released.', 409);
  }
  const prefix = `${workspaceId}/recovery-jobs/${id}/`;
  const objects = await PRIVATE_ASSETS.list({ prefix, limit: 100 });
  if (objects.objects.length) await PRIVATE_ASSETS.delete(objects.objects.map((object: { key: string }) => object.key));
  if ((await PRIVATE_ASSETS.list({ prefix, limit: 1 })).objects.length) return { pending: true };
  await DB.prepare("DELETE FROM cloud_snapshot_capture_jobs WHERE workspace_id = ? AND id = ? AND state = 'invalid'")
    .bind(workspaceId, id).run();
  return { pending: false };
}
