import { getCloudflareContext } from '@opennextjs/cloudflare';
import { CLOUD_BACKUP_RETENTION, CloudRecoveryError, MAX_CLOUD_BACKUP_BYTES, SNAPSHOT_TABLES, snapshotColumns, validateCloudSnapshot, type CloudSnapshot } from '@/lib/cloud/recovery-contract';

type DB = CloudflareEnv['DB'];
type BackupEnv = Pick<CloudflareEnv, 'DB' | 'PRIVATE_ASSETS'>;
type BackupReason = 'manual' | 'automatic' | 'pre-delete' | 'pre-merge' | 'pre-restore';
export type CloudBackupMetadata = { filename: string; createdAt: string; reason: string; schemaVersion: string; sizeBytes: number; sha256: string; rowCounts: Record<string, number>; protected: boolean };
export type CloudAutomaticBackupStatus = {
  enabled: boolean;
  state: 'disabled' | 'current' | 'due' | 'failed';
  intervalHours: number;
  latestBackupAt: string | null;
  nextBackupAt: string | null;
  issue: 'too_large' | 'backup_failed' | 'backup_missing' | null;
};

function bindings(env?: BackupEnv): BackupEnv {
  return env || getCloudflareContext().env;
}

export function safeBackupFilename(value: unknown): value is string {
  return typeof value === 'string' && /^bonds-cloud-\d{4}-\d{2}-\d{2}T[0-9-]+Z(?:-[a-f0-9-]{36})?\.json$/u.test(value);
}

