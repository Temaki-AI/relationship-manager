import { CloudRecoveryError, SNAPSHOT_TABLES, snapshotColumns, type SnapshotRow, type SnapshotTable } from '@/lib/cloud/recovery-contract';
import { backupChecksum, maintenanceGuard, removeGuard } from '@/lib/cloud/recovery-storage';
import { MANIFEST_PART_CHUNKS, readPrivateSnapshotChunk, readPrivateSnapshotPart,
  readPrivateSnapshotRoot } from '@/lib/cloud/snapshot-artifact';
import type { SnapshotRestorePreparation } from '@/lib/cloud/snapshot-restore-preparation';

type DB = CloudflareEnv['DB'];
type Assets = CloudflareEnv['PRIVATE_ASSETS'];
type Env = { DB: DB; PRIVATE_ASSETS: Assets };

const LEASE_MS = 5 * 60_000;
const DELETE_ROWS_PER_STEP = 64;
const INSERT_ROWS_PER_STEP = 4;
const encoder = new TextEncoder();
const DELETE_TABLES = [
  'reminder_email_deliveries', 'birthday_email_deliveries',
  'birthday_email_scan_state', 'child_birthday_email_scan_state',
  ...[...SNAPSHOT_TABLES].reverse(),
] as const;

async function getJob(db: DB, workspaceId: string, id: string): Promise<SnapshotRestorePreparation> {
  const job = await db.prepare('SELECT * FROM cloud_snapshot_restore_jobs WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, id).first<SnapshotRestorePreparation>();
  if (!job) throw new CloudRecoveryError('Restore job not found.', 404);
  return job;
}

function sourceIds(job: SnapshotRestorePreparation): { captureId: string; readId: string } {
  const captureId = job.apply_source === 'rollback' ? job.rollback_capture_job_id : job.target_capture_job_id;
  const readId = job.apply_source === 'rollback' ? job.rollback_read_job_id : job.target_read_job_id;
  if (!captureId || !readId || (job.apply_source !== 'target' && job.apply_source !== 'rollback')) {
    throw new CloudRecoveryError('Restore source is unavailable.', 409);
  }
  return { captureId, readId };
}

function applyGuard(db: DB, job: SnapshotRestorePreparation, token: string) {
  return maintenanceGuard(db, `${token}-apply`, `EXISTS (
    SELECT 1 FROM cloud_snapshot_restore_jobs job JOIN workspaces workspace ON workspace.id = job.workspace_id
    WHERE job.id = ? AND job.workspace_id = ? AND job.state = 'deleting'
      AND job.lease_token = ? AND job.apply_source = ?
      AND job.apply_table_index = ? AND workspace.lifecycle = 'restoring'
  )`, [job.id, job.workspace_id, token, job.apply_source, job.apply_table_index]);
}

export async function beginCloudSnapshotRestoreApply(workspaceId: string, id: string,
  env: Env): Promise<SnapshotRestorePreparation> {
  const job = await getJob(env.DB, workspaceId, id);
  if (job.apply_source === 'target'
    && ['deleting', 'awaiting_write', 'writing', 'repairing_dates', 'verifying', 'completed'].includes(job.state)) return job;
  if (job.state !== 'ready' || !job.rollback_capture_job_id || !job.target_read_job_id || !job.rollback_read_job_id) {
    throw new CloudRecoveryError('Both target and rollback snapshots must be verified before application.', 409);
  }
  const captures = (await env.DB.prepare(`SELECT id, revision, manifest_sha256 FROM cloud_snapshot_capture_jobs
    WHERE workspace_id = ? AND id IN (?, ?) AND state = 'manifest_ready'`)
    .bind(workspaceId, job.target_capture_job_id, job.rollback_capture_job_id)
    .all<{ id: string; revision: number; manifest_sha256: string }>()).results as
    Array<{ id: string; revision: number; manifest_sha256: string }>;
  const target = captures.find((capture) => capture.id === job.target_capture_job_id);
  const rollback = captures.find((capture) => capture.id === job.rollback_capture_job_id);
  if (!target?.manifest_sha256 || !rollback?.manifest_sha256 || rollback.revision !== job.base_revision) {
    throw new CloudRecoveryError('A prepared snapshot is no longer available.', 409);
  }
  await readPrivateSnapshotRoot({ workspaceId, jobId: target.id }, target.manifest_sha256, env.PRIVATE_ASSETS);
  await readPrivateSnapshotRoot({ workspaceId, jobId: rollback.id }, rollback.manifest_sha256, env.PRIVATE_ASSETS);
  const token = crypto.randomUUID();
  try {
    await env.DB.batch([
      maintenanceGuard(env.DB, token, `EXISTS (
        SELECT 1 FROM cloud_snapshot_restore_jobs job
        JOIN workspaces workspace ON workspace.id = job.workspace_id
        JOIN cloud_snapshot_capture_jobs target ON target.id = job.target_capture_job_id
        JOIN cloud_snapshot_capture_jobs rollback ON rollback.id = job.rollback_capture_job_id
        JOIN cloud_snapshot_read_jobs target_read ON target_read.id = job.target_read_job_id
        JOIN cloud_snapshot_read_jobs rollback_read ON rollback_read.id = job.rollback_read_job_id
        WHERE job.id = ? AND job.workspace_id = ? AND job.state = 'ready'
          AND workspace.lifecycle = 'active' AND workspace.recovery_revision = job.base_revision
          AND target.workspace_id = job.workspace_id AND target.state = 'manifest_ready'
          AND target.manifest_sha256 = target_read.manifest_sha256
          AND rollback.workspace_id = job.workspace_id AND rollback.state = 'manifest_ready'
          AND rollback.revision = job.base_revision AND rollback.manifest_sha256 = rollback_read.manifest_sha256
          AND target_read.workspace_id = job.workspace_id AND target_read.state = 'verified'
          AND target_read.capture_job_id = target.id
          AND rollback_read.workspace_id = job.workspace_id AND rollback_read.state = 'verified'
          AND rollback_read.capture_job_id = rollback.id
      )`, [id, workspaceId]),
      env.DB.prepare("UPDATE workspaces SET lifecycle = 'restoring' WHERE id = ? AND lifecycle = 'active'")
        .bind(workspaceId),
      env.DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET state = 'deleting', apply_source = 'target', apply_table_index = 0,
        apply_chunk_index = 0, apply_row_index = 0, apply_part_chain = '', apply_row_counts = '{}',
        background_state = 'running', background_version = background_version + 1,
        updated_at = ? WHERE id = ? AND workspace_id = ? AND state = 'ready'`)
        .bind(new Date().toISOString(), id, workspaceId),
      removeGuard(env.DB, token),
    ]);
  } catch (error) {
    const current = await getJob(env.DB, workspaceId, id);
    if (current.apply_source === 'target'
      && ['deleting', 'awaiting_write', 'writing', 'repairing_dates', 'verifying', 'completed'].includes(current.state)) return current;
    if (error instanceof Error && error.message.includes('CLOUD_RECOVERY_CONFLICT')) {
      throw new CloudRecoveryError('Workspace or snapshot changed before restore. No data was replaced.', 409);
    }
    throw error;
  }
  return getJob(env.DB, workspaceId, id);
}

export async function beginCloudSnapshotRestoreRollback(workspaceId: string, id: string,
  env: Env): Promise<SnapshotRestorePreparation> {
  const job = await getJob(env.DB, workspaceId, id);
  if (job.state === 'rolled_back' || (job.apply_source === 'rollback'
    && ['deleting', 'awaiting_write', 'writing', 'repairing_dates', 'verifying'].includes(job.state))) return job;
  if (job.apply_source !== 'target'
    || !['deleting', 'awaiting_write', 'writing', 'repairing_dates', 'verifying'].includes(job.state)
    || !job.rollback_capture_job_id || !job.rollback_read_job_id) {
    throw new CloudRecoveryError('Rollback is only available while applying a prepared restore.', 409);
  }
  const rollback = await env.DB.prepare(`SELECT capture.revision, capture.manifest_sha256
    FROM cloud_snapshot_capture_jobs capture JOIN cloud_snapshot_read_jobs reader
      ON reader.capture_job_id = capture.id AND reader.workspace_id = capture.workspace_id
    WHERE capture.id = ? AND capture.workspace_id = ? AND capture.state = 'manifest_ready'
      AND reader.id = ? AND reader.state = 'verified' AND reader.manifest_sha256 = capture.manifest_sha256`)
    .bind(job.rollback_capture_job_id, workspaceId, job.rollback_read_job_id)
    .first<{ revision: number; manifest_sha256: string }>();
  if (!rollback?.manifest_sha256 || rollback.revision !== job.base_revision) {
    throw new CloudRecoveryError('Verified rollback snapshot is unavailable.', 409);
  }
  const root = await readPrivateSnapshotRoot({ workspaceId, jobId: job.rollback_capture_job_id },
    rollback.manifest_sha256, env.PRIVATE_ASSETS);
  if (root.revision !== rollback.revision) {
    throw new CloudRecoveryError('Rollback snapshot revision changed.', 409);
  }
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      maintenanceGuard(env.DB, token, `EXISTS (
        SELECT 1 FROM cloud_snapshot_restore_jobs job JOIN workspaces workspace ON workspace.id = job.workspace_id
        JOIN cloud_snapshot_capture_jobs capture ON capture.id = job.rollback_capture_job_id
        JOIN cloud_snapshot_read_jobs reader ON reader.id = job.rollback_read_job_id
        WHERE job.id = ? AND job.workspace_id = ? AND job.apply_source = 'target'
          AND job.state IN ('deleting', 'awaiting_write', 'writing', 'repairing_dates', 'verifying')
          AND (job.lease_token IS NULL OR job.lease_until < ?)
          AND workspace.lifecycle = 'restoring'
          AND capture.workspace_id = job.workspace_id AND capture.state = 'manifest_ready'
          AND capture.revision = job.base_revision AND capture.manifest_sha256 = reader.manifest_sha256
          AND reader.workspace_id = job.workspace_id AND reader.state = 'verified'
          AND reader.capture_job_id = capture.id
      )`, [id, workspaceId, now]),
      env.DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET state = 'deleting', apply_source = 'rollback',
        apply_table_index = 0, apply_chunk_index = 0, apply_row_index = 0,
        apply_part_chain = '', apply_row_counts = '{}', lease_token = NULL, lease_until = NULL,
        background_state = 'running', background_version = background_version + 1,
        updated_at = ? WHERE id = ? AND workspace_id = ?`).bind(now, id, workspaceId),
      removeGuard(env.DB, token),
    ]);
  } catch (error) {
    const current = await getJob(env.DB, workspaceId, id);
    if (current.apply_source === 'rollback') return current;
    if (error instanceof Error && error.message.includes('CLOUD_RECOVERY_CONFLICT')) {
      throw new CloudRecoveryError('Restore step is running or rollback snapshot changed. Retry shortly.', 409);
    }
    throw error;
  }
  return getJob(env.DB, workspaceId, id);
}

