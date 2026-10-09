import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { isSyncUuid } from '../../../../packages/domain/src/sync';
import { readDeviceSources, readDeviceSourceMutation, type DeviceSource, type DeviceSourceMutation } from '../../../../packages/domain/src/device-sources';
import { ProviderSourceError } from '../../../../packages/domain/src/provider-sources';
import { canonicalContactId } from './contact-aliases';
import { signalSyncChange } from './sync-signals';

export type SourceQueueRow = { id: string; source_id: string; contact_id: string; action: 'publish' | 'unlink'; payload: string;
  epoch: string | null; base_revision: number | null; depends_on: string | null; request_json: string | null; status: 'pending' | 'conflict'; last_error_code: string | null; created_at: string };
export type LocalDeviceSource = { id: string; device_contact_id: string; contact_id: string; installation_id: string | null;
  shared: number; cloud_revision: number | null; original_facts: string; observed_facts: string; applied_fields: string; revision: number;
  observed_at: string; created_at: string; updated_at: string };
export async function bindDeviceInstallation(db: SQLiteDatabase, id: string) {
  if (!isSyncUuid(id)) throw new ProviderSourceError('Invalid phone installation identity.');
  await db.runAsync(`INSERT INTO app_metadata (key, value, updated_at) VALUES ('device-source-installation', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, id, new Date().toISOString());
}
export async function installationId(db: SQLiteDatabase) {
  return (await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'device-source-installation'"))?.value ?? null;
}
export async function enqueueDeviceSource(db: SQLiteDatabase, source: LocalDeviceSource, action: 'publish' | 'unlink') {
  if (!source.installation_id) throw new ProviderSourceError('Choose this iPhone contact again before sharing its source details.');
  const previous = await db.getFirstAsync<SourceQueueRow>('SELECT * FROM device_source_queue WHERE source_id = ? ORDER BY rowid DESC LIMIT 1', source.id);
  const cursor = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v3'");
  const payload = { installation_id: source.installation_id, external_id: source.device_contact_id,
    ...(action === 'publish' ? { original_facts: source.original_facts, observed_facts: source.observed_facts, applied_fields: source.applied_fields, observed_at: source.observed_at } : {}) };
  await db.runAsync(`INSERT INTO device_source_queue (id, source_id, contact_id, action, payload, epoch, base_revision, depends_on, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, Crypto.randomUUID(), source.id, source.contact_id, action, JSON.stringify(payload),
    cursor ? (JSON.parse(cursor.value) as { epoch: string }).epoch : null, source.cloud_revision, previous?.id ?? null, new Date().toISOString());
}

/** Shared projections are read-only. Only records from this installation can become local OS links. */
export async function applyDeviceSourceProjection(db: SQLiteDatabase, contactId: string, value: unknown) {
  const rows = readDeviceSources(value), ownInstallation = await installationId(db);
  const local = await db.getAllAsync<LocalDeviceSource>('SELECT * FROM device_contact_links WHERE contact_id = ?', contactId);
  for (const source of local) {
    const pending = await db.getFirstAsync('SELECT id FROM device_source_queue WHERE source_id = ? LIMIT 1', source.id);
    const remote = rows.find((row) => row.public_id === source.id);
    if (pending) continue;
    if (source.shared && !remote) await db.runAsync('DELETE FROM device_contact_links WHERE id = ?', source.id);
  }
  if (!ownInstallation) return;
  for (const source of rows.filter((row) => row.installation_id === ownInstallation)) {
    if (await db.getFirstAsync('SELECT id FROM device_source_queue WHERE source_id = ? LIMIT 1', source.public_id)) continue;
    // A private or pending local review may have claimed this OS identity under a different
    // source UUID. Keep that intent and show the cloud record as read-only until reviewed.
    if (await db.getFirstAsync('SELECT id FROM device_contact_links WHERE installation_id = ? AND device_contact_id = ? AND id != ? LIMIT 1', ownInstallation, source.external_id, source.public_id)) continue;
    await db.runAsync(`INSERT INTO device_contact_links (id, device_contact_id, contact_id, installation_id, shared, cloud_revision,
      original_facts, observed_facts, applied_fields, observed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET contact_id = excluded.contact_id,
      cloud_revision = excluded.cloud_revision, shared = 1, original_facts = excluded.original_facts, observed_facts = excluded.observed_facts,
      applied_fields = excluded.applied_fields, observed_at = excluded.observed_at, updated_at = excluded.updated_at,
      revision = device_contact_links.revision + 1 WHERE device_contact_links.cloud_revision IS NOT excluded.cloud_revision
      OR device_contact_links.contact_id IS NOT excluded.contact_id OR device_contact_links.original_facts IS NOT excluded.original_facts
      OR device_contact_links.observed_facts IS NOT excluded.observed_facts OR device_contact_links.applied_fields IS NOT excluded.applied_fields
      OR device_contact_links.shared != 1`, source.public_id, source.external_id, contactId, source.installation_id, source.revision,
      source.original_facts, source.observed_facts, source.applied_fields, source.observed_at, source.created_at, source.updated_at);
  }
}
function readResult(value: unknown, body: DeviceSourceMutation) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid iPhone source response.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 5 || row.operation_id !== body.operation_id || row.epoch !== body.epoch || row.action !== body.action || !isSyncUuid(row.contact_id)) throw new Error('Invalid iPhone source response.');
  if (body.action === 'unlink') { if (row.source !== null) throw new Error('Invalid unlink response.'); return { contactId: row.contact_id, source: null }; }
  const source = readDeviceSources(JSON.stringify([row.source]))[0];
  if (source.public_id !== body.source_id || source.installation_id !== body.installation_id || source.external_id !== body.external_id || source.original_facts !== body.original_facts) throw new Error('Invalid source response identity.');
  return { contactId: row.contact_id, source };
}
export async function syncDeviceSources(db: SQLiteDatabase, epoch: string, request: (body: string) => Promise<unknown>, checkAccount: (tx: SQLiteDatabase) => Promise<void>) {
  let changed = 0;
  for (let step = 0; step < 8; step++) {
    let frozen: { row: SourceQueueRow; body: string } | null = null;
    await db.withExclusiveTransactionAsync(async (tx) => {
      await checkAccount(tx);
      await tx.runAsync("UPDATE device_source_queue SET status = 'conflict', last_error_code = 'epoch_changed' WHERE epoch IS NOT NULL AND epoch != ?", epoch);
      const rows = await tx.getAllAsync<SourceQueueRow>("SELECT * FROM device_source_queue WHERE status = 'pending' AND depends_on IS NULL ORDER BY rowid LIMIT 32");
      for (const row of rows) {
        const canonical = await canonicalContactId(tx, row.contact_id);
        if (await tx.getFirstAsync(`SELECT id FROM sync_queue WHERE entity_type = 'contact' AND (entity_id = ? OR entity_id IN
          (SELECT id FROM contact_aliases WHERE canonical_id = ?)) LIMIT 1`, canonical, canonical)) continue;
        if (row.request_json) { frozen = { row, body: row.request_json }; break; }
        const person = await tx.getFirstAsync<{ id: string }>('SELECT id FROM contacts WHERE id = ? AND deleted_at IS NULL', canonical);
        const remote = await tx.getFirstAsync<{ record_json: string }>('SELECT record_json FROM sync_remote_contacts WHERE id = ?', canonical);
        if (!person || !remote || JSON.parse(remote.record_json).deleted) { await tx.runAsync("UPDATE device_source_queue SET status = 'conflict', last_error_code = 'person_missing' WHERE id = ?", row.id); continue; }
        if (row.action === 'unlink' && row.base_revision === null) { await tx.runAsync("UPDATE device_source_queue SET status = 'conflict', last_error_code = 'source_missing' WHERE id = ?", row.id); continue; }
        const body = JSON.stringify(readDeviceSourceMutation({ operation_id: row.id, epoch, action: row.action, source_id: row.source_id,
          contact_id: canonical, expected_revision: row.base_revision, ...JSON.parse(row.payload) }));
        await tx.runAsync('UPDATE device_source_queue SET request_json = ?, epoch = ? WHERE id = ?', body, epoch, row.id);
        frozen = { row, body }; break;
      }
    });
    if (!frozen) break;
    const item: { row: SourceQueueRow; body: string } = frozen;
    try {
      const result = readResult(await request(item.body), readDeviceSourceMutation(JSON.parse(item.body)));
      await db.withExclusiveTransactionAsync(async (tx) => {
        await checkAccount(tx);
        if (await canonicalContactId(tx, item.row.contact_id) !== result.contactId) throw new Error('Refresh the merged person before confirming this source.');
        await tx.runAsync('DELETE FROM device_source_queue WHERE id = ? AND request_json = ?', item.row.id, item.body);
        await tx.runAsync('UPDATE device_source_queue SET base_revision = ?, depends_on = NULL WHERE depends_on = ? AND request_json IS NULL', result.source?.revision ?? null, item.row.id);
        if (result.source) await tx.runAsync('UPDATE device_contact_links SET shared = 1, cloud_revision = ?, contact_id = ? WHERE id = ? AND (cloud_revision IS NULL OR cloud_revision <= ?)', result.source.revision, result.contactId, item.row.source_id, result.source.revision);
      }); changed++;
    } catch (error) {
      const issue = error as { status?: number; code?: string };
      const conflict = [400, 409, 413].includes(issue.status ?? 0) && issue.code !== 'epoch_changed';
      await db.withExclusiveTransactionAsync(async (tx) => {
        await checkAccount(tx);
        await tx.runAsync('UPDATE device_source_queue SET status = ?, last_error_code = ? WHERE id = ? AND request_json = ?', conflict ? 'conflict' : 'pending', issue.code ?? 'invalid_source_response', item.row.id, item.body);
      });
      if (!conflict) throw error;
      changed++;
    }
  }
  return changed;
}

