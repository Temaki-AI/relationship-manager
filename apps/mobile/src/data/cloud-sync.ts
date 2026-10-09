import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { accountScope, type NativeAccount } from '../../../../packages/domain/src/devices';
import { readPushResult, readSyncCursor, readSyncRecord } from '../../../../packages/domain/src/sync-client';
import { MAX_SYNC_PAGE_BYTES, MAX_SYNC_PUSH_BYTES, SYNC_WRITABLE_CONTACT_FIELDS,
  type SyncContactRecord, type SyncCursor, type SyncValue } from '../../../../packages/domain/src/sync';
import { enqueueSyncIntent } from './sync-queue';
import { applyDeviceSourceProjection, syncDeviceSources } from './device-source-sync';
import { holdDevicePoliciesForEpoch } from './device-contact-reconciliation';
import { canonicalContactId, registerContactAliases, reconcileMergedPeople } from './contact-aliases';
import { readContactMethods, normalizeUserContactMethods, replacePrimaryContactMethods, reviewContactMethodsPatch } from '../../../../packages/domain/src/contact-methods';

import { readPushResultV2 } from '../../../../packages/domain/src/sync-v2-client';
import type { SyncEntity } from '../../../../packages/domain/src/sync-v2';
import { readPushResultV3 } from '../../../../packages/domain/src/sync-v3-client';
import type { SyncV3EntityMutation as SyncEntityMutation } from '../../../../packages/domain/src/sync-v3';
import { readBootstrapV4, readPullV4, readPushResultV4 } from '../../../../packages/domain/src/sync-v4-client';
import type { SyncV4EntityRecord as SyncEntityRecord, SyncV4BootstrapPosition as SyncBootstrapPosition, SyncV4PushRequest as SyncPushRequest } from '../../../../packages/domain/src/sync-v4';
import { applyRemoteCalendarEvent } from './calendar-events';
import { holdCalendarLinksForEpoch, syncCalendarLinks } from './calendar-event-links';
import { holdAppleCalendarForEpoch } from './apple-calendar';
import { discardGmailContextForEpoch } from './gmail-context';
import { holdPromptSnoozesForEpoch } from './today-snoozes';
import { discardContactPhotosForEpoch } from './contact-photos';
import { holdContactPhotosForEpoch, PHOTO_QUEUE_PREFIX, syncContactPhotos } from './contact-photo-outbox';
import { applyRemoteChild, childPayload, childTable, childReferences, pendingChildren, remoteEntity, stagePlanCompletion, discardPlanCompletionDrafts,
  CHILD_ENTITIES, CHILD_FIELDS, type ChildEntity, type QueueRow } from './sync-entities';

export type SyncSummary = { pending: number; conflicts: number; phoneOnly: number; lastSuccess: string | null };
export type ContactSyncReview = {
  contactId: string; name: string; reason: string; local: Record<string, unknown>;
  cloud: SyncContactRecord | null; changes: Record<string, unknown>; children: QueueRow[];
  mergedInto: SyncContactRecord | null;
};
type SyncOptions = { fetcher?: typeof fetch; isCurrent?: () => boolean };
export class NativeSyncError extends Error {
  constructor(message: string, public readonly code: string, public readonly status = 0) { super(message); }
}
const inFlight = new WeakMap<SQLiteDatabase, Promise<{ changed: number }>>();
const reviewing = new WeakSet<SQLiteDatabase>();
const dependencySql = CHILD_ENTITIES.flatMap((entity) => [
  `SELECT '${entity}' AS entity_type, id, contact_id FROM ${childTable(entity)}`,
  ...(entity === 'family' ? ["SELECT 'family' AS entity_type, id, linked_contact_id AS contact_id FROM contact_children WHERE linked_contact_id IS NOT NULL"]
    : entity === 'relationship' ? ["SELECT 'relationship' AS entity_type, id, related_contact_id AS contact_id FROM contact_relationships"] : []),
]).join(' UNION ALL ');

async function metadata(db: SQLiteDatabase, key: string) {
  return (await db.getFirstAsync<{ value: string }>('SELECT value FROM app_metadata WHERE key = ?', key))?.value ?? null;
}
async function saveMetadata(db: SQLiteDatabase, key: string, value: string) {
  await db.runAsync('INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', key, value, new Date().toISOString());
}
async function cursor(db: SQLiteDatabase) {
  const raw = await metadata(db, 'sync-cursor-v4');
  return raw ? readSyncCursor(JSON.parse(raw)) : null;
}
async function checkAccount(db: SQLiteDatabase, account: NativeAccount, isCurrent: () => boolean) {
  if (!isCurrent()) throw new NativeSyncError('The active account changed.', 'account_changed');
  if (await metadata(db, 'account-scope') !== accountScope(account)) throw new NativeSyncError('This cache belongs to another account.', 'account_changed');
}
async function remoteRecord(db: SQLiteDatabase, id: string) {
  const raw = await db.getFirstAsync<{ record_json: string }>('SELECT record_json FROM sync_remote_contacts WHERE id = ?', id);
  return raw ? readSyncRecord(JSON.parse(raw.record_json)) : null;
}
function patchPayload(row: Pick<QueueRow, 'operation' | 'payload'>): Record<string, unknown> {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  if (row.operation === 'create') return { name: payload.name, email: payload.email ?? null,
    phone: payload.phone ?? null, notes: payload.notes ?? null, contact_frequency: payload.contactFrequency ?? payload.contact_frequency ?? 14,
    ...Object.fromEntries(Object.entries(payload).filter(([field]) => (SYNC_WRITABLE_CONTACT_FIELDS as readonly string[]).includes(field) && field !== 'last_contacted')) };
  if ('lastContacted' in payload) return { last_contacted: typeof payload.lastContacted === 'string' ? payload.lastContacted.slice(0, 10) : null };
  return payload;
}

