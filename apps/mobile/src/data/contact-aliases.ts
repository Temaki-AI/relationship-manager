import type { SQLiteDatabase } from 'expo-sqlite';
import { readContactMergeAliases } from '../../../../packages/domain/src/contact-aliases';
import type { SyncContactRecord } from '../../../../packages/domain/src/sync';
import { CHILD_ENTITIES, childTable } from './sync-entities';

export async function canonicalContactId(db: SQLiteDatabase, id: string) {
  return (await db.getFirstAsync<{ canonical_id: string }>('SELECT canonical_id FROM contact_aliases WHERE id = ?', id))?.canonical_id ?? id;
}

export async function registerContactAliases(db: SQLiteDatabase, record: SyncContactRecord) {
  const aliases = record.deleted ? [] : readContactMergeAliases(record.data?.merge_aliases, record.id);
  for (const id of aliases) await db.runAsync('INSERT INTO contact_aliases (id, canonical_id) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET canonical_id = excluded.canonical_id', id, record.id);
  if (record.mergedIntoId) {
    const target = await canonicalContactId(db, record.mergedIntoId);
    if (target === record.id) throw new Error('A merged contact cannot point back to itself.');
    await db.runAsync('UPDATE contact_aliases SET canonical_id = ? WHERE canonical_id = ?', target, record.id);
    await db.runAsync('INSERT INTO contact_aliases (id, canonical_id) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET canonical_id = excluded.canonical_id', record.id, target);
  }
}

/** Reparent local associations; never rewrite an intent or an uncertain request body. */
export async function reconcileMergedPeople(db: SQLiteDatabase, canonicalId: string) {
  if (!await db.getFirstAsync('SELECT id FROM contacts WHERE id = ? AND deleted_at IS NULL', canonicalId)) return;
  const aliases = await db.getAllAsync<{ id: string }>('SELECT id FROM contact_aliases WHERE canonical_id = ?', canonicalId);
  for (const { id } of aliases) {
    await db.runAsync('UPDATE device_contact_links SET contact_id = ? WHERE contact_id = ?', canonicalId, id);
    for (const entity of CHILD_ENTITIES) {
      const table = childTable(entity), extra = entity === 'relationship' ? 'related_contact_id' : entity === 'family' ? 'linked_contact_id' : null;
      if (extra) {
        // A merge can collapse both endpoints. Keep that draft for explicit review.
        const self = `((contact_id = ? AND (${extra} = ? OR ${extra} = ?)) OR (${extra} = ? AND contact_id = ?))`;
        const values = [id, id, canonicalId, id, canonicalId];
        await db.runAsync(`UPDATE sync_queue SET status = 'conflict', last_error_code = CASE WHEN last_error_code = 'epoch_changed'
          THEN last_error_code ELSE 'merged_self_link' END WHERE entity_type = ? AND (request_json IS NULL OR status = 'conflict') AND entity_id IN (SELECT id FROM ${table} WHERE ${self})`, entity, ...values);
        await db.runAsync(`UPDATE ${table} SET sync_state = 'conflict' WHERE ${self} AND EXISTS
          (SELECT 1 FROM sync_queue q WHERE q.entity_type = ? AND q.entity_id = ${table}.id AND q.status = 'conflict')`, ...values, entity);
        await db.runAsync(`UPDATE ${table} SET contact_id = CASE WHEN contact_id = ? THEN ? ELSE contact_id END,
          ${extra} = CASE WHEN ${extra} = ? THEN ? ELSE ${extra} END WHERE (contact_id = ? OR ${extra} = ?) AND NOT ${self}`,
          id, canonicalId, id, canonicalId, id, id, ...values);
      } else await db.runAsync(`UPDATE ${table} SET contact_id = ? WHERE contact_id = ?`, canonicalId, id);
      await db.runAsync(`UPDATE sync_queue SET status = 'pending', last_error_code = NULL WHERE entity_type = ?
        AND last_error_code IN ('parent_deleted', 'related_deleted', 'linked_deleted', 'missing_base') AND entity_id IN
          (SELECT item.id FROM ${table} item WHERE (contact_id = ? ${extra ? `OR ${extra} = ?` : ''})
            AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = item.contact_id AND c.deleted_at IS NULL)
            ${extra ? `AND (item.${extra} IS NULL OR EXISTS (SELECT 1 FROM contacts c WHERE c.id = item.${extra} AND c.deleted_at IS NULL))` : ''})`, entity, canonicalId, ...(extra ? [canonicalId] : []));
      await db.runAsync(`UPDATE ${table} SET sync_state = CASE WHEN EXISTS (SELECT 1 FROM sync_queue q WHERE q.entity_type = ?
        AND q.entity_id = ${table}.id AND q.status = 'conflict') THEN 'conflict' ELSE 'pending' END
        WHERE (contact_id = ? ${extra ? `OR ${extra} = ?` : ''}) AND EXISTS
        (SELECT 1 FROM sync_queue q WHERE q.entity_type = ? AND q.entity_id = ${table}.id)`, entity, canonicalId, ...(extra ? [canonicalId] : []), entity);
    }
    await db.runAsync(`UPDATE sync_queue SET status = 'pending', last_error_code = NULL WHERE entity_type = 'contact' AND entity_id = ?
      AND operation = 'update' AND last_error_code IN ('remote_deleted', 'missing_base')`, id);
    await db.runAsync(`UPDATE sync_queue SET status = 'conflict', last_error_code = 'merged_contact_delete'
      WHERE entity_type = 'contact' AND entity_id = ? AND operation = 'delete' AND request_json IS NULL AND last_error_code IS NOT 'epoch_changed'`, id);
    await db.runAsync(`UPDATE contacts SET deleted_at = COALESCE(deleted_at, ?), sync_state = CASE WHEN EXISTS
      (SELECT 1 FROM sync_queue WHERE entity_type = 'contact' AND entity_id = contacts.id AND status = 'conflict') THEN 'conflict' ELSE 'synced' END WHERE id = ?`, new Date().toISOString(), id);
  }
}
