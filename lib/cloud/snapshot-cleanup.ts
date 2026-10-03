import { CloudRecoveryError } from '@/lib/cloud/recovery-contract';
import { discardCloudSnapshotCapture } from '@/lib/cloud/snapshot-capture';

type DB = CloudflareEnv['DB'];
type Assets = CloudflareEnv['PRIVATE_ASSETS'];

const UNFINISHED_IDLE_MS = 7 * 24 * 60 * 60_000;
const TERMINAL_RESTORE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const READ_IDLE_MS = 24 * 60 * 60_000;
const CAPTURE_JOBS_PER_RUN = 4;
const READ_JOBS_PER_RUN = 20;
const DISCARD_PAGES_PER_JOB = 4;

export async function cleanupStaleCloudSnapshotArtifacts(db: DB, assets: Assets, now = new Date()) {
  const nowIso = now.toISOString();
  const unfinishedCutoff = new Date(now.getTime() - UNFINISHED_IDLE_MS).toISOString();
  const terminalCutoff = new Date(now.getTime() - TERMINAL_RESTORE_RETENTION_MS).toISOString();
  const readCutoff = new Date(now.getTime() - READ_IDLE_MS).toISOString();
  const terminalRestores = await db.prepare(`DELETE FROM cloud_snapshot_restore_jobs WHERE id IN (
    SELECT id FROM cloud_snapshot_restore_jobs
    WHERE state IN ('completed', 'rolled_back') AND julianday(updated_at) <= julianday(?)
      AND (lease_token IS NULL OR lease_until < ?)
    ORDER BY updated_at, id LIMIT ?)
    AND state IN ('completed', 'rolled_back') AND (lease_token IS NULL OR lease_until < ?) RETURNING id`)
    .bind(terminalCutoff, nowIso, CAPTURE_JOBS_PER_RUN, nowIso).all<{ id: string }>();
  const stalePreparations = await db.prepare(`DELETE FROM cloud_snapshot_restore_jobs WHERE id IN (
    SELECT job.id FROM cloud_snapshot_restore_jobs job JOIN workspaces workspace ON workspace.id = job.workspace_id
    WHERE job.state IN ('preparing', 'ready', 'invalid')
      AND (julianday(job.updated_at) <= julianday(?)
        OR workspace.lifecycle <> 'active' OR workspace.recovery_revision <> job.base_revision)
      AND (job.lease_token IS NULL OR job.lease_until < ?)
    ORDER BY job.updated_at, job.id LIMIT ?)
    AND state IN ('preparing', 'ready', 'invalid') AND (lease_token IS NULL OR lease_until < ?) RETURNING id`)
    .bind(unfinishedCutoff, nowIso, CAPTURE_JOBS_PER_RUN, nowIso).all<{ id: string }>();
  const removedReads = await db.prepare(`DELETE FROM cloud_snapshot_read_jobs WHERE id IN (
    SELECT id FROM cloud_snapshot_read_jobs
    WHERE julianday(updated_at) <= julianday(?)
      AND (lease_token IS NULL OR lease_until < ?)
      AND NOT EXISTS (SELECT 1 FROM cloud_snapshot_restore_jobs restore
        WHERE restore.target_read_job_id = cloud_snapshot_read_jobs.id
            OR restore.rollback_read_job_id = cloud_snapshot_read_jobs.id)
    ORDER BY updated_at, id LIMIT ?)
    AND (lease_token IS NULL OR lease_until < ?)
    AND NOT EXISTS (SELECT 1 FROM cloud_snapshot_restore_jobs restore
      WHERE restore.target_read_job_id = cloud_snapshot_read_jobs.id
          OR restore.rollback_read_job_id = cloud_snapshot_read_jobs.id) RETURNING id`)
    .bind(readCutoff, nowIso, READ_JOBS_PER_RUN, nowIso).all<{ id: string }>();
  const invalidated = await db.prepare(`UPDATE cloud_snapshot_capture_jobs SET state = 'invalid', updated_at = ?
    WHERE id IN (
      SELECT id FROM cloud_snapshot_capture_jobs
      WHERE state IN ('capturing', 'awaiting_verification')
        AND julianday(updated_at) <= julianday(?)
        AND (lease_token IS NULL OR lease_until < ?)
        AND NOT EXISTS (SELECT 1 FROM cloud_snapshot_restore_jobs restore
          WHERE restore.target_capture_job_id = cloud_snapshot_capture_jobs.id
              OR restore.rollback_capture_job_id = cloud_snapshot_capture_jobs.id)
      ORDER BY updated_at, id LIMIT ?)
      AND state IN ('capturing', 'awaiting_verification')
      AND (lease_token IS NULL OR lease_until < ?)
      AND NOT EXISTS (SELECT 1 FROM cloud_snapshot_restore_jobs restore
        WHERE restore.target_capture_job_id = cloud_snapshot_capture_jobs.id
            OR restore.rollback_capture_job_id = cloud_snapshot_capture_jobs.id)
    RETURNING id`).bind(nowIso, unfinishedCutoff, nowIso, CAPTURE_JOBS_PER_RUN, nowIso)
    .all<{ id: string }>();
  const candidates = await db.prepare(`SELECT id, workspace_id FROM cloud_snapshot_capture_jobs
    WHERE state = 'invalid' AND (lease_token IS NULL OR lease_until < ?)
      AND NOT EXISTS (SELECT 1 FROM cloud_snapshot_restore_jobs restore
        WHERE restore.target_capture_job_id = cloud_snapshot_capture_jobs.id
            OR restore.rollback_capture_job_id = cloud_snapshot_capture_jobs.id)
    ORDER BY updated_at, id LIMIT ?`).bind(nowIso, CAPTURE_JOBS_PER_RUN)
    .all<{ id: string; workspace_id: string }>();
  const result = { terminalRestoreJobsRemoved: terminalRestores.results.length,
    restorePreparationsRemoved: stalePreparations.results.length,
    readJobsRemoved: removedReads.results.length, capturesInvalidated: invalidated.results.length,
    captureJobsAttempted: candidates.results.length, captureJobsRemoved: 0, pending: 0, failed: 0 };
  for (const job of candidates.results) {
    try {
      for (let page = 0; page < DISCARD_PAGES_PER_JOB; page++) {
        const discarded = await discardCloudSnapshotCapture(job.workspace_id, job.id,
          { DB: db, PRIVATE_ASSETS: assets }, now);
        if (!discarded.pending) {
          result.captureJobsRemoved++;
          break;
        }
        if (page === DISCARD_PAGES_PER_JOB - 1) result.pending++;
      }
    } catch (error) {
      if (error instanceof CloudRecoveryError && error.status === 404) continue;
      result.failed++;
    }
  }
  return result;
}