export async function backupChecksum(value: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(value).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function maintenanceGuard(db: DB, token: string, condition: string, values: unknown[], failure = 0) {
  return db.prepare(`INSERT INTO cloud_maintenance_guards (token, allowed) SELECT ?, CASE WHEN ${condition} THEN 1 ELSE ? END`).bind(token, ...values, failure);
}

export function removeGuard(db: DB, token: string) {
  return db.prepare('DELETE FROM cloud_maintenance_guards WHERE token = ?').bind(token);
}

export async function releaseBackupPin(workspaceId: string, token: string, db?: DB) {
  await (db || getCloudflareContext().env.DB).prepare('DELETE FROM cloud_backup_pins WHERE workspace_id = ? AND token = ?').bind(workspaceId, token).run();
}

export async function pinCloudBackup(workspaceId: string, filename: string, token: string) {
  const { DB } = getCloudflareContext().env;
  await DB.batch([
    maintenanceGuard(DB, token, "EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active')", [workspaceId]),
    DB.prepare("INSERT INTO cloud_backup_files (workspace_id, filename, state) VALUES (?, ?, 'ready') ON CONFLICT DO NOTHING").bind(workspaceId, filename),
    maintenanceGuard(DB, `${token}-file`, "EXISTS (SELECT 1 FROM cloud_backup_files WHERE workspace_id = ? AND filename = ? AND state = 'ready')", [workspaceId, filename]),
    DB.prepare('INSERT INTO cloud_backup_pins (workspace_id, filename, token) VALUES (?, ?, ?)').bind(workspaceId, filename, token),
    removeGuard(DB, token), removeGuard(DB, `${token}-file`),
  ]);
}

export async function listCloudBackups(workspaceId: string, env?: BackupEnv): Promise<CloudBackupMetadata[]> {
  const { DB, PRIVATE_ASSETS } = bindings(env);
  const prefix = `${workspaceId}/backups/`;
  const files = await DB.prepare(`SELECT files.filename, files.state, EXISTS (
    SELECT 1 FROM cloud_backup_pins pins WHERE pins.workspace_id = files.workspace_id AND pins.filename = files.filename
  ) AS protected FROM cloud_backup_files files WHERE files.workspace_id = ?`).bind(workspaceId).all<{ filename: string; state: string; protected: number }>();
  const states = new Map((files.results as Array<{ filename: string; state: string; protected: number }>).map((file) => [file.filename, file]));
  const backups: CloudBackupMetadata[] = [];
  let cursor: string | undefined;
  do {
    const page = await PRIVATE_ASSETS.list({ prefix, limit: 1000, cursor, include: ['customMetadata'] });
    for (const object of page.objects) {
      const filename = object.key.slice(prefix.length);
      if (!safeBackupFilename(filename) || (states.has(filename) && states.get(filename)!.state !== 'ready')) continue;
      let rowCounts: Record<string, number> = {};
      try { rowCounts = JSON.parse(object.customMetadata?.rowCounts || '{}'); } catch { /* A legacy file can lack row counts. */ }
      backups.push({ filename, createdAt: object.customMetadata?.createdAt || object.uploaded.toISOString(), reason: object.customMetadata?.reason || 'manual', schemaVersion: object.customMetadata?.schemaVersion || 'cloud-1', sizeBytes: object.size, sha256: object.customMetadata?.sha256 || '', rowCounts, protected: Boolean(states.get(filename)?.protected) });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.filename.localeCompare(a.filename));
}

export async function deleteCloudBackupFile(workspaceId: string, filename: string, env?: BackupEnv) {
  const { DB, PRIVATE_ASSETS } = bindings(env);
  await DB.prepare("INSERT INTO cloud_backup_files (workspace_id, filename, state) VALUES (?, ?, 'ready') ON CONFLICT DO NOTHING").bind(workspaceId, filename).run();
  const claimed = await DB.prepare(`UPDATE cloud_backup_files SET state = 'deleting' WHERE workspace_id = ? AND filename = ?
    AND NOT EXISTS (SELECT 1 FROM cloud_backup_pins WHERE workspace_id = ? AND filename = ?) RETURNING filename`).bind(workspaceId, filename, workspaceId, filename).first();
  if (!claimed) throw new CloudRecoveryError('This recovery point is protecting an operation in progress and cannot be deleted yet.');
  await PRIVATE_ASSETS.delete(`${workspaceId}/backups/${filename}`);
  await DB.prepare('DELETE FROM cloud_backup_files WHERE workspace_id = ? AND filename = ?').bind(workspaceId, filename).run();
}

export async function pruneCloudBackups(workspaceId: string, env?: BackupEnv) {
  const backups = await listCloudBackups(workspaceId, env);
  const keep = new Set<string>();
  const reasons = new Set<string>();
  for (const backup of backups) {
    if (backup.protected || !reasons.has(backup.reason)) keep.add(backup.filename);
    reasons.add(backup.reason);
  }
  for (const backup of backups) if (keep.size < CLOUD_BACKUP_RETENTION) keep.add(backup.filename);
  for (const backup of backups) if (!keep.has(backup.filename)) {
    try { await deleteCloudBackupFile(workspaceId, backup.filename, env); }
    catch (error) { if (!(error instanceof CloudRecoveryError)) throw error; }
  }
}

export function cloudBackupResponse(backups: CloudBackupMetadata[], lifecycle = 'active', automaticBackup?: CloudAutomaticBackupStatus) {
  const currentFilePresent = automaticBackup?.state !== 'current' || backups.some((backup) =>
    backup.reason === 'automatic' && /^[a-f0-9]{64}$/u.test(backup.sha256)
      && (!automaticBackup.latestBackupAt || backup.createdAt >= automaticBackup.latestBackupAt));
  const safeAutomaticBackup = automaticBackup && !currentFilePresent
    ? { ...automaticBackup, state: 'failed' as const, issue: 'backup_missing' as const }
    : automaticBackup;
  return { backups, mode: 'cloud', lifecycle,
    automaticBackup: safeAutomaticBackup || { enabled: false, state: 'disabled', intervalHours: 24, latestBackupAt: null, nextBackupAt: null, issue: null },
    retentionCount: CLOUD_BACKUP_RETENTION, retentionProtectedExtra: true, maxRestoreMegabytes: MAX_CLOUD_BACKUP_BYTES / 1024 / 1024,
  };
}

/** The byte bound, all CRM tables, and the revision are read in one transaction. */
export async function createCloudBackup(workspaceId: string, reason: BackupReason, env?: BackupEnv) {
  const { DB, PRIVATE_ASSETS } = bindings(env);
  const token = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const filename = `bonds-cloud-${createdAt.replace(/[:.]/gu, '-')}-${token}.json`;
  const sizeQuery = SNAPSHOT_TABLES.map((table) => `(SELECT COALESCE(SUM(length(CAST(json_object(${snapshotColumns(table).map((column) => `'${column.name}', ${column.name}`).join(', ')}) AS BLOB)) + 1), 0) FROM ${table} WHERE workspace_id = ?)`).join(' + ');
  const result = await DB.batch([
    maintenanceGuard(DB, token, "EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active')", [workspaceId]),
    maintenanceGuard(DB, `${token}-size`, `(${sizeQuery}) <= ?`, [...SNAPSHOT_TABLES.map(() => workspaceId), MAX_CLOUD_BACKUP_BYTES - 65536], -1),
    DB.prepare("INSERT INTO cloud_backup_files (workspace_id, filename, state) VALUES (?, ?, 'writing')").bind(workspaceId, filename),
    DB.prepare('INSERT INTO cloud_backup_pins (workspace_id, filename, token) VALUES (?, ?, ?)').bind(workspaceId, filename, token),
    DB.prepare('SELECT name, persona, recovery_revision FROM workspaces WHERE id = ?').bind(workspaceId),
    ...SNAPSHOT_TABLES.map((table) => DB.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY ${table === 'contact_group_members' ? 'contact_id, group_id' : 'id'}`).bind(workspaceId)),
    removeGuard(DB, token), removeGuard(DB, `${token}-size`),
  ]);
  try {
    const workspace = result[4].results[0] as { name: string; persona: string | null; recovery_revision: number };
    const tables = Object.fromEntries(SNAPSHOT_TABLES.map((table, index) => [table, result[5 + index].results])) as CloudSnapshot['tables'];
    const snapshot: CloudSnapshot = { format: 'bonds-cloud-backup', version: 4, workspaceId, createdAt, workspace: { name: workspace.name, persona: workspace.persona }, tables };
    validateCloudSnapshot(snapshot, workspaceId);
    const payload = new TextEncoder().encode(JSON.stringify(snapshot));
    if (payload.byteLength > MAX_CLOUD_BACKUP_BYTES) throw new CloudRecoveryError('This backup exceeds the interactive recovery limit. No data was changed.', 413);
    const checksum = await backupChecksum(payload);
    const rowCounts = Object.fromEntries(SNAPSHOT_TABLES.map((table) => [table, tables[table].length]));
    const key = `${workspaceId}/backups/${filename}`;
    await PRIVATE_ASSETS.put(key, payload, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: checksum, rowCounts: JSON.stringify(rowCounts), reason, createdAt, schemaVersion: 'cloud-4' } });
    const verified = await PRIVATE_ASSETS.get(key);
    if (!verified || verified.size !== payload.byteLength || await backupChecksum(new Uint8Array(await verified.arrayBuffer())) !== checksum) throw new CloudRecoveryError('The recovery file could not be verified. No data was changed.', 503);
    // R2 upload is outside the D1 snapshot transaction. Never publish a
    // snapshot as current if CRM rows changed while the object was written.
    await DB.batch([
      maintenanceGuard(DB, `${token}-finalize`, `EXISTS (
        SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active' AND recovery_revision = ?
      ) AND EXISTS (
        SELECT 1 FROM cloud_backup_files WHERE workspace_id = ? AND filename = ? AND state = 'writing'
      ) AND EXISTS (
        SELECT 1 FROM cloud_backup_pins WHERE workspace_id = ? AND filename = ? AND token = ?
      )`, [workspaceId, workspace.recovery_revision, workspaceId, filename, workspaceId, filename, token]),
      DB.prepare("UPDATE cloud_backup_files SET state = 'ready' WHERE workspace_id = ? AND filename = ? AND state = 'writing'")
        .bind(workspaceId, filename),
      removeGuard(DB, `${token}-finalize`),
    ]);
    return { token, revision: workspace.recovery_revision, snapshot, backup: { filename, createdAt, reason, schemaVersion: 'cloud-4', sizeBytes: payload.byteLength, sha256: checksum, rowCounts, protected: true } satisfies CloudBackupMetadata };
  } catch (error) {
    await releaseBackupPin(workspaceId, token, DB);
    await DB.prepare("UPDATE cloud_backup_files SET state = 'failed' WHERE workspace_id = ? AND filename = ?").bind(workspaceId, filename).run();
    try { await PRIVATE_ASSETS.delete(`${workspaceId}/backups/${filename}`); }
    catch { console.error('cloud.backup.failed_object_cleanup_pending'); }
    throw error;
  }
}

export function recoveryGuard(db: DB, workspaceId: string, recovery: Awaited<ReturnType<typeof createCloudBackup>>) {
  return maintenanceGuard(db, recovery.token, `EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'active' AND recovery_revision = ?)
    AND EXISTS (SELECT 1 FROM cloud_backup_pins WHERE workspace_id = ? AND filename = ? AND token = ?)`, [workspaceId, recovery.revision, workspaceId, recovery.backup.filename, recovery.token]);
}

export async function deleteCloudContactsWithRecovery(workspaceId: string, ids: number[]) {
  const { DB } = getCloudflareContext().env;
  const recovery = await createCloudBackup(workspaceId, 'pre-delete');
  try {
    const result = await DB.batch([recoveryGuard(DB, workspaceId, recovery),
      DB.prepare('DELETE FROM contacts WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?)) RETURNING id').bind(workspaceId, JSON.stringify(ids)),
      removeGuard(DB, recovery.token)]);
    await releaseBackupPin(workspaceId, recovery.token);
    try { await pruneCloudBackups(workspaceId); } catch (error) { console.error('cloud.backup.retention_pending', error); }
    return { affected: result[1].results.length, recoveryPoint: { ...recovery.backup, protected: false } };
  } finally { await releaseBackupPin(workspaceId, recovery.token); }
}

export async function readManagedCloudSnapshot(workspaceId: string, filename: string) {
  const object = await getCloudflareContext().env.PRIVATE_ASSETS.get(`${workspaceId}/backups/${filename}`);
  if (!object) throw new CloudRecoveryError('Backup not found.', 404);
  if (object.size > MAX_CLOUD_BACKUP_BYTES) throw new CloudRecoveryError('Backup exceeds the interactive restore limit.', 413);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (!object.customMetadata?.sha256 || await backupChecksum(bytes) !== object.customMetadata.sha256) throw new CloudRecoveryError('The backup checksum is missing or invalid. No data was changed.', 400);
  return validateCloudSnapshot(JSON.parse(new TextDecoder().decode(bytes)), workspaceId);
}