export async function advanceCloudSnapshotRestoreDeletion(workspaceId: string, id: string,
  db: DB): Promise<SnapshotRestorePreparation> {
  const now = new Date();
  const token = crypto.randomUUID();
  const job = await db.prepare(`UPDATE cloud_snapshot_restore_jobs
    SET lease_token = ?, lease_until = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND state = 'deleting'
      AND (lease_token IS NULL OR lease_until < ?)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'restoring')
    RETURNING *`)
    .bind(token, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString(),
      id, workspaceId, now.toISOString(), workspaceId).first<SnapshotRestorePreparation>();
  if (!job) {
    const current = await getJob(db, workspaceId, id);
    if (current.state === 'awaiting_write') return current;
    throw new CloudRecoveryError('Another restore step is running, or the workspace is unavailable.', 409);
  }
  try {
    sourceIds(job);
    const table = DELETE_TABLES[job.apply_table_index];
    if (!table) {
      if (job.apply_table_index !== DELETE_TABLES.length) {
        throw new CloudRecoveryError('Restore deletion cursor is invalid.', 409);
      }
      await db.batch([
        applyGuard(db, job, token),
        db.prepare(`UPDATE cloud_snapshot_restore_jobs SET state = 'awaiting_write',
          lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND lease_token = ?`)
          .bind(new Date().toISOString(), id, workspaceId, token),
        removeGuard(db, `${token}-apply`),
      ]);
      return getJob(db, workspaceId, id);
    }
    const first = await db.prepare(`SELECT rowid FROM ${table} WHERE workspace_id = ? LIMIT 1`)
      .bind(workspaceId).first<{ rowid: number }>();
    if (!first) {
      await db.batch([
        applyGuard(db, job, token),
        db.prepare(`UPDATE cloud_snapshot_restore_jobs SET apply_table_index = apply_table_index + 1,
          lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND lease_token = ?`)
          .bind(new Date().toISOString(), id, workspaceId, token),
        removeGuard(db, `${token}-apply`),
      ]);
      return getJob(db, workspaceId, id);
    }
    await db.batch([
      applyGuard(db, job, token),
      db.prepare("UPDATE workspaces SET lifecycle = 'active' WHERE id = ? AND lifecycle = 'restoring'")
        .bind(workspaceId),
      db.prepare(`DELETE FROM ${table} WHERE rowid IN (
        SELECT rowid FROM ${table} WHERE workspace_id = ? ORDER BY rowid LIMIT ?
      ) AND workspace_id = ?`).bind(workspaceId, DELETE_ROWS_PER_STEP, workspaceId),
      db.prepare("UPDATE workspaces SET lifecycle = 'restoring' WHERE id = ? AND lifecycle = 'active'")
        .bind(workspaceId),
      db.prepare(`UPDATE cloud_snapshot_restore_jobs SET lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND lease_token = ?`)
        .bind(new Date().toISOString(), id, workspaceId, token),
      removeGuard(db, `${token}-apply`),
    ]);
    return getJob(db, workspaceId, id);
  } finally {
    await db.prepare(`UPDATE cloud_snapshot_restore_jobs SET lease_token = NULL, lease_until = NULL
      WHERE id = ? AND workspace_id = ? AND lease_token = ?`).bind(id, workspaceId, token).run();
  }
}