/** Overlay pending fields rather than replacing an offline draft with the cloud row. */
async function applyRemote(db: SQLiteDatabase, record: SyncContactRecord) {
  await registerContactAliases(db, record);
  await db.runAsync('INSERT INTO sync_remote_contacts (id, record_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json', record.id, JSON.stringify(record));
  const intents = await db.getAllAsync<QueueRow>("SELECT * FROM sync_queue WHERE entity_type = 'contact' AND entity_id = ? ORDER BY rowid", record.id);
  const local = await db.getFirstAsync<Record<string, string | number | null>>('SELECT * FROM contacts WHERE id = ?', record.id);
  if (record.deleted) {
    const canonical = await canonicalContactId(db, record.id);
    if (canonical !== record.id) {
      // A retired ID is still the identity on an uncertain request or an opening form.
      // Its draft remains available, but navigation and associations use the survivor.
      await db.runAsync("UPDATE contacts SET deleted_at = COALESCE(deleted_at, ?), sync_state = 'synced' WHERE id = ?", new Date().toISOString(), record.id);
      await reconcileMergedPeople(db, canonical);
      return;
    }
    const children = await pendingChildren(db, record.id);
    for (const child of children) {
      const localChild = await db.getFirstAsync<{ contact_id: string }>(`SELECT contact_id FROM ${childTable(child.entity_type as ChildEntity)} WHERE id = ?`, child.entity_id);
      const reason = localChild?.contact_id === record.id ? 'parent_deleted' : child.entity_type === 'family' ? 'linked_deleted' : 'related_deleted';
      await db.runAsync(`UPDATE sync_queue SET
      status = CASE WHEN request_json IS NOT NULL AND status = 'pending' THEN status ELSE 'conflict' END,
      last_error_code = CASE WHEN last_error_code = 'epoch_changed' OR request_json IS NOT NULL AND status = 'pending'
        THEN last_error_code ELSE ? END WHERE id = ?`, reason, child.id);
    }
    if (intents.length) {
      await db.runAsync(`UPDATE sync_queue SET
        status = CASE WHEN request_json IS NOT NULL AND status = 'pending' THEN status ELSE 'conflict' END,
        last_error_code = CASE WHEN last_error_code = 'epoch_changed' OR request_json IS NOT NULL AND status = 'pending'
          THEN last_error_code ELSE 'remote_deleted' END WHERE entity_type = 'contact' AND entity_id = ?`, record.id);
      await db.runAsync("UPDATE contacts SET sync_state = 'conflict' WHERE id = ?", record.id);
    } else await db.runAsync("UPDATE contacts SET deleted_at = ?, sync_state = 'synced' WHERE id = ?", new Date().toISOString(), record.id);
    return;
  }
  const protectedFields = new Set(intents.flatMap((row) => row.operation === 'delete' ? ['deleted_at'] : Object.keys(patchPayload(row))));
  if (protectedFields.has('contact_methods')) {
    protectedFields.add('email'); protectedFields.add('phone');
    if (local) {
      const preferred = readContactMethods(local.contact_methods);
      local.email = preferred.find((item) => item.kind === 'email' && item.preferred)?.value ?? null;
      local.phone = preferred.find((item) => item.kind === 'phone' && item.preferred)?.value ?? null;
    }
  }
  const pendingHistory = await db.getFirstAsync<{ date: string | null }>(`SELECT MAX(i.date) AS date FROM interactions i
    WHERE i.contact_id = ? AND i.deleted_at IS NULL AND (i.source_plan_id IS NOT NULL AND i.sync_state != 'synced'
      OR EXISTS (SELECT 1 FROM sync_queue q WHERE q.entity_type = 'interaction' AND q.entity_id = i.id AND q.operation != 'delete'))`, record.id);
  const values = { ...record.data! };
  if (values.source_links === undefined) values.source_links = local?.source_links ?? '[]';
  if (values.provider_links === undefined) values.provider_links = local?.provider_links ?? '[]';
  if (values.device_links === undefined) values.device_links = local?.device_links ?? '[]';
  if (values.contact_methods === undefined) {
    const existingMethods = local?.contact_methods ?? '[]', preferred = readContactMethods(existingMethods);
    values.contact_methods = (preferred.find((item) => item.kind === 'email' && item.preferred)?.value ?? null) === values.email
      && (preferred.find((item) => item.kind === 'phone' && item.preferred)?.value ?? null) === values.phone ? existingMethods
      : replacePrimaryContactMethods(existingMethods, { email: values.email as string | null, phone: values.phone as string | null }, Crypto.randomUUID);
  }
  if (!protectedFields.has('contact_methods') && local && (protectedFields.has('email') || protectedFields.has('phone'))) {
    values.contact_methods = replacePrimaryContactMethods(values.contact_methods, {
      ...(protectedFields.has('email') ? { email: local.email as string | null } : {}),
      ...(protectedFields.has('phone') ? { phone: local.phone as string | null } : {}),
    }, Crypto.randomUUID);
  }
  const aliasIntents = await db.getAllAsync<QueueRow>(`SELECT q.* FROM sync_queue q JOIN contact_aliases a ON a.id = q.entity_id
    WHERE q.entity_type = 'contact' AND a.canonical_id = ? AND q.operation = 'update' AND q.status = 'pending' ORDER BY q.rowid`, record.id);
  for (const intent of aliasIntents) {
    const base = intent.base_payload ? JSON.parse(intent.base_payload) as Record<string, unknown> : null;
    const patch = patchPayload(intent);
    if (base && Object.keys(patch).every((key) => base[key] === record.data![key])) {
      for (const [key, value] of Object.entries(patch)) if (!protectedFields.has(key)) values[key] = value as SyncValue;
    }
  }
  if (!protectedFields.has('last_contacted') && pendingHistory?.date && (!values.last_contacted || pendingHistory.date > String(values.last_contacted))) values.last_contacted = pendingHistory.date;
  const field = (key: string) => protectedFields.has(key) && local ? local[key] : values[key];
  const state = intents.some((row) => row.status === 'conflict') ? 'conflict' : intents.length || aliasIntents.length ? 'pending' : 'synced';
  await db.runAsync(`INSERT INTO contacts (id, remote_id, name, email, phone, birthday, how_we_met, notes,
    last_contacted, contact_frequency, created_at, updated_at, deleted_at, sync_state, contact_methods, source_links, provider_links, device_links)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET remote_id = excluded.remote_id, name = excluded.name,
    email = excluded.email, phone = excluded.phone, birthday = excluded.birthday, how_we_met = excluded.how_we_met,
    notes = excluded.notes, last_contacted = excluded.last_contacted, contact_frequency = excluded.contact_frequency,
    updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, sync_state = excluded.sync_state, contact_methods = excluded.contact_methods, source_links = excluded.source_links, provider_links = excluded.provider_links, device_links = excluded.device_links`,
  record.id, record.legacyId, field('name'), field('email'), field('phone'), field('birthday'), field('how_we_met'),
  field('notes'), field('last_contacted'), field('contact_frequency'), local?.created_at ?? values.created_at,
  intents.length && local ? local.updated_at : values.updated_at, protectedFields.has('deleted_at') ? local?.deleted_at ?? null : null, state, field('contact_methods') ?? '[]', values.source_links, values.provider_links, values.device_links);
  await applyDeviceSourceProjection(db, record.id, values.device_links);
  await reconcileMergedPeople(db, record.id);
  // Reparented unsent history also contributes to the survivor's displayed last touch.
  await db.runAsync(`UPDATE contacts SET last_contacted = MAX(COALESCE(last_contacted, ''), COALESCE((SELECT MAX(date) FROM interactions i
    WHERE i.contact_id = contacts.id AND i.deleted_at IS NULL AND (i.source_plan_id IS NOT NULL AND i.sync_state != 'synced'
      OR EXISTS (SELECT 1 FROM sync_queue q WHERE q.entity_type = 'interaction' AND q.entity_id = i.id AND q.operation != 'delete'))), ''))
    WHERE id = ? AND EXISTS (SELECT 1 FROM interactions i WHERE i.contact_id = contacts.id AND i.deleted_at IS NULL
      AND (i.source_plan_id IS NOT NULL AND i.sync_state != 'synced' OR EXISTS
        (SELECT 1 FROM sync_queue q WHERE q.entity_type = 'interaction' AND q.entity_id = i.id AND q.operation != 'delete')))`, record.id);
}

