import { getCloudflareContext } from '@opennextjs/cloudflare';
import { WORKSPACE_ERASURE_CONFIRMATION } from '@/lib/workspace-erasure-contract';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { readCloudObject } from '@/lib/cloud/request';
import { CloudRecoveryError, MAX_CLOUD_BACKUP_BYTES, recoveryErrorResponse, SNAPSHOT_TABLES, snapshotColumns, validateCloudSnapshot, type CloudSnapshot, type SnapshotRow } from '@/lib/cloud/recovery-contract';
import { backupChecksum, cloudBackupResponse, createCloudBackup, deleteCloudBackupFile, listCloudBackups, maintenanceGuard, pinCloudBackup, pruneCloudBackups, readManagedCloudSnapshot, recoveryGuard, releaseBackupPin, removeGuard, safeBackupFilename } from '@/lib/cloud/recovery-storage';
import { cleanupWorkspaceExportJobs } from '@/lib/cloud/export-jobs';
import { readAutomaticBackupStatus } from '@/lib/cloud/automatic-backup';
import { pauseCloudSyncStatements, resumeCloudSyncStatements } from '@/lib/cloud/sync-projection';

function restoreStatements(db: CloudflareEnv['DB'], workspaceId: string, snapshot: CloudSnapshot) {
  const statements = [
    ...pauseCloudSyncStatements(db, workspaceId),
    db.prepare('DELETE FROM reminder_email_deliveries WHERE workspace_id = ?').bind(workspaceId),
    db.prepare('DELETE FROM birthday_email_deliveries WHERE workspace_id = ?').bind(workspaceId),
    db.prepare('DELETE FROM birthday_email_scan_state WHERE workspace_id = ?').bind(workspaceId),
    db.prepare('DELETE FROM child_birthday_email_scan_state WHERE workspace_id = ?').bind(workspaceId),
    ...[...SNAPSHOT_TABLES].reverse().map((table) => db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).bind(workspaceId)),
  ];
  // Replacing source data invalidates delivery history. Require fresh consent before
  // any restored reminder or annual occasion can produce another email.
  statements.push(db.prepare('UPDATE reminder_email_preferences SET enabled = 0, enabled_at = NULL, updated_at = ? WHERE workspace_id = ?')
    .bind(new Date().toISOString(), workspaceId));
  statements.push(db.prepare(`UPDATE cloud_backup_schedules SET next_attempt_at = ?, lease_until = NULL,
    last_failure_code = NULL, updated_at = ? WHERE workspace_id = ?`)
    .bind(new Date().toISOString(), new Date().toISOString(), workspaceId));
  statements.push(db.prepare("UPDATE contact_import_jobs SET state = 'cancelled', updated_at = ? WHERE workspace_id = ? AND state IN ('preparing', 'review', 'importing')").bind(new Date().toISOString(), workspaceId));
  for (const table of SNAPSHOT_TABLES) {
    const columns = snapshotColumns(table).map((column) => column.name);
    let chunk: SnapshotRow[] = [];
    let bytes = 2;
    const flush = () => {
      if (!chunk.length) return;
      statements.push(db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${columns.map((column) => `json_extract(value, '$.${column}')`).join(', ')} FROM json_each(?)`).bind(JSON.stringify(chunk)));
      chunk = []; bytes = 2;
    };
    for (const row of snapshot.tables[table]) {
      const size = new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
      if (bytes + size > 1_000_000) flush();
      if (size > 1_000_000) throw new CloudRecoveryError('A backup row is too large to restore safely.', 413);
      chunk.push(row); bytes += size;
    }
    flush();
  }
  // History insertion triggers recalculate dates. Restore explicit contact dates
  // and timestamps only after every interaction has been inserted.
  const dates = snapshot.tables.contacts.map(({ id, last_contacted, updated_at }) => ({ id, last_contacted, updated_at }));
  for (let offset = 0; offset < dates.length; offset += 1000) {
    const data = JSON.stringify(dates.slice(offset, offset + 1000));
    statements.push(db.prepare(`UPDATE contacts SET last_contacted = (SELECT json_extract(value, '$.last_contacted') FROM json_each(?) WHERE json_extract(value, '$.id') = contacts.id),
      updated_at = (SELECT json_extract(value, '$.updated_at') FROM json_each(?) WHERE json_extract(value, '$.id') = contacts.id)
      WHERE workspace_id = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`).bind(data, data, workspaceId, data));
  }
  statements.push(db.prepare('UPDATE mutation_receipts SET resource_id = NULL WHERE workspace_id = ?').bind(workspaceId));
  if (snapshot.workspace) statements.push(db.prepare('UPDATE workspaces SET name = ?, persona = ? WHERE id = ?').bind(snapshot.workspace.name, snapshot.workspace.persona, workspaceId));
  statements.push(...resumeCloudSyncStatements(db, workspaceId));
  return statements;
}

export async function handleCloudRestore(request: Request, workspaceId: string) {
  const { DB, CLOUD_AUTOMATIC_BACKUP_ENABLED } = getCloudflareContext().env;
  const targetPin = crypto.randomUUID();
  let restored = false;
  try {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    let snapshot: CloudSnapshot;
    if (request.headers.has('X-Bonds-Restore-Confirmation')) {
      if (request.headers.get('X-Bonds-Restore-Confirmation') !== 'RESTORE') throw new CloudRecoveryError('Type RESTORE to confirm replacement.', 400);
      snapshot = validateCloudSnapshot(await readJsonBody(request, { maximumBytes: MAX_CLOUD_BACKUP_BYTES }), workspaceId);
    } else {
      const body = await readCloudObject(request);
      if (body.confirmation !== 'RESTORE' || !safeBackupFilename(body.filename)) throw new CloudRecoveryError('Choose a valid backup and type RESTORE.', 400);
      await pinCloudBackup(workspaceId, body.filename, targetPin);
      snapshot = await readManagedCloudSnapshot(workspaceId, body.filename);
    }
    const statements = restoreStatements(DB, workspaceId, snapshot);
    const recovery = await createCloudBackup(workspaceId, 'pre-restore');
    try {
      await DB.batch([recoveryGuard(DB, workspaceId, recovery), ...statements, removeGuard(DB, recovery.token)]);
      restored = true;
    } finally { await releaseBackupPin(workspaceId, recovery.token); }
    await releaseBackupPin(workspaceId, targetPin);
    await pruneCloudBackups(workspaceId);
    return Response.json({ success: true, recoveryPoint: { ...recovery.backup, protected: false },
      ...cloudBackupResponse(await listCloudBackups(workspaceId), 'active',
        await readAutomaticBackupStatus(DB, workspaceId, CLOUD_AUTOMATIC_BACKUP_ENABLED === 'true')) });
  } catch (error) {
    if (error instanceof RequestBodyError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: 'The backup does not contain valid JSON.' }, { status: 400 });
    const response = recoveryErrorResponse(error);
    if (response) return response;
    console.error('cloud.restore.failed', error);
    return Response.json({ error: restored ? 'Your data was restored, but refreshing recovery storage failed. Refresh before taking another action.' : 'Restore could not finish. Refresh to verify the current state before retrying; the pre-restore recovery point remains available.' }, { status: 503 });
  } finally { await releaseBackupPin(workspaceId, targetPin); }
}

export async function handleCloudBackups(request: Request, workspaceId: string, filename?: string, role = 'owner') {
  const { DB, PRIVATE_ASSETS, CLOUD_AUTOMATIC_BACKUP_ENABLED, CLOUD_LARGE_RECOVERY_ENABLED } = getCloudflareContext().env;
  const status = () => readAutomaticBackupStatus(DB, workspaceId, CLOUD_AUTOMATIC_BACKUP_ENABLED === 'true');
  try {
    if (filename && !safeBackupFilename(filename)) throw new CloudRecoveryError('Invalid backup filename.', 400);
    if (filename && request.method === 'GET') {
      const file = await DB.prepare('SELECT state FROM cloud_backup_files WHERE workspace_id = ? AND filename = ?')
        .bind(workspaceId, filename).first<{ state: string }>();
      if (file && file.state !== 'ready') throw new CloudRecoveryError('Backup not found.', 404);
      const object = await PRIVATE_ASSETS.get(`${workspaceId}/backups/${filename}`);
      if (!object) throw new CloudRecoveryError('Backup not found.', 404);
      if (object.size > MAX_CLOUD_BACKUP_BYTES) throw new CloudRecoveryError('Backup exceeds the interactive download limit.', 413);
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (!object.customMetadata?.sha256 || await backupChecksum(bytes) !== object.customMetadata.sha256) {
        throw new CloudRecoveryError('The backup checksum is missing or invalid. No file was downloaded.', 400);
      }
      return new Response(bytes, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(bytes.byteLength), 'Content-Disposition': `attachment; filename="${filename}"` } });
    }
    if (filename && request.method === 'DELETE') {
      const existing = (await listCloudBackups(workspaceId)).find((backup) => backup.filename === filename);
      if (!existing) throw new CloudRecoveryError('Backup not found.', 404);
      await deleteCloudBackupFile(workspaceId, filename);
      if (existing.reason === 'automatic') await DB.prepare(`UPDATE cloud_backup_schedules
        SET next_attempt_at = ?, last_success_at = NULL, last_failure_code = NULL, updated_at = ?
        WHERE workspace_id = ?`).bind(new Date().toISOString(), new Date().toISOString(), workspaceId).run();
      return Response.json(cloudBackupResponse(await listCloudBackups(workspaceId), 'active', await status()));
    }
    if (!filename && request.method === 'GET') {
      const workspace = await DB.prepare('SELECT lifecycle FROM workspaces WHERE id = ?').bind(workspaceId).first<{ lifecycle: string }>();
      return Response.json({ ...cloudBackupResponse(await listCloudBackups(workspaceId), workspace?.lifecycle, await status()),
        largeRecoveryEnabled: role === 'owner'
          && (CLOUD_LARGE_RECOVERY_ENABLED === 'true' || workspace?.lifecycle === 'restoring') });
    }
    if (filename || request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    const result = await createCloudBackup(workspaceId, 'manual');
    await releaseBackupPin(workspaceId, result.token);
    await pruneCloudBackups(workspaceId);
    return Response.json({ backup: { ...result.backup, protected: false },
      ...cloudBackupResponse(await listCloudBackups(workspaceId), 'active', await status()) }, { status: 201 });
  } catch (error) {
    const response = recoveryErrorResponse(error);
    if (response) return response;
    console.error('cloud.backup.failed', error);
    return Response.json({ error: 'Backup storage is unavailable. No CRM data was changed.' }, { status: 503 });
  }
}

export async function handleCloudErasure(request: Request, workspaceId: string) {
  const { DB, PRIVATE_ASSETS } = getCloudflareContext().env;
  try {
    const body = await readCloudObject(request);
    if (body.confirmation !== WORKSPACE_ERASURE_CONFIRMATION) throw new CloudRecoveryError(`Type ${WORKSPACE_ERASURE_CONFIRMATION} to confirm permanent erasure.`, 400);
    const workspace = await DB.prepare('SELECT lifecycle FROM workspaces WHERE id = ?')
      .bind(workspaceId).first<{ lifecycle: string }>();
    if (workspace?.lifecycle !== 'active' && workspace?.lifecycle !== 'erasing') {
      throw new CloudRecoveryError('Workspace recovery is in progress. Erasure cannot start now.', 409);
    }
    if (!(await cleanupWorkspaceExportJobs(workspaceId))) {
      return Response.json({ success: false, pending: true, message: 'Export files are still being removed. Continue erasure to finish cleanup.' }, { status: 202 });
    }
    const token = crypto.randomUUID();
    await DB.batch([
      maintenanceGuard(DB, token, `EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle IN ('active', 'erasing'))
        AND NOT EXISTS (SELECT 1 FROM cloud_backup_pins WHERE workspace_id = ?)
        AND NOT EXISTS (SELECT 1 FROM contact_export_jobs WHERE workspace_id = ?)
        AND NOT EXISTS (SELECT 1 FROM cloud_snapshot_capture_jobs
          WHERE workspace_id = ? AND lease_token IS NOT NULL AND lease_until >= ?)
        AND NOT EXISTS (SELECT 1 FROM cloud_snapshot_read_jobs
          WHERE workspace_id = ? AND lease_token IS NOT NULL AND lease_until >= ?)
        AND NOT EXISTS (SELECT 1 FROM cloud_snapshot_restore_jobs
          WHERE workspace_id = ? AND lease_token IS NOT NULL AND lease_until >= ?)`,
      [workspaceId, workspaceId, workspaceId, workspaceId, new Date().toISOString(), workspaceId, new Date().toISOString(),
        workspaceId, new Date().toISOString()]),
      // Parents go first so history triggers cannot update surviving contacts.
      ...pauseCloudSyncStatements(DB, workspaceId),
      DB.prepare('DELETE FROM device_authorization_codes WHERE workspace_id = ?').bind(workspaceId),
      DB.prepare('UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE workspace_id = ?').bind(new Date().toISOString(), workspaceId),
      DB.prepare('DELETE FROM provider_authorization_attempts WHERE workspace_id = ?').bind(workspaceId),
      DB.prepare('DELETE FROM provider_connections WHERE workspace_id = ?').bind(workspaceId),
      DB.prepare('DELETE FROM calendar_publication_reservations WHERE workspace_id = ?').bind(workspaceId),
      ...SNAPSHOT_TABLES.map((table) => DB.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).bind(workspaceId)),
      DB.prepare('DELETE FROM reminder_email_deliveries WHERE workspace_id = ?').bind(workspaceId),
      DB.prepare('DELETE FROM birthday_email_deliveries WHERE workspace_id = ?').bind(workspaceId),
      DB.prepare('DELETE FROM birthday_email_scan_state WHERE workspace_id = ?').bind(workspaceId),
      DB.prepare('DELETE FROM child_birthday_email_scan_state WHERE workspace_id = ?').bind(workspaceId),
      DB.prepare('DELETE FROM reminder_email_preferences WHERE workspace_id = ?').bind(workspaceId),
      DB.prepare('DELETE FROM cloud_backup_schedules WHERE workspace_id = ?').bind(workspaceId),
      DB.prepare('DELETE FROM cloud_snapshot_restore_jobs WHERE workspace_id = ?').bind(workspaceId),
      DB.prepare('DELETE FROM cloud_snapshot_capture_jobs WHERE workspace_id = ?').bind(workspaceId),
      DB.prepare('DELETE FROM contact_import_jobs WHERE workspace_id = ?').bind(workspaceId),
      DB.prepare('DELETE FROM mutation_receipts WHERE workspace_id = ?').bind(workspaceId),
      // Delete guards require active; commit the empty graph and erasing lifecycle atomically.
      DB.prepare("UPDATE workspaces SET lifecycle = 'erasing' WHERE id = ?").bind(workspaceId),
      removeGuard(DB, token),
    ]);
    // Persist the exact keys before touching R2. Concurrent or interrupted runs
    // can retry these keys, but cannot complete while another batch is in flight.
    for (let page = 0; page < 4; page++) {
      const pending = await DB.prepare('SELECT token, object_keys FROM cloud_erasure_batches WHERE workspace_id = ? ORDER BY token LIMIT 1')
        .bind(workspaceId).first<{ token: string; object_keys: string }>();
      if (pending) {
        await PRIVATE_ASSETS.delete(JSON.parse(pending.object_keys) as string[]);
        await DB.prepare('DELETE FROM cloud_erasure_batches WHERE workspace_id = ? AND token = ?').bind(workspaceId, pending.token).run();
        continue;
      }
      const objects = await PRIVATE_ASSETS.list({ prefix: `${workspaceId}/`, limit: 1000 });
      const batchToken = crypto.randomUUID();
      if (!objects.objects.length) {
        await DB.batch([
          maintenanceGuard(DB, batchToken, "EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'erasing') AND NOT EXISTS (SELECT 1 FROM cloud_erasure_batches WHERE workspace_id = ?)", [workspaceId, workspaceId]),
          DB.prepare('DELETE FROM cloud_backup_files WHERE workspace_id = ?').bind(workspaceId),
          ...resumeCloudSyncStatements(DB, workspaceId),
          DB.prepare("UPDATE workspaces SET name = 'Personal workspace', persona = NULL, lifecycle = 'active', recovery_revision = recovery_revision + 1 WHERE id = ?").bind(workspaceId), removeGuard(DB, batchToken),
        ]);
        return Response.json({ success: true, erasedWorkspaceId: workspaceId });
      }
      const keys = objects.objects.map((object: { key: string }) => object.key);
      await DB.batch([
        maintenanceGuard(DB, batchToken, "EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND lifecycle = 'erasing')", [workspaceId]),
        DB.prepare('INSERT INTO cloud_erasure_batches (workspace_id, token, object_keys) VALUES (?, ?, ?)').bind(workspaceId, batchToken, JSON.stringify(keys)), removeGuard(DB, batchToken),
      ]);
      await PRIVATE_ASSETS.delete(keys);
      await DB.prepare('DELETE FROM cloud_erasure_batches WHERE workspace_id = ? AND token = ?').bind(workspaceId, batchToken).run();
    }
    return Response.json({ success: false, pending: true, message: 'Erasure is in progress. Continue to remove the remaining stored files.' }, { status: 202 });
  } catch (error) {
    if (error instanceof RequestBodyError) return Response.json({ error: error.message }, { status: error.status });
    const response = recoveryErrorResponse(error);
    if (response) return response;
    console.error('cloud.erasure.failed', error);
    return Response.json({ error: 'Erasure has not finished. Retry to remove the remaining data; new writes remain blocked while erasure is in progress.' }, { status: 503 });
  }
}