function checkedApplyCounts(value: string): Record<SnapshotTable, number> {
  let source: unknown;
  try { source = JSON.parse(value); }
  catch { throw new CloudRecoveryError('Restore row counts are malformed.', 409); }
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || Object.entries(source).some(([table, count]) => !SNAPSHOT_TABLES.includes(table as SnapshotTable)
      || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) {
    throw new CloudRecoveryError('Restore row counts are malformed.', 409);
  }
  return source as Record<SnapshotTable, number>;
}

function writeGuard(db: DB, job: SnapshotRestorePreparation, token: string) {
  return maintenanceGuard(db, `${token}-write`, `EXISTS (
    SELECT 1 FROM cloud_snapshot_restore_jobs job
    JOIN workspaces workspace ON workspace.id = job.workspace_id
    JOIN cloud_snapshot_capture_jobs capture ON capture.id = CASE job.apply_source
      WHEN 'rollback' THEN job.rollback_capture_job_id ELSE job.target_capture_job_id END
    JOIN cloud_snapshot_read_jobs reader ON reader.id = CASE job.apply_source
      WHEN 'rollback' THEN job.rollback_read_job_id ELSE job.target_read_job_id END
    WHERE job.id = ? AND job.workspace_id = ? AND job.state = ? AND job.lease_token = ?
      AND job.apply_source = ?
      AND job.apply_chunk_index = ? AND job.apply_row_index = ?
      AND job.apply_part_chain = ? AND job.apply_row_counts = ?
      AND workspace.lifecycle = 'restoring'
      AND capture.workspace_id = job.workspace_id AND capture.state = 'manifest_ready'
      AND capture.manifest_sha256 = reader.manifest_sha256
      AND reader.workspace_id = job.workspace_id AND reader.state = 'verified'
      AND reader.capture_job_id = capture.id
  )`, [job.id, job.workspace_id, job.state, token, job.apply_source, job.apply_chunk_index,
    job.apply_row_index, job.apply_part_chain, job.apply_row_counts]);
}