async function request(account: NativeAccount, path: string, fetcher: typeof fetch, isCurrent: () => boolean, body?: string) {
  if (!isCurrent()) throw new NativeSyncError('The active account changed.', 'account_changed');
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetcher(`${account.origin}${path}`, { method: body ? 'POST' : 'GET', credentials: 'omit',
      redirect: 'error', signal: controller.signal, headers: { Authorization: `Bearer ${account.token}`,
        Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body });
    const raw = await response.text();
    if (!isCurrent()) throw new NativeSyncError('The active account changed.', 'account_changed');
    if (new TextEncoder().encode(raw).byteLength > MAX_SYNC_PAGE_BYTES + 64 * 1024) throw new NativeSyncError('A contact download is too large. Keep offline data and reduce its size on the web.', 'response_too_large');
    let result: unknown;
    try { result = JSON.parse(raw); } catch { throw new NativeSyncError('The server did not return sync data. Keep offline data and retry.', 'invalid_response', response.status); }
    if (!response.ok) {
      const error = result as { error?: string; code?: string };
      const message = response.status === 401 ? 'Sign in again to resume syncing. Offline data is still here.'
        : response.status === 423 ? 'The cloud database is being maintained. Offline changes are safe on this phone.'
          : typeof error.error === 'string' ? error.error : 'Sync is unavailable. Offline data is still here.';
      throw new NativeSyncError(message, typeof error.code === 'string' ? error.code : `http_${response.status}`, response.status);
    }
    return result;
  } catch (error) {
    if (error instanceof NativeSyncError) throw error;
    throw new NativeSyncError('Unable to reach Everclose. Offline changes are safe on this phone.', 'network');
  } finally { clearTimeout(timeout); }
}

async function applyEntity(db: SQLiteDatabase, record: SyncEntityRecord) {
  if (record.entity === 'source_event') return applyRemoteCalendarEvent(db, record);
  if (record.entity === 'contact') return applyRemote(db, record);
  await applyRemoteChild(db, record as SyncEntityRecord & { entity: ChildEntity });
  await reconcileChildAliases(db, record.entity, record.id);
  const local = await db.getFirstAsync<{ contact_id: string }>(`SELECT contact_id FROM ${childTable(record.entity)} WHERE id = ?`, record.id);
  if (local) { const parent = await remoteRecord(db, local.contact_id); if (parent && !parent.deleted) await applyRemote(db, parent); }
}
async function reconcileChildAliases(db: SQLiteDatabase, entity: ChildEntity, id: string) {
  const draft = await db.getFirstAsync<Record<string, SyncValue>>(`SELECT * FROM ${childTable(entity)} WHERE id = ?`, id);
  if (draft) for (const reference of childReferences(entity, draft)) {
    const target = await canonicalContactId(db, reference);
    if (target !== reference) await reconcileMergedPeople(db, target);
  }
}

async function bootstrap(db: SQLiteDatabase, account: NativeAccount, fetcher: typeof fetch, isCurrent: () => boolean) {
  await db.runAsync('DELETE FROM sync_bootstrap_entities');
  let next: SyncBootstrapPosition | null = null, head: SyncCursor | null = null;
  let changed = 0;
  do {
    const params = next ? `?epoch=${next.epoch}&sequence=${next.sequence}&entity=${next.entity}&after=${next.after}` : '';
    const page = readBootstrapV4(await request(account, `/api/v4/sync/bootstrap${params}`, fetcher, isCurrent));
    if (head && (head.epoch !== page.cursor.epoch || head.sequence !== page.cursor.sequence)
      || next && page.records.some((record) => `${record.entity}:${record.id}` <= `${next!.entity}:${next!.after}`)) {
      throw new NativeSyncError('The download changed. Retry the download.', 'bootstrap_changed');
    }
    head = page.cursor;
    await db.withExclusiveTransactionAsync(async (tx) => {
      await checkAccount(tx, account, isCurrent);
      for (const record of page.records) await tx.runAsync('INSERT INTO sync_bootstrap_entities (entity_type, id, record_json) VALUES (?, ?, ?)', record.entity, record.id, JSON.stringify(record));
    });
    next = page.next;
  } while (next);
  await db.withExclusiveTransactionAsync(async (tx) => {
    await checkAccount(tx, account, isCurrent);
    const old = await cursor(tx);
    await holdDevicePoliciesForEpoch(tx, head!.epoch);
    await holdCalendarLinksForEpoch(tx, head!.epoch);
    await holdAppleCalendarForEpoch(tx, head!.epoch);
    await discardGmailContextForEpoch(tx, head!.epoch);
    await holdPromptSnoozesForEpoch(tx, head!.epoch);
    await discardContactPhotosForEpoch(tx, head!.epoch);
    await holdContactPhotosForEpoch(tx, head!.epoch);
    const legacy = old ? null : await metadata(tx, 'sync-cursor-v3') ?? await metadata(tx, 'sync-cursor-v2') ?? await metadata(tx, 'sync-cursor');
    const previous = old ?? (legacy ? readSyncCursor(JSON.parse(legacy)) : null);
    if (previous && previous.epoch !== head!.epoch) {
      await tx.runAsync("UPDATE sync_queue SET status = 'conflict', last_error_code = 'epoch_changed' WHERE epoch IS NULL OR epoch != ?", head!.epoch);
    } else await tx.runAsync("UPDATE sync_queue SET status = 'conflict', last_error_code = 'epoch_changed' WHERE epoch IS NOT NULL AND epoch != ?", head!.epoch);
    // Rebuild from this complete download; never carry aliases across a restored dataset.
    await tx.runAsync('DELETE FROM contact_aliases');
    let aliasAfter = '';
    for (;;) {
      const records = await tx.getAllAsync<{ id: string; record_json: string }>(`SELECT id, record_json FROM sync_bootstrap_entities
        WHERE entity_type = 'contact' AND id > ? ORDER BY id LIMIT 10`, aliasAfter);
      if (!records.length) break;
      for (const row of records) await registerContactAliases(tx, readSyncRecord(JSON.parse(row.record_json)));
      aliasAfter = records.at(-1)!.id;
    }
    // Restore can reuse integer IDs; clear these mappings before publishing replacements.
    for (const table of ['contacts', ...CHILD_ENTITIES.map(childTable)]) await tx.runAsync(`UPDATE ${table} SET remote_id = NULL`);
    let removedAfter = '';
    for (;;) {
      const removed = await tx.getAllAsync<{ id: string; record_json: string }>(`SELECT id, record_json FROM sync_remote_contacts WHERE id > ?
        AND NOT EXISTS (SELECT 1 FROM sync_bootstrap_entities s WHERE s.entity_type = 'contact' AND s.id = sync_remote_contacts.id) ORDER BY id LIMIT 10`, removedAfter);
      if (!removed.length) break;
      for (const row of removed) {
        const oldRecord = { ...readSyncRecord(JSON.parse(row.record_json)) };
        delete oldRecord.mergedIntoId;
        const target = await canonicalContactId(tx, row.id);
        await applyRemote(tx, { ...oldRecord, deleted: true, data: null, ...(target !== row.id ? { mergedIntoId: target } : {}) }); changed++;
      }
      removedAfter = removed.at(-1)!.id;
    }
    let removedChildAfter = '';
    for (;;) {
      const removed = await tx.getAllAsync<{ entity_type: ChildEntity; id: string; record_json: string }>(`SELECT entity_type, id, record_json FROM sync_remote_entities
        WHERE entity_type || ':' || id > ? AND NOT EXISTS (SELECT 1 FROM sync_bootstrap_entities s WHERE s.entity_type = sync_remote_entities.entity_type AND s.id = sync_remote_entities.id)
        ORDER BY entity_type, id LIMIT 10`, removedChildAfter);
      if (!removed.length) break;
      for (const row of removed) { await applyEntity(tx, { ...JSON.parse(row.record_json), deleted: true, data: null }); changed++; }
      removedChildAfter = `${removed.at(-1)!.entity_type}:${removed.at(-1)!.id}`;
    }
    await tx.runAsync('DELETE FROM calendar_events');
    let after = '';
    for (;;) {
      const staged = await tx.getAllAsync<{ entity_type: string; id: string; record_json: string }>(`SELECT entity_type, id, record_json FROM sync_bootstrap_entities
        WHERE entity_type || ':' || id > ? ORDER BY entity_type, id LIMIT 10`, after);
      if (!staged.length) break;
      for (const row of staged) { await applyEntity(tx, JSON.parse(row.record_json)); changed++; }
      after = `${staged.at(-1)!.entity_type}:${staged.at(-1)!.id}`;
    }
    await saveMetadata(tx, 'sync-cursor-v4', JSON.stringify(head));
    await saveMetadata(tx, 'sync-cursor-v3', JSON.stringify(head));
    await saveMetadata(tx, 'sync-cursor-v2', JSON.stringify(head));
    await saveMetadata(tx, 'sync-cursor', JSON.stringify(head));
    await tx.runAsync('DELETE FROM sync_bootstrap_entities');
  });
  return changed;
}

