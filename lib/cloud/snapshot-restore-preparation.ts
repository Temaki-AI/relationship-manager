import { maintenanceGuard, removeGuard } from '@/lib/cloud/recovery-storage';
import { CloudRecoveryError } from '@/lib/cloud/recovery-contract';
import { advanceCloudSnapshotCapture, beginCloudSnapshotCapture, type SnapshotCaptureJob } from '@/lib/cloud/snapshot-capture';
import { advanceCloudSnapshotVerification } from '@/lib/cloud/snapshot-manifest';
import { advanceCloudSnapshotRead, beginCloudSnapshotRead, type SnapshotReadJob } from '@/lib/cloud/snapshot-reader';

type DB = CloudflareEnv['DB'];
type Assets = CloudflareEnv['PRIVATE_ASSETS'];
type Env = { DB: DB; PRIVATE_ASSETS: Assets };

export type SnapshotRestorePreparation = {
  id: string;
  workspace_id: string;
  target_capture_job_id: string;
  target_read_job_id: string | null;
  rollback_capture_job_id: string | null;
  rollback_read_job_id: string | null;
  base_revision: number;
  state: 'preparing' | 'ready' | 'deleting' | 'awaiting_write' | 'writing' | 'repairing_dates' | 'verifying' | 'completed' | 'rolled_back' | 'invalid';
  apply_source: 'target' | 'rollback';
  apply_table_index: number;
  apply_chunk_index: number;
  apply_row_index: number;
  apply_part_chain: string;
  apply_row_counts: string;
  background_state: 'idle' | 'running' | 'paused' | 'failed' | 'complete';
  background_version: number;
  lease_token: string | null;
  lease_until: string | null;
};

const LEASE_MS = 5 * 60_000;