export async function advanceCloudSnapshotRestoreWriting(workspaceId: string, id: string,
  env: Env): Promise<SnapshotRestorePreparation> {
  const { DB, PRIVATE_ASSETS } = env;
  const now = new Date();
  const token = crypto.randomUUID();
  const job = await DB.prepare(`UPDATE cloud_snapshot_restore_jobs
    SET lease_token = ?, lease_until = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND state IN ('awaiting_write', 'writing')
      AND (lease_token IS NULL OR lease_until < ?)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'restoring')
    RETURNING *`)
    .bind(token, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString(),
      id, workspaceId, now.toISOString(), workspaceId).first<SnapshotRestorePreparation>();
  if (!job) {
    const current = await getJob(DB, workspaceId, id);
    if (current.state === 'repairing_dates') return current;
    throw new CloudRecoveryError('Another restore write step is running, or the workspace is unavailable.', 409);
  }
  try {
    const { captureId } = sourceIds(job);
    const capture = await DB.prepare(`SELECT revision, manifest_sha256 FROM cloud_snapshot_capture_jobs
      WHERE id = ? AND workspace_id = ? AND state = 'manifest_ready'`)
      .bind(captureId, workspaceId)
      .first<{ revision: number; manifest_sha256: string }>();
    if (!capture?.manifest_sha256) throw new CloudRecoveryError('Restore snapshot is unavailable.', 409);
    const root = await readPrivateSnapshotRoot({ workspaceId, jobId: captureId },
      capture.manifest_sha256, PRIVATE_ASSETS);
    if (root.revision !== capture.revision) throw new CloudRecoveryError('Restore snapshot revision changed.', 409);
    if (job.state === 'awaiting_write') {
      await DB.batch([
        writeGuard(DB, job, token),
        DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET state = 'writing',
          lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND lease_token = ?`)
          .bind(new Date().toISOString(), id, workspaceId, token),
        removeGuard(DB, `${token}-write`),
      ]);
      return getJob(DB, workspaceId, id);
    }
    if (job.apply_chunk_index > root.chunkCount || job.apply_row_index < 0) {
      throw new CloudRecoveryError('Restore write cursor is invalid.', 409);
    }
    const counts = checkedApplyCounts(job.apply_row_counts);
    if (job.apply_chunk_index === root.chunkCount) {
      if (job.apply_row_index !== 0 || job.apply_part_chain !== root.partsChainSha256
        || SNAPSHOT_TABLES.some((table) => (counts[table] || 0) !== root.rowCounts[table])) {
        throw new CloudRecoveryError('Applied row counts or manifest chain do not match.', 409);
      }
      await DB.batch([
        writeGuard(DB, job, token),
        DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET state = 'repairing_dates',
          apply_table_index = 0, apply_row_index = 0,
          lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND lease_token = ?`)
          .bind(new Date().toISOString(), id, workspaceId, token),
        removeGuard(DB, `${token}-write`),
      ]);
      return getJob(DB, workspaceId, id);
    }
    const partIndex = Math.floor(job.apply_chunk_index / MANIFEST_PART_CHUNKS);
    const part = await readPrivateSnapshotPart(root, partIndex, PRIVATE_ASSETS);
    const offset = job.apply_chunk_index % MANIFEST_PART_CHUNKS;
    const descriptor = part.chunks[offset];
    if (!descriptor || descriptor.sequence !== job.apply_chunk_index) {
      throw new CloudRecoveryError('Restore chunk sequence is incomplete.', 409);
    }
    const previousIndex = job.apply_chunk_index - 1;
    const previousPart = previousIndex < 0 ? null
      : Math.floor(previousIndex / MANIFEST_PART_CHUNKS) === partIndex ? part
        : await readPrivateSnapshotPart(root, partIndex - 1, PRIVATE_ASSETS);
    const previous = previousPart?.chunks[previousIndex % MANIFEST_PART_CHUNKS];
    if (previousIndex >= 0 && !previous) throw new CloudRecoveryError('Previous restore cursor is unavailable.', 409);
    const { rows } = await readPrivateSnapshotChunk(root, descriptor,
      { tableIndex: previous ? SNAPSHOT_TABLES.indexOf(previous.table_name) : -1,
        cursorKey: previous?.cursor_key || '' }, PRIVATE_ASSETS);
    if (job.apply_row_index >= rows.length) throw new CloudRecoveryError('Restore row cursor is invalid.', 409);
    const selected = rows.slice(job.apply_row_index, job.apply_row_index + INSERT_ROWS_PER_STEP);
    const nextCounts = { ...counts, [descriptor.table_name]: (counts[descriptor.table_name] || 0) + selected.length };
    const finishedChunk = job.apply_row_index + selected.length === rows.length;
    const finishedPart = finishedChunk && offset + 1 === part.chunks.length;
    const nextChain = finishedPart
      ? await backupChecksum(encoder.encode(`${job.apply_part_chain}:${part.sha256}`))
      : job.apply_part_chain;
    const table = descriptor.table_name;
    const columns = snapshotColumns(table).map((column) => column.name);
    await DB.batch([
      writeGuard(DB, job, token),
      DB.prepare("UPDATE workspaces SET lifecycle = 'active' WHERE id = ? AND lifecycle = 'restoring'")
        .bind(workspaceId),
      ...selected.map((row) => DB.prepare(`INSERT INTO ${table} (${columns.join(', ')})
        VALUES (${columns.map(() => '?').join(', ')})`).bind(...columns.map((column) => row[column]))),
      DB.prepare("UPDATE workspaces SET lifecycle = 'restoring' WHERE id = ? AND lifecycle = 'active'")
        .bind(workspaceId),
      DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET apply_chunk_index = ?, apply_row_index = ?,
        apply_part_chain = ?, apply_row_counts = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND lease_token = ?`)
        .bind(job.apply_chunk_index + Number(finishedChunk), finishedChunk ? 0 : job.apply_row_index + selected.length,
          nextChain, JSON.stringify(nextCounts), new Date().toISOString(), id, workspaceId, token),
      removeGuard(DB, `${token}-write`),
    ]);
    return getJob(DB, workspaceId, id);
  } finally {
    await DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET lease_token = NULL, lease_until = NULL
      WHERE id = ? AND workspace_id = ? AND lease_token = ?`).bind(id, workspaceId, token).run();
  }
}