async function pull(db: SQLiteDatabase, account: NativeAccount, fetcher: typeof fetch, isCurrent: () => boolean) {
  let position = await cursor(db), changed = 0;
  if (!position) return bootstrap(db, account, fetcher, isCurrent);
  let more: boolean;
  do {
    const page = readPullV4(await request(account, `/api/v4/sync/pull?epoch=${position.epoch}&sequence=${position.sequence}`, fetcher, isCurrent), position);
    await db.withExclusiveTransactionAsync(async (tx) => {
      await checkAccount(tx, account, isCurrent);
      for (const record of page.records) { await applyEntity(tx, record); changed++; }
      await saveMetadata(tx, 'sync-cursor-v4', JSON.stringify(page.cursor));
      await saveMetadata(tx, 'sync-cursor-v3', JSON.stringify(page.cursor));
      await saveMetadata(tx, 'sync-cursor-v2', JSON.stringify(page.cursor));
      await saveMetadata(tx, 'sync-cursor', JSON.stringify(page.cursor));
    });
    position = page.cursor; more = page.more;
  } while (more);
  return changed;
}

async function freezeNext(db: SQLiteDatabase, account: NativeAccount, isCurrent: () => boolean): Promise<{ row: QueueRow; body: string } | null> {
  let frozen: { row: QueueRow; body: string } | null = null;
  await db.withExclusiveTransactionAsync(async (tx) => {
    await checkAccount(tx, account, isCurrent);
    const position = await cursor(tx);
    if (!position) return;
    const row = await tx.getFirstAsync<QueueRow>(`SELECT q.* FROM sync_queue q WHERE q.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM sync_queue earlier WHERE earlier.entity_type = q.entity_type AND earlier.entity_id = q.entity_id AND earlier.rowid < q.rowid)
      AND (q.entity_type = 'contact' OR q.request_json IS NOT NULL OR (
        EXISTS (SELECT 1 FROM (${dependencySql}) dependency WHERE dependency.entity_type = q.entity_type AND dependency.id = q.entity_id)
        AND NOT EXISTS (SELECT 1 FROM (${dependencySql}) dependency LEFT JOIN contacts c ON c.id = dependency.contact_id
          WHERE dependency.entity_type = q.entity_type AND dependency.id = q.entity_id
            AND (c.id IS NULL OR c.deleted_at IS NOT NULL OR c.remote_id IS NULL
              OR EXISTS (SELECT 1 FROM sync_queue parent WHERE parent.entity_type = 'contact' AND parent.entity_id = c.id AND parent.operation = 'delete')))))
      ORDER BY q.rowid LIMIT 1`);
    if (!row) return;
    if (row.epoch && row.epoch !== position.epoch) {
      await tx.runAsync("UPDATE sync_queue SET status = 'conflict', last_error_code = 'epoch_changed' WHERE id = ?", row.id); return;
    }
    if (row.request_json) { frozen = { row, body: row.request_json }; return; }
    const remote = await remoteEntity(tx, row.entity_type, row.entity_id);
    const payload = row.entity_type === 'contact' ? patchPayload(row) : childPayload(row);
    let mutation: SyncEntityMutation;
    const identity = { operationId: row.id, entity: row.entity_type, entityId: row.entity_id };
    if (row.operation === 'create') mutation = { ...identity, type: 'create', data: payload };
    else {
      const canonicalId = row.entity_type === 'contact' ? await canonicalContactId(tx, row.entity_id) : row.entity_id;
      const canonical = canonicalId !== row.entity_id ? await remoteRecord(tx, canonicalId) : null;
      const mergedUpdate = row.operation === 'update' && canonical && !canonical.deleted;
      if (!remote || remote.deleted && !mergedUpdate || row.operation === 'update' && !row.base_payload) {
        await tx.runAsync("UPDATE sync_queue SET status = 'conflict', last_error_code = 'missing_base' WHERE id = ?", row.id); return;
      }
      mutation = row.operation === 'delete' ? { ...identity, type: 'delete', baseRevision: row.base_revision ?? remote.revision }
        : { ...identity, type: 'update', baseRevision: row.base_revision ?? remote.revision, base: JSON.parse(row.base_payload!), patch: payload };
    }
    const body = JSON.stringify({ version: 4, epoch: position.epoch, mutation } satisfies SyncPushRequest);
    if (new TextEncoder().encode(body).byteLength > MAX_SYNC_PUSH_BYTES) {
      await tx.runAsync("UPDATE sync_queue SET status = 'conflict', last_error_code = 'request_too_large' WHERE id = ?", row.id); return;
    }
    await tx.runAsync('UPDATE sync_queue SET request_json = ?, epoch = ? WHERE id = ?', body, position.epoch, row.id);
    frozen = { row, body };
  });
  return frozen as { row: QueueRow; body: string } | null;
}

