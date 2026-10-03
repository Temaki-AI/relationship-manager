import { CloudRecoveryError } from '@/lib/cloud/recovery-contract';
import { createCloudBackup, pruneCloudBackups, releaseBackupPin, type CloudAutomaticBackupStatus } from '@/lib/cloud/recovery-storage';

type DB = CloudflareEnv['DB'];
type Assets = CloudflareEnv['PRIVATE_ASSETS'];
type ScheduleRow = {
  next_attempt_at: string;
  last_success_at: string | null;
  last_failure_code: string | null;
};

const INTERVAL_MS = 24 * 60 * 60_000;
const RETRY_MS = 30 * 60_000;
const LEASE_MS = 20 * 60_000;
const STALE_MS = 60 * 60_000;
const BACKUPS_PER_RUN = 2;

export async function readAutomaticBackupStatus(db: DB, workspaceId: string, enabled: boolean, now = new Date()): Promise<CloudAutomaticBackupStatus> {
  const schedule = await db.prepare(`SELECT next_attempt_at, last_success_at, last_failure_code
    FROM cloud_backup_schedules WHERE workspace_id = ?`).bind(workspaceId).first<ScheduleRow>();
  return {
    enabled,
    state: !enabled ? 'disabled' : schedule?.last_failure_code ? 'failed'
      : schedule?.last_success_at && schedule.next_attempt_at > now.toISOString() ? 'current' : 'due',
    intervalHours: 24,
    latestBackupAt: schedule?.last_success_at || null,
    nextBackupAt: enabled ? schedule?.next_attempt_at || now.toISOString() : null,
    issue: schedule?.last_failure_code === 'too_large' ? 'too_large'
      : schedule?.last_failure_code ? 'backup_failed' : null,
  };
}

export async function runAutomaticCloudBackups(db: DB, assets: Assets, now = new Date()) {
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
  await db.prepare(`INSERT OR IGNORE INTO cloud_backup_schedules
    (workspace_id, next_attempt_at, updated_at)
    SELECT w.id, ?, ? FROM workspaces w
    WHERE w.lifecycle = 'active' AND NOT EXISTS (
      SELECT 1 FROM cloud_backup_schedules s WHERE s.workspace_id = w.id)
    ORDER BY w.id LIMIT ?`).bind(nowIso, nowIso, BACKUPS_PER_RUN * 2).run();
  const claim = await db.prepare(`UPDATE cloud_backup_schedules
    SET lease_until = ?, updated_at = ?
    WHERE workspace_id IN (
      SELECT s.workspace_id FROM cloud_backup_schedules s
      JOIN workspaces w ON w.id = s.workspace_id AND w.lifecycle = 'active'
      WHERE s.next_attempt_at <= ? AND (s.lease_until IS NULL OR s.lease_until <= ?)
      ORDER BY s.next_attempt_at, s.workspace_id LIMIT ?)
      AND (lease_until IS NULL OR lease_until <= ?)
    RETURNING workspace_id`).bind(leaseUntil, nowIso, nowIso, nowIso, BACKUPS_PER_RUN, nowIso)
    .all<{ workspace_id: string }>();
  const result = { claimed: claim.results.length, created: 0, failed: 0, oversized: 0 };
  for (const row of claim.results as Array<{ workspace_id: string }>) {
    try {
      const recovery = await createCloudBackup(row.workspace_id, 'automatic', { DB: db, PRIVATE_ASSETS: assets });
      await releaseBackupPin(row.workspace_id, recovery.token, db);
      await db.prepare(`UPDATE cloud_backup_schedules SET next_attempt_at = ?, lease_until = NULL,
        last_success_at = ?, last_failure_code = NULL, updated_at = ?
        WHERE workspace_id = ? AND lease_until = ?
          AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active')`)
        .bind(new Date(now.getTime() + INTERVAL_MS).toISOString(), recovery.backup.createdAt, nowIso,
          row.workspace_id, leaseUntil, row.workspace_id).run();
      result.created++;
      try { await pruneCloudBackups(row.workspace_id, { DB: db, PRIVATE_ASSETS: assets }); }
      catch { console.error('cloud.backup.retention_pending'); }
    } catch (error) {
      const tooLarge = error instanceof CloudRecoveryError && error.status === 413
        || error instanceof Error && error.message.includes('CLOUD_BACKUP_TOO_LARGE');
      const nextAttempt = new Date(now.getTime() + (tooLarge ? INTERVAL_MS : RETRY_MS)).toISOString();
      await db.prepare(`UPDATE cloud_backup_schedules SET next_attempt_at = ?, lease_until = NULL,
        last_failure_code = ?, updated_at = ? WHERE workspace_id = ? AND lease_until = ?
        AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active')`)
        .bind(nextAttempt, tooLarge ? 'too_large' : 'backup_failed', nowIso,
          row.workspace_id, leaseUntil, row.workspace_id).run();
      if (tooLarge) result.oversized++;
      else result.failed++;
    }
  }
  return result;
}

export async function cleanupStaleCloudBackupArtifacts(db: DB, assets: Assets, now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_MS).toISOString();
  const released = await db.prepare('DELETE FROM cloud_backup_pins WHERE julianday(created_at) <= julianday(?)')
    .bind(cutoff).run();
  const claim = await db.prepare(`UPDATE cloud_backup_files SET state = 'deleting'
    WHERE (workspace_id, filename) IN (
      SELECT f.workspace_id, f.filename FROM cloud_backup_files f
      WHERE f.state IN ('writing', 'failed', 'deleting')
        AND julianday(f.created_at) <= julianday(?)
        AND NOT EXISTS (SELECT 1 FROM cloud_backup_pins p
          WHERE p.workspace_id = f.workspace_id AND p.filename = f.filename)
      ORDER BY f.created_at, f.workspace_id, f.filename LIMIT 10)
    RETURNING workspace_id, filename`).bind(cutoff).all<{ workspace_id: string; filename: string }>();
  const result = { releasedPins: released.meta.changes || 0, attempted: claim.results.length, removed: 0, failed: 0 };
  for (const row of claim.results as Array<{ workspace_id: string; filename: string }>) {
    try {
      await assets.delete(`${row.workspace_id}/backups/${row.filename}`);
      await db.prepare("DELETE FROM cloud_backup_files WHERE workspace_id = ? AND filename = ? AND state = 'deleting'")
        .bind(row.workspace_id, row.filename).run();
      result.removed++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