export async function advanceCloudSnapshotRestoreDateRepair(workspaceId: string, id: string,
  env: Env): Promise<SnapshotRestorePreparation> {
  const { DB, PRIVATE_ASSETS } = env;
  const now = new Date();
  const token = crypto.randomUUID();
  const job = await DB.prepare(`UPDATE cloud_snapshot_restore_jobs
    SET lease_token = ?, lease_until = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND state = 'repairing_dates'
      AND (lease_token IS NULL OR lease_until < ?)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'restoring')
    RETURNING *`)
    .bind(token, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString(),
      id, workspaceId, now.toISOString(), workspaceId).first<SnapshotRestorePreparation>();
  if (!job) {
    const current = await getJob(DB, workspaceId, id);
    if (current.state === 'verifying') return current;
    throw new CloudRecoveryError('Another restore date step is running, or the workspace is unavailable.', 409);
  }
  const guard = () => maintenanceGuard(DB, `${token}-dates`, `EXISTS (
    SELECT 1 FROM cloud_snapshot_restore_jobs job JOIN workspaces workspace ON workspace.id = job.workspace_id
    WHERE job.id = ? AND job.workspace_id = ? AND job.state = 'repairing_dates'
      AND job.lease_token = ? AND job.apply_source = ?
      AND job.apply_table_index = ? AND job.apply_row_index = ?
      AND workspace.lifecycle = 'restoring'
  )`, [id, workspaceId, token, job.apply_source, job.apply_table_index, job.apply_row_index]);
  try {
    const { captureId } = sourceIds(job);
    const capture = await DB.prepare(`SELECT revision, manifest_sha256 FROM cloud_snapshot_capture_jobs
      WHERE id = ? AND workspace_id = ? AND state = 'manifest_ready'`)
      .bind(captureId, workspaceId)
      .first<{ revision: number; manifest_sha256: string }>();
    if (!capture?.manifest_sha256) throw new CloudRecoveryError('Restore snapshot is unavailable.', 409);
    const root = await readPrivateSnapshotRoot({ workspaceId, jobId: captureId },
      capture.manifest_sha256, PRIVATE_ASSETS);
    if (root.revision !== capture.revision || job.apply_table_index < 0 || job.apply_table_index > root.chunkCount) {
      throw new CloudRecoveryError('Restore date cursor is invalid.', 409);
    }
    const index = job.apply_table_index;
    const part = index < root.chunkCount
      ? await readPrivateSnapshotPart(root, Math.floor(index / MANIFEST_PART_CHUNKS), PRIVATE_ASSETS) : null;
    const descriptor = part?.chunks[index % MANIFEST_PART_CHUNKS];
    if (index < root.chunkCount && (!descriptor || descriptor.sequence !== index)) {
      throw new CloudRecoveryError('Restore contact chunk is missing.', 409);
    }
    if (index === root.chunkCount || descriptor?.table_name !== 'contacts') {
      if (job.apply_row_index !== 0) throw new CloudRecoveryError('Restore date cursor is incomplete.', 409);
      await DB.batch([
        guard(),
        DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET state = 'verifying', apply_table_index = 0,
          lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND lease_token = ?`)
          .bind(new Date().toISOString(), id, workspaceId, token),
        removeGuard(DB, `${token}-dates`),
      ]);
      return getJob(DB, workspaceId, id);
    }
    if (!part || !descriptor) throw new CloudRecoveryError('Restore contact chunk is missing.', 409);
    const previousIndex = index - 1;
    const previousPart = previousIndex < 0 ? null
      : Math.floor(previousIndex / MANIFEST_PART_CHUNKS) === Math.floor(index / MANIFEST_PART_CHUNKS)
        ? part : await readPrivateSnapshotPart(root, Math.floor(previousIndex / MANIFEST_PART_CHUNKS), PRIVATE_ASSETS);
    const previous = previousPart?.chunks[previousIndex % MANIFEST_PART_CHUNKS];
    if (previousIndex >= 0 && !previous) throw new CloudRecoveryError('Previous contact cursor is unavailable.', 409);
    const { rows } = await readPrivateSnapshotChunk(root, descriptor,
      { tableIndex: previous ? SNAPSHOT_TABLES.indexOf(previous.table_name) : -1,
        cursorKey: previous?.cursor_key || '' }, PRIVATE_ASSETS);
    if (job.apply_row_index >= rows.length) throw new CloudRecoveryError('Restore date row cursor is invalid.', 409);
    const selected = rows.slice(job.apply_row_index, job.apply_row_index + INSERT_ROWS_PER_STEP);
    const finished = job.apply_row_index + selected.length === rows.length;
    await DB.batch([
      guard(),
      DB.prepare("UPDATE workspaces SET lifecycle = 'active' WHERE id = ? AND lifecycle = 'restoring'")
        .bind(workspaceId),
      ...selected.map((row) => DB.prepare(`UPDATE contacts SET last_contacted = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ?`).bind(row.last_contacted, row.updated_at, workspaceId, row.id)),
      DB.prepare("UPDATE workspaces SET lifecycle = 'restoring' WHERE id = ? AND lifecycle = 'active'")
        .bind(workspaceId),
      DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET apply_table_index = ?, apply_row_index = ?,
        lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND lease_token = ?`)
        .bind(index + Number(finished), finished ? 0 : job.apply_row_index + selected.length,
          new Date().toISOString(), id, workspaceId, token),
      removeGuard(DB, `${token}-dates`),
    ]);
    return getJob(DB, workspaceId, id);
  } finally {
    await DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET lease_token = NULL, lease_until = NULL
      WHERE id = ? AND workspace_id = ? AND lease_token = ?`).bind(id, workspaceId, token).run();
  }
}

async function verifyDestinationRows(db: DB, workspaceId: string, table: SnapshotTable, rows: SnapshotRow[]) {
  const source = table === 'contact_group_members'
    ? (await db.prepare(`SELECT * FROM contact_group_members WHERE workspace_id = ? AND
      (${rows.map(() => '(contact_id = ? AND group_id = ?)').join(' OR ')}) ORDER BY contact_id, group_id`)
      .bind(workspaceId, ...rows.flatMap((row) => [row.contact_id, row.group_id])).all<SnapshotRow>()).results
    : (await db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? AND id IN
      (${rows.map(() => '?').join(', ')}) ORDER BY id`)
      .bind(workspaceId, ...rows.map((row) => row.id)).all<SnapshotRow>()).results;
  const columns = snapshotColumns(table);
  if (source.length !== rows.length || rows.some((row, index) => columns.some((column) =>
    source[index][column.name] !== row[column.name]))) {
    throw new CloudRecoveryError(`Restored ${table} rows do not match the verified snapshot.`, 409);
  }
}