async function getJob(db: DB, workspaceId: string, id: string): Promise<SnapshotRestorePreparation> {
  const job = await db.prepare('SELECT * FROM cloud_snapshot_restore_jobs WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, id).first<SnapshotRestorePreparation>();
  if (!job) throw new CloudRecoveryError('Restore preparation not found.', 404);
  return job;
}

async function linkedCapture(db: DB, workspaceId: string, id: string): Promise<SnapshotCaptureJob> {
  const job = await db.prepare('SELECT * FROM cloud_snapshot_capture_jobs WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, id).first<SnapshotCaptureJob>();
  if (!job) throw new CloudRecoveryError('Rollback capture is unavailable.', 409);
  return job;
}

async function linkedRead(db: DB, workspaceId: string, id: string): Promise<SnapshotReadJob> {
  const job = await db.prepare('SELECT * FROM cloud_snapshot_read_jobs WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, id).first<SnapshotReadJob>();
  if (!job) throw new CloudRecoveryError('Snapshot validation is unavailable.', 409);
  return job;
}

async function commitStep(db: DB, job: SnapshotRestorePreparation, token: string,
  fields: Partial<Pick<SnapshotRestorePreparation, 'target_read_job_id' | 'rollback_capture_job_id' | 'rollback_read_job_id' | 'state'>>) {
  const names = Object.keys(fields) as Array<keyof typeof fields>;
  const guardToken = `${token}-restore`;
  const readyChecks = fields.state === 'ready' ? `AND EXISTS (
        SELECT 1 FROM cloud_snapshot_read_jobs target
        JOIN cloud_snapshot_read_jobs rollback ON rollback.id = job.rollback_read_job_id
        JOIN cloud_snapshot_capture_jobs capture ON capture.id = job.rollback_capture_job_id
        JOIN cloud_snapshot_capture_jobs source ON source.id = job.target_capture_job_id
        WHERE target.id = job.target_read_job_id AND target.state = 'verified'
          AND target.workspace_id = job.workspace_id AND target.capture_job_id = job.target_capture_job_id
          AND source.workspace_id = job.workspace_id AND source.state = 'manifest_ready'
          AND source.manifest_sha256 = target.manifest_sha256
          AND rollback.state = 'verified' AND rollback.workspace_id = job.workspace_id
          AND rollback.capture_job_id = capture.id AND capture.state = 'manifest_ready'
          AND rollback.manifest_sha256 = capture.manifest_sha256
          AND capture.workspace_id = job.workspace_id AND capture.revision = job.base_revision
      )` : '';
  await db.batch([
    maintenanceGuard(db, guardToken, `EXISTS (
      SELECT 1 FROM cloud_snapshot_restore_jobs job JOIN workspaces workspace ON workspace.id = job.workspace_id
      WHERE job.id = ? AND job.workspace_id = ? AND job.state = 'preparing' AND job.lease_token = ?
        AND workspace.lifecycle = 'active' AND workspace.recovery_revision = job.base_revision
        ${readyChecks}
    )`, [job.id, job.workspace_id, token]),
    db.prepare(`UPDATE cloud_snapshot_restore_jobs SET ${names.map((name) => `${name} = ?`).join(', ')},
      lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND lease_token = ?`)
      .bind(...names.map((name) => fields[name]), new Date().toISOString(), job.id, job.workspace_id, token),
    removeGuard(db, guardToken),
  ]);
}

export async function beginCloudSnapshotRestorePreparation(workspaceId: string, targetCaptureJobId: string,
  env: Env): Promise<SnapshotRestorePreparation> {
  let existing = await env.DB.prepare(`SELECT * FROM cloud_snapshot_restore_jobs
    WHERE workspace_id = ? AND state NOT IN ('invalid', 'completed', 'rolled_back') LIMIT 1`)
    .bind(workspaceId).first<SnapshotRestorePreparation>();
  if (existing?.state === 'preparing' || existing?.state === 'ready') {
    const workspace = await env.DB.prepare('SELECT recovery_revision, lifecycle FROM workspaces WHERE id = ?')
      .bind(workspaceId).first<{ recovery_revision: number; lifecycle: string }>();
    if (workspace?.recovery_revision !== existing.base_revision || workspace.lifecycle !== 'active') {
      await env.DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET state = 'invalid', updated_at = ?
        WHERE id = ? AND workspace_id = ? AND state IN ('preparing', 'ready')
          AND (lease_token IS NULL OR lease_until < ?)`)
        .bind(new Date().toISOString(), existing.id, workspaceId, new Date().toISOString()).run();
      existing = null;
    }
  }
  if (existing) {
    if ((existing.state === 'preparing' || existing.state === 'ready')
      && existing.target_capture_job_id === targetCaptureJobId) return existing;
    throw new CloudRecoveryError('Finish or cancel the current restore preparation first.', 409);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO cloud_snapshot_restore_jobs
    (id, workspace_id, target_capture_job_id, base_revision)
    SELECT ?, workspace.id, capture.id, workspace.recovery_revision
    FROM workspaces workspace JOIN cloud_snapshot_capture_jobs capture
      ON capture.workspace_id = workspace.id
    WHERE workspace.id = ? AND workspace.lifecycle = 'active'
      AND capture.id = ? AND capture.state = 'manifest_ready'
      AND NOT EXISTS (SELECT 1 FROM cloud_snapshot_restore_jobs
        WHERE workspace_id = workspace.id AND state NOT IN ('invalid', 'completed', 'rolled_back'))`)
    .bind(id, workspaceId, targetCaptureJobId).run();
  const created = await env.DB.prepare(`SELECT * FROM cloud_snapshot_restore_jobs WHERE id = ? AND workspace_id = ?`)
    .bind(id, workspaceId).first<SnapshotRestorePreparation>();
  if (created) return created;
  throw new CloudRecoveryError('Snapshot is unavailable or another preparation is running.', 409);
}

export async function advanceCloudSnapshotRestorePreparation(workspaceId: string, id: string,
  env: Env): Promise<SnapshotRestorePreparation> {
  const now = new Date();
  const token = crypto.randomUUID();
  const job = await env.DB.prepare(`UPDATE cloud_snapshot_restore_jobs
    SET lease_token = ?, lease_until = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND state = 'preparing'
      AND (lease_token IS NULL OR lease_until < ?)
      AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active'
        AND recovery_revision = cloud_snapshot_restore_jobs.base_revision)
    RETURNING *`)
    .bind(token, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString(),
      id, workspaceId, now.toISOString(), workspaceId).first<SnapshotRestorePreparation>();
  if (!job) {
    const current = await getJob(env.DB, workspaceId, id);
    if (current.state === 'invalid') throw new CloudRecoveryError('Restore preparation was cancelled.', 409);
    if (current.state !== 'preparing' && current.state !== 'ready') {
      throw new CloudRecoveryError('Restore application has already started.', 409);
    }
    const workspace = await env.DB.prepare('SELECT recovery_revision, lifecycle FROM workspaces WHERE id = ?')
      .bind(workspaceId).first<{ recovery_revision: number; lifecycle: string }>();
    if (workspace?.recovery_revision !== current.base_revision || workspace.lifecycle !== 'active') {
      await env.DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET state = 'invalid', updated_at = ?
        WHERE id = ? AND workspace_id = ? AND state IN ('preparing', 'ready')
          AND (lease_token IS NULL OR lease_until < ?)`)
        .bind(now.toISOString(), id, workspaceId, now.toISOString()).run();
      throw new CloudRecoveryError('Workspace changed during restore preparation. Start again.', 409);
    }
    if (current.state === 'ready') return current;
    throw new CloudRecoveryError('Another restore preparation step is running. Retry shortly.', 409);
  }
  try {
    if (!job.target_read_job_id) {
      const read = await beginCloudSnapshotRead(workspaceId, job.target_capture_job_id, env);
      await commitStep(env.DB, job, token, { target_read_job_id: read.id });
    } else {
      const target = await linkedRead(env.DB, workspaceId, job.target_read_job_id);
      if (target.state === 'invalid') throw new CloudRecoveryError('Target snapshot validation failed.', 409);
      if (target.state !== 'verified') {
        await advanceCloudSnapshotRead(workspaceId, target.id, env);
      } else if (!job.rollback_capture_job_id) {
        const capture = await beginCloudSnapshotCapture(workspaceId, env);
        if (capture.revision !== job.base_revision) throw new CloudRecoveryError('Workspace changed during rollback capture.', 409);
        await commitStep(env.DB, job, token, { rollback_capture_job_id: capture.id });
      } else {
        const capture = await linkedCapture(env.DB, workspaceId, job.rollback_capture_job_id);
        if (capture.state === 'invalid') throw new CloudRecoveryError('Rollback capture is invalid.', 409);
        if (capture.state === 'capturing') {
          await advanceCloudSnapshotCapture(workspaceId, capture.id, env);
        } else if (capture.state === 'awaiting_verification') {
          await advanceCloudSnapshotVerification(workspaceId, capture.id, env);
        } else if (!job.rollback_read_job_id) {
          const read = await beginCloudSnapshotRead(workspaceId, capture.id, env);
          await commitStep(env.DB, job, token, { rollback_read_job_id: read.id });
        } else {
          const rollback = await linkedRead(env.DB, workspaceId, job.rollback_read_job_id);
          if (rollback.state === 'invalid') throw new CloudRecoveryError('Rollback snapshot validation failed.', 409);
          if (rollback.state !== 'verified') await advanceCloudSnapshotRead(workspaceId, rollback.id, env);
          else await commitStep(env.DB, job, token, { state: 'ready' });
        }
      }
    }
    return getJob(env.DB, workspaceId, id);
  } finally {
    await env.DB.prepare(`UPDATE cloud_snapshot_restore_jobs SET lease_token = NULL, lease_until = NULL
      WHERE id = ? AND workspace_id = ? AND lease_token = ?`).bind(id, workspaceId, token).run();
  }
}

export async function cancelCloudSnapshotRestorePreparation(workspaceId: string, id: string, db: DB): Promise<void> {
  const now = new Date().toISOString();
  const removed = await db.prepare(`DELETE FROM cloud_snapshot_restore_jobs
    WHERE id = ? AND workspace_id = ? AND state IN ('preparing', 'ready', 'invalid')
      AND (lease_token IS NULL OR lease_until < ?) RETURNING id`)
    .bind(id, workspaceId, now).first<{ id: string }>();
  if (removed) return;
  await getJob(db, workspaceId, id);
  throw new CloudRecoveryError('Restore preparation is running. Retry cancellation when the lease expires.', 409);
}
