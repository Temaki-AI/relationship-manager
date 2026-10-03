import { getCloudflareContext } from '@opennextjs/cloudflare';
import { readCloudObject } from '@/lib/cloud/request';
import { CloudRecoveryError, recoveryErrorResponse } from '@/lib/cloud/recovery-contract';
import { beginCloudSnapshotCapture, advanceCloudSnapshotCapture, discardCloudSnapshotCapture,
  type SnapshotCaptureJob } from '@/lib/cloud/snapshot-capture';
import { advanceCloudSnapshotVerification } from '@/lib/cloud/snapshot-manifest';
import { beginCloudSnapshotRestorePreparation, advanceCloudSnapshotRestorePreparation,
  cancelCloudSnapshotRestorePreparation, type SnapshotRestorePreparation } from '@/lib/cloud/snapshot-restore-preparation';
import { beginCloudSnapshotRestoreApply, beginCloudSnapshotRestoreRollback,
  advanceCloudSnapshotRestoreDeletion, advanceCloudSnapshotRestoreWriting,
  advanceCloudSnapshotRestoreDateRepair, advanceCloudSnapshotRestoreVerification } from '@/lib/cloud/snapshot-restore-apply';
import { RequestBodyError } from '@/lib/request-body';
import { pauseCloudRestoreJob, publishCloudRestoreJob, resumeCloudRestoreJob } from '@/lib/cloud/large-recovery-queue';

type DB = CloudflareEnv['DB'];
type CaptureRow = SnapshotCaptureJob & { created_at: string; updated_at: string };
type RestoreRow = SnapshotRestorePreparation & { created_at: string; updated_at: string };
type Env = Pick<CloudflareEnv, 'DB' | 'PRIVATE_ASSETS'>;

const ID_PATTERN = /^[0-9a-f-]{36}$/i;
const ACTIVE_RESTORE_STATES = ['preparing', 'ready', 'deleting', 'awaiting_write',
  'writing', 'repairing_dates', 'verifying'];

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function contactCount(raw: string): number {
  try {
    const count = (JSON.parse(raw) as { contacts?: unknown }).contacts;
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0;
  } catch { return 0; }
}

function publicCapture(job: CaptureRow) {
  return { id: job.id, state: job.state, contactCount: contactCount(job.row_counts),
    chunkCount: job.chunk_count, createdAt: job.created_at, updatedAt: job.updated_at };
}

function publicRestore(job: RestoreRow) {
  return { id: job.id, state: job.state, source: job.apply_source,
    background: job.background_state,
    targetCaptureId: job.target_capture_job_id, rollbackAvailable: Boolean(job.rollback_capture_job_id && job.rollback_read_job_id),
    tableIndex: job.apply_table_index, chunkIndex: job.apply_chunk_index, rowIndex: job.apply_row_index,
    createdAt: job.created_at, updatedAt: job.updated_at };
}