async function verifyDestinationGraph(db: DB, workspaceId: string, expected: Record<SnapshotTable, number>) {
  const contactTables = SNAPSHOT_TABLES.filter((table) => snapshotColumns(table)
    .some((column) => column.name === 'contact_id'));
  const referenceChecks = [
    ...contactTables.map((table) => `SELECT 1 FROM ${table} item LEFT JOIN contacts target
      ON target.id = item.contact_id AND target.workspace_id = item.workspace_id
      WHERE item.workspace_id = ? AND target.id IS NULL LIMIT 1`),
    `SELECT 1 FROM contact_group_members item LEFT JOIN contact_groups target
      ON target.id = item.group_id AND target.workspace_id = item.workspace_id
      WHERE item.workspace_id = ? AND target.id IS NULL LIMIT 1`,
    `SELECT 1 FROM contact_relationships item LEFT JOIN contacts target
      ON target.id = item.related_contact_id AND target.workspace_id = item.workspace_id
      WHERE item.workspace_id = ? AND (target.id IS NULL OR item.contact_id = item.related_contact_id) LIMIT 1`,
    `SELECT 1 FROM contact_relationships WHERE workspace_id = ?
      GROUP BY MIN(contact_id, related_contact_id), MAX(contact_id, related_contact_id)
      HAVING COUNT(*) > 1 LIMIT 1`,
    `SELECT 1 FROM contact_children item LEFT JOIN contacts target
      ON target.id = item.linked_contact_id AND target.workspace_id = item.workspace_id
      WHERE item.workspace_id = ? AND item.linked_contact_id IS NOT NULL
        AND (target.id IS NULL OR item.contact_id = item.linked_contact_id) LIMIT 1`,
    `SELECT 1 FROM contact_children WHERE workspace_id = ? AND linked_contact_id IS NOT NULL
      GROUP BY contact_id, linked_contact_id HAVING COUNT(*) > 1 LIMIT 1`,
    `SELECT 1 FROM daily_snoozes item LEFT JOIN reminders target
      ON target.id = item.reminder_id AND target.workspace_id = item.workspace_id
      WHERE item.workspace_id = ? AND item.reminder_id IS NOT NULL
        AND (target.id IS NULL OR target.contact_id <> item.contact_id) LIMIT 1`,
  ];
  const results: Array<{ results: unknown[] }> = await db.batch([
    ...SNAPSHOT_TABLES.map((table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`).bind(workspaceId)),
    ...referenceChecks.map((sql) => db.prepare(sql).bind(workspaceId)),
  ]);
  for (const [index, table] of SNAPSHOT_TABLES.entries()) {
    const count = Number((results[index].results[0] as { count: number }).count);
    if (!Number.isSafeInteger(count) || count !== expected[table]) {
      throw new CloudRecoveryError(`Restored ${table} count does not match the snapshot.`, 409);
    }
  }
  if (results.slice(SNAPSHOT_TABLES.length).some((result) => result.results.length > 0)) {
    throw new CloudRecoveryError('Restored CRM graph contains broken references.', 409);
  }
}

export async function advanceCloudSnapshotRestoreVerification(workspaceId: string, id: string,
  env: Env): Promise<SnapshotRestorePreparation> {
  const { DB, PRIVATE_ASSETS } = env;
  const now = new Date();
  const token = crypto.randomUUID();
  const job = await DB.prepare(`UPDATE cloud_snapshot_restore_jobs
    SET lease_token = ?, lease_until = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND state = 'verifying'
      AND (lease_token IS NULL OR lease_until < ?)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'restoring')
    RETURNING *`)
    .bind(token, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString(),
      id, workspaceId, now.toISOString(), workspaceId).first<SnapshotRestorePreparation>();
  if (!job) {
    const current = await getJob(DB, workspaceId, id);
    if (current.state === 'completed' || current.state === 'rolled_back') return current;
    throw new CloudRecoveryError('Another restore verification step is running, or the workspace is unavailable.', 409);
  }
  const guard = () => maintenanceGuard(DB, `${token}-verify`, `EXISTS (
    SELECT 1 FROM cloud_snapshot_restore_jobs job JOIN workspaces workspace ON workspace.id = job.workspace_id
    WHERE job.id = ? AND job.workspace_id = ? AND job.state = 'verifying'
      AND job.lease_token = ? AND job.apply_source = ?
      AND job.apply_table_index = ? AND workspace.lifecycle = 'restoring'
  )`, [id, workspaceId, token, job.apply_source, job.apply_table_index]);
  try {
    const { captureId } = sourceIds(job);
    const capture = await DB.prepare(`SELECT revision, manifest_sha256 FROM cloud_snapshot_capture_jobs
      WHERE id = ? AND workspace_id = ? AND state = 'manifest_ready'`)
      .bind(captureId, workspaceId)
      .first<{ revision: number; manifest_sha256: string }>();
    if (!capture?.manifest_sha256) throw new CloudRecoveryError('Restore snapshot is unavailable.', 409);
    const root = await readPrivateSnapshotRoot({ workspaceId, jobId: captureId },
      capture.manifest_sha256, PRIVATE_ASSETS);
    if (root.revision !== capture.revision || job.apply_table_index < 0
      || job.apply_table_index > root.chunkCount) throw new CloudRecoveryError('Restore verification cursor is invalid.', 409);
    if (job.apply_table_index < root.chunkCount) {
      const index = job.apply_table_index;
      const partIndex = Math.floor(index / MANIFEST_PART_CHUNKS);
      const part = await readPrivateSnapshotPart(root, partIndex, PRIVATE_ASSETS);
      const descriptor = part.chunks[index % MANIFEST_PART_CHUNKS];
      if (!descriptor || descriptor.sequence !== index) throw new CloudRecoveryError('Restore verification chunk is missing.', 409);
      const previousIndex = index - 1;
      const previousPart = previousIndex < 0 ? null
        : Math.floor(previousIndex / MANIFEST_PART_CHUNKS) === partIndex ? part
          : await readPrivateSnapshotPart(root, partIndex - 1, PRIVATE_ASSETS);
      const previous = previousPart?.chunks[previousIndex % MANIFEST_PART_CHUNKS];
      if (previousIndex >= 0 && !previous) throw new CloudRecoveryError('Previous verification cursor is unavailable.', 409);
      const { rows } = await readPrivateSnapshotChunk(root, descriptor,
        { tableIndex: previous ? SNAPSHOT_TABLES.indexOf(previous.table_name) : -1,
          cursorKey: previous?.cursor_key || '' }, PRIVATE_ASSETS);
      await verifyDestinationRows(DB, workspaceId, descriptor.table_name, rows);
      await DB.batch([
        guard(),
        DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET apply_table_index = apply_table_index + 1,
          lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND lease_token = ?`)
          .bind(new Date().toISOString(), id, workspaceId, token),
        removeGuard(DB, `${token}-verify`),
      ]);
      return getJob(DB, workspaceId, id);
    }
    const counts = checkedApplyCounts(job.apply_row_counts);
    if (job.apply_chunk_index !== root.chunkCount || job.apply_row_index !== 0
      || job.apply_part_chain !== root.partsChainSha256
      || SNAPSHOT_TABLES.some((table) => (counts[table] || 0) !== root.rowCounts[table])) {
      throw new CloudRecoveryError('Restore counts or manifest chain changed before completion.', 409);
    }
    const pendingReceipt = await DB.prepare(`SELECT 1 FROM mutation_receipts
      WHERE workspace_id = ? AND resource_id IS NOT NULL LIMIT 1`).bind(workspaceId).first();
    if (pendingReceipt) {
      await DB.batch([
        guard(),
        DB.prepare(`UPDATE mutation_receipts SET resource_id = NULL WHERE rowid IN (
          SELECT rowid FROM mutation_receipts WHERE workspace_id = ? AND resource_id IS NOT NULL
          ORDER BY rowid LIMIT 64) AND workspace_id = ?`).bind(workspaceId, workspaceId),
        removeGuard(DB, `${token}-verify`),
      ]);
      return getJob(DB, workspaceId, id);
    }
    const pendingImport = await DB.prepare(`SELECT 1 FROM contact_import_jobs
      WHERE workspace_id = ? AND state IN ('preparing', 'review', 'importing') LIMIT 1`)
      .bind(workspaceId).first();
    if (pendingImport) {
      await DB.batch([
        guard(),
        DB.prepare(`UPDATE contact_import_jobs SET state = 'cancelled', updated_at = ? WHERE rowid IN (
          SELECT rowid FROM contact_import_jobs WHERE workspace_id = ?
            AND state IN ('preparing', 'review', 'importing') ORDER BY rowid LIMIT 64) AND workspace_id = ?`)
          .bind(new Date().toISOString(), workspaceId, workspaceId),
        removeGuard(DB, `${token}-verify`),
      ]);
      return getJob(DB, workspaceId, id);
    }
    await verifyDestinationGraph(DB, workspaceId, root.rowCounts);
    const completedAt = new Date().toISOString();
    await DB.batch([
      guard(),
      DB.prepare("UPDATE workspaces SET name = ?, persona = ?, lifecycle = 'active' WHERE id = ? AND lifecycle = 'restoring'")
        .bind(root.workspace.name, root.workspace.persona, workspaceId),
      DB.prepare(`UPDATE reminder_email_preferences SET enabled = 0, enabled_at = NULL,
        updated_at = ? WHERE workspace_id = ?`).bind(completedAt, workspaceId),
      DB.prepare(`UPDATE cloud_backup_schedules SET next_attempt_at = ?, lease_until = NULL,
        last_failure_code = NULL, updated_at = ? WHERE workspace_id = ?`)
        .bind(completedAt, completedAt, workspaceId),
      DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET state = ?,
        background_state = 'complete', background_version = background_version + 1,
        lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND lease_token = ?`)
        .bind(job.apply_source === 'rollback' ? 'rolled_back' : 'completed', completedAt, id, workspaceId, token),
      removeGuard(DB, `${token}-verify`),
    ]);
    return getJob(DB, workspaceId, id);
  } finally {
    await DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET lease_token = NULL, lease_until = NULL
      WHERE id = ? AND workspace_id = ? AND lease_token = ?`).bind(id, workspaceId, token).run();
  }
}