async function push(db: SQLiteDatabase, account: NativeAccount, fetcher: typeof fetch, isCurrent: () => boolean) {
  let changed = 0;
  // Bound foreground work; a later run continues a larger queue.
  for (let sent = 0; sent < 30; sent++) {
    const frozen = await freezeNext(db, account, isCurrent);
    if (!frozen) break;
    let value: unknown;
    const version = (JSON.parse(frozen.body) as { version: number }).version;
    try { value = await request(account, `/api/v${version}/sync/push`, fetcher, isCurrent, frozen.body); }
    catch (error) {
      if (error instanceof NativeSyncError && error.code === 'account_changed') throw error;
      if (error instanceof NativeSyncError && [400, 409, 413].includes(error.status) && error.code !== 'epoch_changed') {
        await db.withExclusiveTransactionAsync(async (tx) => {
          await checkAccount(tx, account, isCurrent);
          await tx.runAsync("UPDATE sync_queue SET status = 'conflict', last_error_code = ? WHERE id = ?", error.code, frozen.row.id);
          if (frozen.row.entity_type !== 'contact') {
            await reconcileChildAliases(tx, frozen.row.entity_type, frozen.row.entity_id);
          }
        });
        changed++; continue;
      }
      await db.runAsync('UPDATE sync_queue SET attempt_count = attempt_count + 1, last_error_code = ? WHERE id = ?', error instanceof NativeSyncError ? error.code : 'invalid_response', frozen.row.id);
      throw error;
    }
    const result = version === 1
      ? (() => { const legacy = readPushResult(value, frozen.row.id, frozen.row.entity_id); return { ...legacy, record: legacy.record ? { ...legacy.record, entity: 'contact' as const } : null,
        canonicalRecord: legacy.canonicalRecord ? { ...legacy.canonicalRecord, entity: 'contact' as const } : undefined }; })()
      : version === 2 ? readPushResultV2(value, frozen.row.id, frozen.row.entity_type as SyncEntity, frozen.row.entity_id)
        : version === 3 ? readPushResultV3(value, frozen.row.id, frozen.row.entity_type, frozen.row.entity_id)
          : readPushResultV4(value, frozen.row.id, frozen.row.entity_type, frozen.row.entity_id);
    await db.withExclusiveTransactionAsync(async (tx) => {
      await checkAccount(tx, account, isCurrent);
      if (result.status === 'applied') await tx.runAsync('DELETE FROM sync_queue WHERE id = ? AND request_json = ?', frozen.row.id, frozen.body);
      else await tx.runAsync("UPDATE sync_queue SET status = 'conflict', response_json = ?, last_error_code = 'overlapping_edit' WHERE id = ? AND request_json = ?", JSON.stringify(result), frozen.row.id, frozen.body);
      if (result.canonicalRecord) {
        const current = await remoteRecord(tx, result.canonicalRecord.id);
        await applyRemote(tx, current && current.revision > result.canonicalRecord.revision ? current : result.canonicalRecord);
      }
      // A receipt can be older than a pull that saw the successful write or a later web edit.
      if (result.record) {
        const current = await remoteEntity(tx, frozen.row.entity_type, result.record.id);
        await applyEntity(tx, current && current.revision > result.record.revision ? current : result.record);
      }
      if (result.status === 'conflict' && frozen.row.entity_type !== 'contact') await reconcileChildAliases(tx, frozen.row.entity_type, frozen.row.entity_id);
    });
    changed++;
  }
  return changed;
}

export function syncWorkspace(db: SQLiteDatabase, account: NativeAccount, options: SyncOptions = {}) {
  if (reviewing.has(db)) return Promise.reject(new NativeSyncError('An offline change is being reviewed. Retry sync when it is saved.', 'reviewing'));
  const existing = inFlight.get(db);
  if (existing) return existing;
  const isCurrent = options.isCurrent ?? (() => true), fetcher = options.fetcher ?? fetch;
  const running = (async () => {
    await checkAccount(db, account, isCurrent);
    let changed = 0;
    try { changed += await pull(db, account, fetcher, isCurrent); }
    catch (error) {
      if (!(error instanceof NativeSyncError) || error.code !== 'epoch_changed') throw error;
      changed += await bootstrap(db, account, fetcher, isCurrent);
    }
    try { changed += await push(db, account, fetcher, isCurrent); }
    catch (error) {
      if (!(error instanceof NativeSyncError) || error.code !== 'epoch_changed') throw error;
      changed += await bootstrap(db, account, fetcher, isCurrent);
    }
    changed += await pull(db, account, fetcher, isCurrent);
    const sourcePush = async () => {
      const position = await cursor(db);
      if (!position) return 0;
      return syncDeviceSources(db, position.epoch,
        (body) => request(account, '/api/v1/device-sources/push', fetcher, isCurrent, body),
        (tx) => checkAccount(tx, account, isCurrent));
    };
    try { changed += await sourcePush(); }
    catch (error) {
      if (!(error instanceof NativeSyncError) || error.code !== 'epoch_changed') throw error;
      changed += await bootstrap(db, account, fetcher, isCurrent);
      changed += await sourcePush();
    }
    changed += await pull(db, account, fetcher, isCurrent);
    const calendarPush = async () => {
      const position = await cursor(db);
      return position ? syncCalendarLinks(db, position.epoch,
        (body) => request(account, '/api/v1/calendar-event-links/push', fetcher, isCurrent, body),
        (tx) => checkAccount(tx, account, isCurrent)) : 0;
    };
    try { changed += await calendarPush(); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'epoch_changed') throw error;
      changed += await bootstrap(db, account, fetcher, isCurrent);
      changed += await calendarPush();
    }
    changed += await pull(db, account, fetcher, isCurrent);
    const photoPush = async () => {
      const position = await cursor(db);
      return position ? syncContactPhotos(db, position.epoch,
        (id, body) => request(account, `/api/v1/contact-photos/${id}`, fetcher, isCurrent, body),
        (tx) => checkAccount(tx, account, isCurrent)) : 0;
    };
    try { changed += await photoPush(); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'epoch_changed') throw error;
      changed += await bootstrap(db, account, fetcher, isCurrent);
      changed += await photoPush();
    }
    changed += await pull(db, account, fetcher, isCurrent);
    await checkAccount(db, account, isCurrent);
    await saveMetadata(db, 'sync-last-success', new Date().toISOString());
    return { changed };
  })();
  inFlight.set(db, running);
  void running.finally(() => { if (inFlight.get(db) === running) inFlight.delete(db); }).catch(() => {});
  return running;
}

