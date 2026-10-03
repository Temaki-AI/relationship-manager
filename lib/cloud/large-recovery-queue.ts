import { CloudRecoveryError } from '@/lib/cloud/recovery-contract';
import { advanceCloudSnapshotRestoreDeletion, advanceCloudSnapshotRestoreWriting,
  advanceCloudSnapshotRestoreDateRepair, advanceCloudSnapshotRestoreVerification } from '@/lib/cloud/snapshot-restore-apply';
import type { SnapshotRestorePreparation } from '@/lib/cloud/snapshot-restore-preparation';

type DB = CloudflareEnv['DB'];
type QueueBinding = CloudflareEnv['LARGE_RECOVERY_QUEUE'];
type Env = Pick<CloudflareEnv, 'DB' | 'PRIVATE_ASSETS' | 'LARGE_RECOVERY_QUEUE'>;

export type RecoveryQueueDelivery = {
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

export type RecoveryQueueMessage = {
  kind: 'restore';
  workspaceId: string;
  jobId: string;
  source: 'target' | 'rollback';
  version: number;
};

const ACTIVE_STATES = ['deleting', 'awaiting_write', 'writing', 'repairing_dates', 'verifying'] as const;
const TERMINAL_STATES = ['completed', 'rolled_back'] as const;
const ID_PATTERN = /^[0-9a-f-]{36}$/i;

function isActive(job: SnapshotRestorePreparation): boolean {
  return ACTIVE_STATES.includes(job.state as typeof ACTIVE_STATES[number]);
}

async function readJob(db: DB, workspaceId: string, jobId: string): Promise<SnapshotRestorePreparation | null> {
  return db.prepare('SELECT * FROM cloud_snapshot_restore_jobs WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, jobId).first<SnapshotRestorePreparation>();
}

function messageFor(job: SnapshotRestorePreparation): RecoveryQueueMessage {
  return { kind: 'restore', workspaceId: job.workspace_id, jobId: job.id,
    source: job.apply_source, version: job.background_version };
}

async function failRunningJob(db: DB, message: RecoveryQueueMessage): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE cloud_snapshot_restore_jobs
    SET background_state = 'failed', background_version = background_version + 1, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND apply_source = ? AND background_version = ?
      AND background_state = 'running'
      AND state IN ('deleting', 'awaiting_write', 'writing', 'repairing_dates', 'verifying')`)
    .bind(now, message.jobId, message.workspaceId, message.source, message.version).run();
}

export async function publishCloudRestoreJob(env: Env, job: SnapshotRestorePreparation): Promise<void> {
  if (!isActive(job) || job.background_state !== 'running') return;
  const message = messageFor(job);
  try {
    await env.LARGE_RECOVERY_QUEUE.send(message);
  } catch {
    await failRunningJob(env.DB, message);
    throw new CloudRecoveryError('Background recovery could not start. Resume it from Advanced recovery.', 503);
  }
}

export async function pauseCloudRestoreJob(db: DB, workspaceId: string, jobId: string): Promise<SnapshotRestorePreparation> {
  const now = new Date().toISOString();
  const updated = await db.prepare(`UPDATE cloud_snapshot_restore_jobs
    SET background_state = 'paused', background_version = background_version + 1, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND background_state = 'running'
      AND state IN ('deleting', 'awaiting_write', 'writing', 'repairing_dates', 'verifying') RETURNING *`)
    .bind(now, jobId, workspaceId).first<SnapshotRestorePreparation>();
  if (updated) return updated;
  const current = await readJob(db, workspaceId, jobId);
  if (!current) throw new CloudRecoveryError('Restore job not found.', 404);
  if (isActive(current) && current.background_state === 'paused') return current;
  throw new CloudRecoveryError('Only a running restore can be paused.', 409);
}

export async function resumeCloudRestoreJob(env: Env, workspaceId: string, jobId: string): Promise<SnapshotRestorePreparation> {
  const now = new Date().toISOString();
  const updated = await env.DB.prepare(`UPDATE cloud_snapshot_restore_jobs
    SET background_state = 'running', background_version = background_version + 1, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND background_state IN ('paused', 'failed')
      AND state IN ('deleting', 'awaiting_write', 'writing', 'repairing_dates', 'verifying')
    RETURNING *`).bind(now, jobId, workspaceId).first<SnapshotRestorePreparation>();
  if (!updated) {
    const current = await readJob(env.DB, workspaceId, jobId);
    if (!current) throw new CloudRecoveryError('Restore job not found.', 404);
    if (isActive(current) && current.background_state === 'running') return current;
    throw new CloudRecoveryError('This restore cannot be resumed.', 409);
  }
  await publishCloudRestoreJob(env, updated);
  return updated;
}

function validMessage(value: unknown): value is RecoveryQueueMessage {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return body.kind === 'restore' && typeof body.workspaceId === 'string' && body.workspaceId.length > 0
    && typeof body.jobId === 'string' && ID_PATTERN.test(body.jobId)
    && (body.source === 'target' || body.source === 'rollback')
    && typeof body.version === 'number' && Number.isSafeInteger(body.version) && body.version > 0;
}

async function advanceJob(env: Env, job: SnapshotRestorePreparation): Promise<void> {
  if (job.state === 'deleting') await advanceCloudSnapshotRestoreDeletion(job.workspace_id, job.id, env.DB);
  else if (job.state === 'awaiting_write' || job.state === 'writing') {
    await advanceCloudSnapshotRestoreWriting(job.workspace_id, job.id, env);
  } else if (job.state === 'repairing_dates') await advanceCloudSnapshotRestoreDateRepair(job.workspace_id, job.id, env);
  else if (job.state === 'verifying') await advanceCloudSnapshotRestoreVerification(job.workspace_id, job.id, env);
}

export async function processCloudRestoreMessage(message: RecoveryQueueDelivery, env: Env): Promise<void> {
  if (!validMessage(message.body)) {
    console.warn('cloud.restore.queue.invalid_message');
    message.ack();
    return;
  }
  const body = message.body;
  const job = await readJob(env.DB, body.workspaceId, body.jobId);
  if (!job || !isActive(job) || job.background_state !== 'running'
    || job.apply_source !== body.source || job.background_version !== body.version) {
    message.ack();
    return;
  }

  try {
    await advanceJob(env, job);
    const current = await readJob(env.DB, body.workspaceId, body.jobId);
    if (!current || current.background_state !== 'running' || current.apply_source !== body.source
      || current.background_version !== body.version) {
      message.ack();
      return;
    }
    if (TERMINAL_STATES.includes(current.state as typeof TERMINAL_STATES[number])) {
      await env.DB.prepare(`UPDATE cloud_snapshot_restore_jobs
        SET background_state = 'complete', background_version = background_version + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND background_state = 'running'
          AND apply_source = ? AND background_version = ?`)
        .bind(new Date().toISOString(), body.jobId, body.workspaceId, body.source, body.version).run();
      message.ack();
      return;
    }
    if (!isActive(current)) {
      message.ack();
      return;
    }
    const next = await env.DB.prepare(`UPDATE cloud_snapshot_restore_jobs
      SET background_version = background_version + 1, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND background_state = 'running'
        AND apply_source = ? AND background_version = ?
        AND state IN ('deleting', 'awaiting_write', 'writing', 'repairing_dates', 'verifying')
      RETURNING *`).bind(new Date().toISOString(), body.jobId, body.workspaceId,
      body.source, body.version).first<SnapshotRestorePreparation>();
    if (next) {
      try {
        await env.LARGE_RECOVERY_QUEUE.send(messageFor(next));
      } catch {
        await failRunningJob(env.DB, messageFor(next));
        console.error('cloud.restore.queue.publish_failed');
      }
    }
    message.ack();
  } catch (error) {
    if (message.attempts >= 10) {
      await failRunningJob(env.DB, body);
      console.error('cloud.restore.queue.exhausted', { errorName: error instanceof Error ? error.name : 'unknown' });
    }
    message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(message.attempts, 6)) });
  }
}

export async function reconcileStalledCloudRestoreJobs(db: DB, queue: QueueBinding, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 3 * 60_000).toISOString();
  const jobs = await db.prepare(`SELECT job.* FROM cloud_snapshot_restore_jobs job
    JOIN workspaces workspace ON workspace.id = job.workspace_id
    WHERE workspace.lifecycle = 'restoring' AND job.background_state = 'running'
      AND job.state IN ('deleting', 'awaiting_write', 'writing', 'repairing_dates', 'verifying')
      AND job.updated_at < ? AND (job.lease_token IS NULL OR job.lease_until < ?)
    ORDER BY job.updated_at, job.id LIMIT 10`).bind(cutoff, now.toISOString()).all<SnapshotRestorePreparation>();
  let published = 0;
  for (const job of jobs.results) {
    await queue.send(messageFor(job));
    published++;
  }
  return published;
}