export async function deviceSourceSyncReviews(db: SQLiteDatabase) {
  return db.getAllAsync<SourceQueueRow>("SELECT * FROM device_source_queue WHERE status = 'conflict' ORDER BY rowid LIMIT 50");
}

export type SavedDeviceSource = LocalDeviceSource & { fromThisPhone: boolean; hasLocalLink: boolean; queueStatus: 'pending' | 'conflict' | null; unlinkPending: boolean };
export async function savedDeviceSources(db: SQLiteDatabase, personId: string): Promise<SavedDeviceSource[]> {
  const id = await canonicalContactId(db, personId), installation = await installationId(db);
  const person = await db.getFirstAsync<{ device_links: string }>('SELECT device_links FROM contacts WHERE id = ?', id);
  const remote = readDeviceSources(person?.device_links ?? '[]'), rows = new Map<string, LocalDeviceSource>();
  for (const source of remote) rows.set(source.public_id, localSource(source, id));
  const local = await db.getAllAsync<LocalDeviceSource>('SELECT * FROM device_contact_links WHERE contact_id = ? ORDER BY created_at, id', id);
  const localIds = new Set(local.map((row) => row.id));
  for (const source of local) rows.set(source.id, source);
  const result: SavedDeviceSource[] = [];
  for (const source of rows.values()) {
    const queue = await db.getAllAsync<SourceQueueRow>('SELECT * FROM device_source_queue WHERE source_id = ? ORDER BY rowid', source.id);
    result.push({ ...source, fromThisPhone: source.installation_id === installation, hasLocalLink: localIds.has(source.id),
      queueStatus: queue.some((row) => row.status === 'conflict') ? 'conflict' : queue.length ? 'pending' : null,
      unlinkPending: queue.some((row) => row.action === 'unlink') });
  }
  return result;
}
function localSource(source: DeviceSource, personId: string): LocalDeviceSource {
  return { id: source.public_id, contact_id: personId, device_contact_id: source.external_id, installation_id: source.installation_id,
    shared: 1, cloud_revision: source.revision, revision: source.revision, original_facts: source.original_facts, observed_facts: source.observed_facts,
    applied_fields: source.applied_fields, observed_at: source.observed_at, created_at: source.created_at, updated_at: source.updated_at };
}
export async function unlinkSharedDeviceSource(db: SQLiteDatabase, source: SavedDeviceSource) {
  await db.withExclusiveTransactionAsync(async (tx) => {
    const id = await canonicalContactId(tx, source.contact_id), person = await tx.getFirstAsync<{ device_links: string }>('SELECT device_links FROM contacts WHERE id = ?', id);
    const remote = readDeviceSources(person?.device_links ?? '[]').find((row) => row.public_id === source.id);
    if (!remote || remote.revision !== source.cloud_revision || remote.installation_id !== source.installation_id
      || await tx.getFirstAsync('SELECT id FROM device_source_queue WHERE source_id = ? LIMIT 1', source.id)) throw new ProviderSourceError('This shared source changed. Refresh before unlinking.');
    await enqueueDeviceSource(tx, localSource(remote, id), 'unlink');
  }); signalSyncChange(db);
}
/** Discarding source uploads leaves ordinary contact edits and accepted methods intact. */
export async function discardDeviceSourceUploads(db: SQLiteDatabase, sourceId: string) {
  await db.withExclusiveTransactionAsync(async (tx) => {
    if (await tx.getFirstAsync("SELECT id FROM device_source_queue WHERE source_id = ? AND request_json IS NOT NULL AND status = 'pending' LIMIT 1", sourceId)) throw new ProviderSourceError('Confirm the uncertain source save by syncing before discarding it.');
    await tx.runAsync('DELETE FROM device_source_queue WHERE source_id = ?', sourceId);
    const source = await tx.getFirstAsync<LocalDeviceSource>('SELECT * FROM device_contact_links WHERE id = ?', sourceId);
    if (source) {
      const contactId = await canonicalContactId(tx, source.contact_id);
      const contact = await tx.getFirstAsync<{ device_links: string }>('SELECT device_links FROM contacts WHERE id = ?', contactId);
      const current = readDeviceSources(contact?.device_links ?? '[]').find((row) => row.public_id === sourceId);
      if (current) await tx.runAsync('UPDATE device_contact_links SET shared = 1, cloud_revision = ?, observed_facts = ?, applied_fields = ?, revision = revision + 1 WHERE id = ?', current.revision, current.observed_facts, current.applied_fields, sourceId);
      else await tx.runAsync('UPDATE device_contact_links SET shared = 0, cloud_revision = NULL WHERE id = ?', sourceId);
    }
  }); signalSyncChange(db);
}