// Retain the earlier internal entry point for already integrated callers.
export const syncContacts = syncWorkspace;

export async function syncSummary(db: SQLiteDatabase): Promise<SyncSummary> {
  const totals = await db.getFirstAsync<{ pending: number; conflicts: number; phoneOnly: number }>(`SELECT
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status = 'conflict' THEN 1 ELSE 0 END) AS conflicts,
    0 AS phoneOnly FROM (SELECT status FROM sync_queue UNION ALL SELECT status FROM device_source_queue UNION ALL SELECT status FROM calendar_event_link_queue UNION ALL SELECT status FROM today_snooze_queue
      UNION ALL SELECT json_extract(value, '$.status') status FROM app_metadata WHERE key LIKE ? AND json_valid(value))`, PHOTO_QUEUE_PREFIX + '%');
  return { pending: totals?.pending ?? 0, conflicts: totals?.conflicts ?? 0, phoneOnly: totals?.phoneOnly ?? 0,
    lastSuccess: await metadata(db, 'sync-last-success') };
}

export async function contactSyncReviews(db: SQLiteDatabase): Promise<ContactSyncReview[]> {
  const ids = await db.getAllAsync<{ entity_id: string }>(`SELECT DISTINCT entity_id FROM (
    SELECT entity_id FROM sync_queue WHERE entity_type = 'contact' AND status = 'conflict'
    UNION SELECT dependency.contact_id AS entity_id FROM (${dependencySql}) dependency JOIN sync_queue q
      ON q.entity_type = dependency.entity_type AND q.entity_id = dependency.id WHERE q.status = 'conflict'
  ) LIMIT 100`);
  const reviews: ContactSyncReview[] = [];
  for (const { entity_id: contactId } of ids) {
    const local = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM contacts WHERE id = ?', contactId);
    const rows = await db.getAllAsync<QueueRow>("SELECT * FROM sync_queue WHERE entity_type = 'contact' AND entity_id = ? ORDER BY rowid", contactId);
    const cloud = await remoteRecord(db, contactId), children = await pendingChildren(db, contactId);
    const canonicalId = await canonicalContactId(db, contactId);
    const mergedInto = canonicalId !== contactId ? await remoteRecord(db, canonicalId) : null;
    if (!rows.some((row) => row.status === 'conflict') && cloud && !cloud.deleted) continue;
    reviews.push({ contactId, children, name: String(local?.name ?? 'Offline contact'), reason: rows.find((row) => row.status === 'conflict')?.last_error_code ?? children.find((row) => row.status === 'conflict')?.last_error_code ?? 'overlapping_edit',
      local: local ?? {}, cloud, mergedInto, changes: Object.assign({}, ...rows.filter((row) => row.operation !== 'delete').map(patchPayload)) });
  }
  return reviews;
}

async function copyChildDraft(db: SQLiteDatabase, entity: ChildEntity, local: Record<string, SyncValue>, contactId: string, now: string, overrides: Record<string, SyncValue> = {}) {
  const id = Crypto.randomUUID(), table = childTable(entity);
  const draft: Record<string, SyncValue> = { ...local, ...overrides, id, contact_id: contactId };
  const pendingCompletion = entity === 'plan' && local.completed_at != null
    && await db.getFirstAsync("SELECT id FROM sync_queue WHERE entity_type = 'plan' AND entity_id = ? AND operation = 'update' AND json_type(payload, '$.completed_at') = 'text'", String(local.id));
  const columns = ['contact_id', ...CHILD_FIELDS[entity], 'created_at', 'updated_at', 'sync_state'];
  const data: Record<string, SyncValue> = { ...Object.fromEntries(CHILD_FIELDS[entity].map((key) => [key, draft[key]])), contact_id: contactId };
  if (pendingCompletion) data.completed_at = null;
  await db.runAsync(`INSERT INTO ${table} (id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`,
    id, contactId, ...CHILD_FIELDS[entity].map((key) => draft[key]), local.created_at, now, 'pending');
  const operation = await enqueueSyncIntent(db, entity, id, 'create', data, now);
  if (pendingCompletion) await stagePlanCompletion(db, draft, String(local.completed_at), null);
  for (const reference of childReferences(entity, draft)) {
    if (!await db.getFirstAsync('SELECT id FROM contacts WHERE id = ? AND deleted_at IS NULL', reference)) {
      const reason = reference === contactId ? 'parent_deleted' : entity === 'family' ? 'linked_deleted' : 'related_deleted';
      await db.runAsync("UPDATE sync_queue SET status = 'conflict', last_error_code = ? WHERE id = ?", reason, operation);
      await db.runAsync(`UPDATE ${table} SET sync_state = 'conflict' WHERE id = ?`, id);
    }
  }
  return id;
}

export type ChildSyncReview = {
  entity: ChildEntity; entityId: string; contactId: string; contactName: string; reason: string;
  local: Record<string, SyncValue>; cloud: SyncEntityRecord | null; changes: Record<string, unknown>;
  operation: 'update' | 'delete'; rows: QueueRow[];
};
export async function childSyncReviews(db: SQLiteDatabase): Promise<ChildSyncReview[]> {
  const ids = await db.getAllAsync<{ entity_type: ChildEntity; entity_id: string }>("SELECT DISTINCT entity_type, entity_id FROM sync_queue WHERE entity_type != 'contact' AND status = 'conflict' LIMIT 100");
  const reviews: ChildSyncReview[] = [];
  for (const { entity_type: entity, entity_id: entityId } of ids) {
    const local = await db.getFirstAsync<Record<string, SyncValue>>(`SELECT * FROM ${childTable(entity)} WHERE id = ?`, entityId);
    if (!local) continue;
    const rows = await db.getAllAsync<QueueRow>('SELECT * FROM sync_queue WHERE entity_type = ? AND entity_id = ? ORDER BY rowid', entity, entityId);
    const parent = await db.getFirstAsync<{ name: string }>('SELECT name FROM contacts WHERE id = ?', String(local.contact_id));
    reviews.push({ entity, entityId, contactId: String(local.contact_id), contactName: parent?.name ?? 'Removed person',
      reason: rows.find((row) => row.status === 'conflict')?.last_error_code ?? 'overlapping_edit', local,
      cloud: await remoteEntity(db, entity, entityId), changes: Object.assign({}, ...rows.filter((row) => row.operation !== 'delete').map(childPayload)),
      operation: rows.some((row) => row.operation === 'delete') ? 'delete' : 'update', rows });
  }
  return reviews;
}