async function captureRow(db: DB, workspaceId: string, id: string): Promise<CaptureRow | null> {
  return db.prepare('SELECT * FROM cloud_snapshot_capture_jobs WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, id).first<CaptureRow>();
}

async function restoreRow(db: DB, workspaceId: string, id: string): Promise<RestoreRow | null> {
  return db.prepare('SELECT * FROM cloud_snapshot_restore_jobs WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, id).first<RestoreRow>();
}

async function status(db: DB, workspaceId: string, enabled: boolean) {
  const captures = await db.prepare(`SELECT * FROM cloud_snapshot_capture_jobs
    WHERE workspace_id = ? AND state IN ('capturing', 'awaiting_verification', 'manifest_ready')
      AND NOT EXISTS (SELECT 1 FROM cloud_snapshot_restore_jobs restore
        WHERE restore.rollback_capture_job_id = cloud_snapshot_capture_jobs.id)
    ORDER BY created_at DESC, id DESC LIMIT 20`).bind(workspaceId).all<CaptureRow>();
  const active = await db.prepare(`SELECT * FROM cloud_snapshot_restore_jobs
    WHERE workspace_id = ? AND state IN ('preparing', 'ready', 'deleting', 'awaiting_write',
      'writing', 'repairing_dates', 'verifying') ORDER BY created_at DESC LIMIT 1`)
    .bind(workspaceId).first<RestoreRow>();
  const recent = active || await db.prepare(`SELECT * FROM cloud_snapshot_restore_jobs
    WHERE workspace_id = ? AND state IN ('completed', 'rolled_back')
    ORDER BY updated_at DESC LIMIT 1`).bind(workspaceId).first<RestoreRow>();
  return { enabled, captures: captures.results.map(publicCapture), restore: recent ? publicRestore(recent) : null };
}

async function advanceJob(db: DB, workspaceId: string, id: string, env: Env): Promise<Response> {
  const restore = await restoreRow(db, workspaceId, id);
  if (restore) {
    let next: SnapshotRestorePreparation;
    if (restore.state === 'preparing') next = await advanceCloudSnapshotRestorePreparation(workspaceId, id, env);
    else if (restore.state === 'deleting') next = await advanceCloudSnapshotRestoreDeletion(workspaceId, id, db);
    else if (restore.state === 'awaiting_write' || restore.state === 'writing') {
      next = await advanceCloudSnapshotRestoreWriting(workspaceId, id, env);
    } else if (restore.state === 'repairing_dates') next = await advanceCloudSnapshotRestoreDateRepair(workspaceId, id, env);
    else if (restore.state === 'verifying') next = await advanceCloudSnapshotRestoreVerification(workspaceId, id, env);
    else if (restore.state === 'ready' || restore.state === 'completed' || restore.state === 'rolled_back') next = restore;
    else throw new CloudRecoveryError('This restore preparation is no longer usable.', 409);
    const saved = await restoreRow(db, workspaceId, next.id);
    if (!saved) throw new CloudRecoveryError('Restore job not found.', 404);
    return json({ restore: publicRestore(saved) },
      ACTIVE_RESTORE_STATES.includes(saved.state) && saved.state !== 'ready' ? 202 : 200);
  }
  const capture = await captureRow(db, workspaceId, id);
  if (!capture) throw new CloudRecoveryError('Recovery job not found.', 404);
  let next: SnapshotCaptureJob;
  if (capture.state === 'capturing') next = await advanceCloudSnapshotCapture(workspaceId, id, env);
  else if (capture.state === 'awaiting_verification') next = await advanceCloudSnapshotVerification(workspaceId, id, env);
  else if (capture.state === 'manifest_ready') next = capture;
  else throw new CloudRecoveryError('This snapshot capture is no longer usable.', 409);
  const saved = await captureRow(db, workspaceId, next.id);
  if (!saved) throw new CloudRecoveryError('Snapshot capture not found.', 404);
  return json({ capture: publicCapture(saved) }, saved.state === 'manifest_ready' ? 200 : 202);
}

export async function handleCloudLargeRecovery(request: Request, workspaceId: string, role: string,
  lifecycle: string, id?: string, action?: string): Promise<Response> {
  if (role !== 'owner') return json({ error: 'Only the workspace owner can manage recovery.' }, 403);
  const env = getCloudflareContext().env;
  const enabled = env.CLOUD_LARGE_RECOVERY_ENABLED === 'true';
  if (!enabled && lifecycle !== 'restoring') {
    return request.method === 'GET' && !id ? json({ enabled: false, captures: [], restore: null })
      : json({ error: 'Advanced recovery is not enabled.' }, 404);
  }
  if (id && !ID_PATTERN.test(id)) return json({ error: 'Invalid recovery job ID.' }, 400);
  const { DB } = env;
  try {
    if (request.method === 'GET' && !id && !action) return json(await status(DB, workspaceId, enabled));
    if (request.method === 'GET' && id && !action) {
      const restore = await restoreRow(DB, workspaceId, id);
      if (restore) return json({ restore: publicRestore(restore) });
      const capture = await captureRow(DB, workspaceId, id);
      if (capture) return json({ capture: publicCapture(capture) });
      throw new CloudRecoveryError('Recovery job not found.', 404);
    }
    if (request.method === 'POST' && !id && !action) {
      if (!enabled) throw new CloudRecoveryError('New recovery jobs are disabled while maintenance is in progress.', 409);
      const body = await readCloudObject(request);
      if (body.action === 'capture') {
        const job = await beginCloudSnapshotCapture(workspaceId, env);
        return json({ capture: publicCapture((await captureRow(DB, workspaceId, job.id))!) }, 201);
      }
      if (body.action === 'prepare' && typeof body.targetCaptureId === 'string'
        && ID_PATTERN.test(body.targetCaptureId) && body.confirmation === 'PREPARE') {
        const job = await beginCloudSnapshotRestorePreparation(workspaceId, body.targetCaptureId, env);
        return json({ restore: publicRestore((await restoreRow(DB, workspaceId, job.id))!) }, 201);
      }
      throw new CloudRecoveryError('Choose a snapshot and confirm preparation.', 400);
    }
    if (request.method === 'POST' && id && action === 'step') {
      const job = await restoreRow(DB, workspaceId, id);
      if (job && ACTIVE_RESTORE_STATES.includes(job.state) && job.state !== 'preparing'
        && job.state !== 'ready'
        && job.background_state !== 'running') {
        throw new CloudRecoveryError('Resume this restore before advancing more steps.', 409);
      }
      return await advanceJob(DB, workspaceId, id, env);
    }
    if (request.method === 'POST' && id && action === 'apply') {
      if (!enabled) throw new CloudRecoveryError('New restore applications are disabled.', 409);
      const body = await readCloudObject(request);
      if (body.confirmation !== 'RESTORE') throw new CloudRecoveryError('Type RESTORE to confirm replacement.', 400);
      const job = await beginCloudSnapshotRestoreApply(workspaceId, id, env);
      await publishCloudRestoreJob(env, job);
      return json({ restore: publicRestore((await restoreRow(DB, workspaceId, job.id))!) }, 202);
    }
    if (request.method === 'POST' && id && action === 'rollback') {
      const body = await readCloudObject(request);
      if (body.confirmation !== 'ROLL BACK') throw new CloudRecoveryError('Type ROLL BACK to confirm rollback.', 400);
      const job = await beginCloudSnapshotRestoreRollback(workspaceId, id, env);
      await publishCloudRestoreJob(env, job);
      return json({ restore: publicRestore((await restoreRow(DB, workspaceId, job.id))!) }, 202);
    }
    if (request.method === 'POST' && id && action === 'pause') {
      await pauseCloudRestoreJob(DB, workspaceId, id);
      return json({ restore: publicRestore((await restoreRow(DB, workspaceId, id))!) });
    }
    if (request.method === 'POST' && id && action === 'resume') {
      await resumeCloudRestoreJob(env, workspaceId, id);
      return json({ restore: publicRestore((await restoreRow(DB, workspaceId, id))!) }, 202);
    }
    if (request.method === 'POST' && id && action === 'cancel') {
      await cancelCloudSnapshotRestorePreparation(workspaceId, id, DB);
      return json({ cancelled: true });
    }
    if (request.method === 'DELETE' && id && !action) {
      const body = await readCloudObject(request);
      if (body.confirmation !== 'DELETE SNAPSHOT') throw new CloudRecoveryError('Type DELETE SNAPSHOT to confirm removal.', 400);
      const result = await discardCloudSnapshotCapture(workspaceId, id, env);
      return json({ deleted: !result.pending, pending: result.pending }, result.pending ? 202 : 200);
    }
    return json({ error: 'Method not allowed.' }, 405);
  } catch (error) {
    if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
    const response = recoveryErrorResponse(error);
    if (response) return response;
    console.error('cloud.large_recovery.failed', error);
    return json({ error: 'Recovery step could not finish. Refresh its status before retrying.' }, 503);
  }
}