export async function resolveChildSyncReview(db: SQLiteDatabase, review: ChildSyncReview, choice: 'cloud' | 'phone' | 'copy') {
  if (inFlight.has(db) || reviewing.has(db)) throw new Error('Sync or another review is still running. Wait for it to finish before choosing.');
  reviewing.add(db);
  try { await db.withExclusiveTransactionAsync(async (tx) => {
    const current = (await childSyncReviews(tx)).find((row) => row.entity === review.entity && row.entityId === review.entityId);
    if (!current || JSON.stringify(current) !== JSON.stringify(review)) throw new Error('This review changed. Refresh it before choosing a version.');
    const position = await cursor(tx);
    if (!position) throw new Error('Download current data before reviewing this change.');
    const table = childTable(current.entity), now = new Date().toISOString();
    if (current.reason === 'merged_self_link' && choice !== 'cloud') throw new Error('These profiles were merged into one person. Keep the draft for review or use the cloud result; a person cannot be linked to themselves.');
    if (choice !== 'cloud') {
      for (const reference of childReferences(current.entity, current.local)) {
        const parent = await remoteRecord(tx, reference);
        const localParent = await tx.getFirstAsync<{ deleted_at: string | null }>('SELECT deleted_at FROM contacts WHERE id = ?', reference);
        if (!parent || parent.deleted || !localParent || localParent.deleted_at) throw new Error('A connected person was removed. Review and copy that person draft first, or use the cloud version.');
      }
    }
    if (choice === 'phone' && (!current.cloud || current.cloud.deleted)) throw new Error('This cloud item was removed. Keep the draft or explicitly copy it with a new identity.');
    if (choice === 'copy' && current.cloud && !current.cloud.deleted) throw new Error('This cloud item still exists. Review its values before sending changes.');
    if (choice === 'phone' && current.entity === 'plan' && current.changes.completed_at != null && current.cloud?.data?.completed_at != null) {
      throw new Error('This plan was already completed in the cloud. Keep the draft for review or use the cloud result; another activity must be logged separately.');
    }
    if (choice === 'cloud' && current.entity === 'plan') await discardPlanCompletionDrafts(tx, current.entityId);
    // Copy reads the old completion intent before explicit review retires it.
    if (choice === 'copy') await copyChildDraft(tx, current.entity, current.local, current.contactId, now);
    await tx.runAsync('DELETE FROM sync_queue WHERE entity_type = ? AND entity_id = ?', current.entity, current.entityId);
    if (choice === 'copy') {
      if (current.entity === 'plan') await discardPlanCompletionDrafts(tx, current.entityId);
      await tx.runAsync(`UPDATE ${table} SET deleted_at = ?, sync_state = 'synced' WHERE id = ?`, now, current.entityId);
      return;
    }
    if (choice === 'phone') {
      const patch = Object.fromEntries(Object.entries(current.changes).filter(([key]) => (CHILD_FIELDS[current.entity] as readonly string[]).includes(key)
        && !(current.entity === 'relationship' && key === 'related_contact_id')));
      if (current.operation !== 'delete' && !Object.keys(patch).length) throw new Error('There is no supported change to send.');
      const base = Object.fromEntries(Object.keys(patch).map((key) => [key, current.cloud!.data![key] ?? null])) as Record<string, SyncValue>;
      if (current.entity === 'plan' && patch.completed_at != null && current.operation !== 'delete') {
        await discardPlanCompletionDrafts(tx, current.entityId);
        const fields = Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'completed_at'));
        if (Object.keys(fields).length) await enqueueSyncIntent(tx, current.entity, current.entityId, 'update', fields, now,
          { revision: current.cloud!.revision, values: Object.fromEntries(Object.keys(fields).map((key) => [key, base[key]])) });
        await stagePlanCompletion(tx, { ...current.local, ...patch } as Record<string, SyncValue>, String(patch.completed_at), current.cloud!.revision);
      } else await enqueueSyncIntent(tx, current.entity, current.entityId, current.operation, patch, now, { revision: current.cloud!.revision, values: base });
    }
    if (current.cloud) await applyEntity(tx, current.cloud);
    else {
      await tx.runAsync(`UPDATE ${table} SET deleted_at = ?, sync_state = 'synced' WHERE id = ?`, now, current.entityId);
      const parent = await remoteRecord(tx, current.contactId);
      if (parent && !parent.deleted) await applyRemote(tx, parent);
    }
  }); } finally { reviewing.delete(db); }
}

/** A review is invalidated if the server row or pending edits changed while it was open. */
export async function resolveContactSyncReview(db: SQLiteDatabase, review: ContactSyncReview, choice: 'cloud' | 'phone' | 'copy') {
  if (inFlight.has(db) || reviewing.has(db)) throw new Error('Sync or another review is still running. Wait for it to finish before choosing.');
  reviewing.add(db);
  try { await db.withExclusiveTransactionAsync(async (tx) => {
    const current = (await contactSyncReviews(tx)).find((item) => item.contactId === review.contactId);
    if (!current || JSON.stringify(current) !== JSON.stringify(review)) throw new Error('This review changed. Refresh it before choosing a version.');
    const position = await cursor(tx);
    if (!position) throw new Error('Download the current contacts before reviewing this change.');
    const target = current.mergedInto ?? current.cloud;
    if (choice === 'phone' && (!target || target.deleted)) throw new Error('The cloud person was removed. Your offline draft is preserved; copy it to a new person after reviewing the restore.');
    if (choice === 'copy') {
      if (target && !target.deleted) throw new Error('This cloud person still exists. Review its current values before sending phone changes.');
      const local = await tx.getFirstAsync<Record<string, SyncValue>>('SELECT * FROM contacts WHERE id = ?', review.contactId);
      if (!local) throw new Error('The offline contact draft is no longer available.');
      const id = Crypto.randomUUID(), now = new Date().toISOString();
      const copiedMethods = readContactMethods(local.contact_methods).map((item) => ({ ...item, id: Crypto.randomUUID(), source: 'manual' as const, source_value: null, user_override: true }));
      const copiedMethodsJson = normalizeUserContactMethods(copiedMethods);
      // A reviewed copy has entirely new identities. Never retarget a frozen child request.
      await tx.runAsync("UPDATE contacts SET deleted_at = ?, sync_state = 'synced' WHERE id = ?", now, review.contactId);
      await tx.runAsync(`INSERT INTO contacts (id, device_contact_id, name, email, phone, birthday, how_we_met, notes,
        last_contacted, contact_frequency, created_at, updated_at, sync_state)
        SELECT ?, device_contact_id, name, email, phone, birthday, how_we_met, notes, last_contacted, contact_frequency, ?, ?, 'pending'
        FROM contacts WHERE id = ?`, id, now, now, review.contactId);
      await tx.runAsync("DELETE FROM sync_queue WHERE entity_type = 'contact' AND entity_id = ?", review.contactId);
      await tx.runAsync('UPDATE contacts SET contact_methods = ? WHERE id = ?', copiedMethodsJson, id);
      await enqueueSyncIntent(tx, 'contact', id, 'create', { contact_methods: copiedMethodsJson, name: local.name, email: local.email, phone: local.phone,
        notes: local.notes, birthday: local.birthday, how_we_met: local.how_we_met, contact_frequency: local.contact_frequency }, now);
      if (local.last_contacted) await enqueueSyncIntent(tx, 'contact', id, 'update', { last_contacted: local.last_contacted }, now,
        { revision: null, values: { last_contacted: null } });
      for (const entity of CHILD_ENTITIES) {
        const table = childTable(entity);
        const association = `contact_id = ? ${entity === 'relationship' ? 'OR related_contact_id = ?' : entity === 'family' ? 'OR linked_contact_id = ?' : ''}`;
        const associatedValues = entity === 'relationship' || entity === 'family' ? [review.contactId, review.contactId] : [review.contactId];
        let after = '';
        for (;;) {
          const drafts = await tx.getAllAsync<Record<string, SyncValue>>(`SELECT * FROM ${table} item WHERE (${association}) AND id > ?
            AND (deleted_at IS NULL OR EXISTS (SELECT 1 FROM sync_queue q WHERE q.entity_type = ? AND q.entity_id = item.id AND q.operation != 'delete'))
            AND NOT EXISTS (SELECT 1 FROM sync_queue q WHERE q.entity_type = ? AND q.entity_id = item.id AND q.operation = 'delete')
            ${entity === 'interaction' ? `AND NOT (source_plan_id IS NOT NULL AND remote_id IS NULL AND EXISTS (SELECT 1 FROM sync_queue plan
              WHERE plan.entity_type = 'plan' AND plan.entity_id = item.source_plan_id AND plan.operation = 'update' AND json_type(plan.payload, '$.completed_at') = 'text')
              AND NOT EXISTS (SELECT 1 FROM sync_queue removed WHERE removed.entity_type = 'plan' AND removed.entity_id = item.source_plan_id AND removed.operation = 'delete'))` : ''}
            ORDER BY id LIMIT 10`, ...associatedValues, after, entity, entity);
          if (!drafts.length) break;
          for (const draft of drafts) {
            const parent = draft.contact_id === review.contactId ? id : String(draft.contact_id);
            const overrides: Record<string, SyncValue> = {};
            if (entity === 'relationship' && draft.related_contact_id === review.contactId) overrides.related_contact_id = id;
            if (entity === 'family' && draft.linked_contact_id === review.contactId) overrides.linked_contact_id = id;
            const existing = entity === 'family' && draft.contact_id !== review.contactId ? await remoteEntity(tx, entity, String(draft.id)) : null;
            if (existing && !existing.deleted) {
              const patch = { ...Object.fromEntries(CHILD_FIELDS.family.map((key) => [key, draft[key]])), ...overrides };
              await tx.runAsync('DELETE FROM sync_queue WHERE entity_type = ? AND entity_id = ?', entity, draft.id);
              await tx.runAsync("UPDATE contact_children SET linked_contact_id = ?, updated_at = ?, sync_state = 'pending' WHERE id = ?", id, now, draft.id);
              await enqueueSyncIntent(tx, entity, String(draft.id), 'update', patch, now, { revision: existing.revision,
                values: Object.fromEntries(Object.keys(patch).map((key) => [key, existing.data![key]])) });
            } else {
              await copyChildDraft(tx, entity, draft, parent, now, overrides);
              await tx.runAsync('DELETE FROM sync_queue WHERE entity_type = ? AND entity_id = ?', entity, draft.id);
              await tx.runAsync(`UPDATE ${table} SET deleted_at = COALESCE(deleted_at, ?), sync_state = 'synced' WHERE id = ?`, now, draft.id);
              if (entity === 'plan') await discardPlanCompletionDrafts(tx, String(draft.id));
            }
          }
          after = String(drafts.at(-1)!.id);
        }
        await tx.runAsync(`DELETE FROM sync_queue WHERE entity_type = ? AND operation = 'delete' AND entity_id IN (SELECT id FROM ${table} WHERE ${association})`, entity, ...associatedValues);
      }
      return;
    }
    const methodOriginal = await tx.getFirstAsync<{ base_payload: string }>(`SELECT base_payload FROM sync_queue WHERE entity_type = 'contact' AND entity_id = ?
      AND json_type(payload, '$.contact_methods') = 'text' ORDER BY rowid LIMIT 1`, review.contactId);
    await tx.runAsync("DELETE FROM sync_queue WHERE entity_type = 'contact' AND entity_id = ?", review.contactId);
    if (choice === 'phone') {
      const patch = Object.fromEntries(Object.entries(current.changes).filter(([key]) => (SYNC_WRITABLE_CONTACT_FIELDS as readonly string[]).includes(key)));
      if (typeof patch.contact_methods === 'string') {
        patch.contact_methods = reviewContactMethodsPatch(methodOriginal ? JSON.parse(methodOriginal.base_payload).contact_methods : '[]', patch.contact_methods, target!.data!.contact_methods);
        patch.contact_methods = replacePrimaryContactMethods(patch.contact_methods, {
          ...('email' in patch ? { email: patch.email as string | null } : {}), ...('phone' in patch ? { phone: patch.phone as string | null } : {}),
        }, Crypto.randomUUID);
        delete patch.email; delete patch.phone;
      }
      if (!Object.keys(patch).length) throw new Error('There is no supported contact edit to send.');
      const base = Object.fromEntries(Object.keys(patch).map((key) => [key, target!.data![key] ?? null])) as Record<string, SyncValue>;
      await tx.runAsync(`INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, created_at, epoch, base_revision, base_payload)
        VALUES (?, 'contact', ?, 'update', ?, ?, ?, ?, ?)`, Crypto.randomUUID(), target!.id, JSON.stringify(patch),
      new Date().toISOString(), position.epoch, target!.revision, JSON.stringify(base));
      // A reviewed choice starts a fresh operation against the combined profile.
      await tx.runAsync(`UPDATE contacts SET ${Object.keys(patch).map((key) => `${key} = ?`).join(', ')}, sync_state = 'pending' WHERE id = ?`, ...Object.values(patch) as (string | number | null)[], target!.id);
    }
    if (current.cloud) await applyRemote(tx, current.cloud);
    else await tx.runAsync("UPDATE contacts SET deleted_at = ?, sync_state = 'synced' WHERE id = ?", new Date().toISOString(), review.contactId);
    if (current.mergedInto) await applyRemote(tx, current.mergedInto);
  }); } finally { reviewing.delete(db); }
}
