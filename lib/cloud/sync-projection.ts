import { calendarEventProjectionSql } from './calendar-event-projection';
import { SOURCE_PROJECTION_COLUMNS } from '@/packages/domain/src/contact-sources';
import { PROVIDER_SOURCE_COLUMNS } from '@/packages/domain/src/provider-sources';
import { DEVICE_SOURCE_COLUMNS } from '@/packages/domain/src/device-sources';

export const SYNC_CONTACT_FIELDS = [
  'source_revision',
  'contact_methods',
  'name', 'nickname', 'email', 'phone', 'birthday', 'birthday_reminder_days',
  'how_we_met', 'tags', 'notes', 'gift_ideas', 'custom_fields', 'last_contacted',
  'contact_frequency', 'created_at', 'updated_at',
  'merge_aliases',
] as const;

export function syncContactProjectionSql(alias = 'c') {
  return `json_object(${SYNC_CONTACT_FIELDS.map((field) => `'${field}', ${alias}.${field}`).join(', ')},
    'source_links', COALESCE((SELECT json_group_array(json(projection)) FROM
      (SELECT json_object(${SOURCE_PROJECTION_COLUMNS.map((field) => `'${field}', link.${field}`).join(', ')}) AS projection
       FROM contact_source_links link WHERE link.workspace_id = ${alias}.workspace_id AND link.contact_id = ${alias}.id ORDER BY link.id)), '[]') || '',
    'provider_links', COALESCE((SELECT json_group_array(json(projection)) FROM
      (SELECT json_object(${PROVIDER_SOURCE_COLUMNS.map((field) => `'${field}', link.${field}`).join(', ')}) AS projection
       FROM contact_provider_links link WHERE link.workspace_id = ${alias}.workspace_id AND link.contact_id = ${alias}.id ORDER BY link.id)), '[]') || '',
    'device_links', COALESCE((SELECT json_group_array(json(projection)) FROM
      (SELECT json_object(${DEVICE_SOURCE_COLUMNS.map((field) => `'${field}', link.${field}`).join(', ')}) AS projection
       FROM contact_device_links link WHERE link.workspace_id = ${alias}.workspace_id AND link.contact_id = ${alias}.id ORDER BY link.id)), '[]') || '',
    'photo_available', CASE WHEN ${alias}.photo_url IS NOT NULL THEN 1 ELSE 0 END)`;
}

export function deviceSourceGraphChecks() {
  return [
    `SELECT 1 FROM contact_device_links WHERE workspace_id = ? GROUP BY contact_id HAVING COUNT(*) > 32
      OR length(CAST(json_group_array(json_object(${DEVICE_SOURCE_COLUMNS.map((key) => `'${key}', ${key}`).join(', ')})) AS BLOB)) > 131072 LIMIT 1`,
    `SELECT 1 FROM contacts c WHERE c.workspace_id = ? AND length(CAST(${syncContactProjectionSql()} AS BLOB)) > 522240 LIMIT 1`,
  ];
}

export const SYNC_CHILD_ENTITIES = ['family', 'interaction', 'plan', 'relationship', 'reminder'] as const;
export type SyncChildEntity = typeof SYNC_CHILD_ENTITIES[number];
export const SYNC_ENTITY_TABLES = {
  family: 'contact_children', interaction: 'interactions', plan: 'plans',
  relationship: 'contact_relationships', reminder: 'reminders',
} as const;
export const SYNC_CHILD_FIELDS = {
  interaction: ['date', 'occurred_at', 'type', 'summary', 'notes', 'created_at'],
  reminder: ['title', 'notes', 'remind_at', 'completed_at', 'created_at'],
  plan: ['type', 'planned_date', 'summary', 'notes', 'completed_at', 'created_at'],
  family: ['name', 'birthday', 'created_at', 'updated_at'],
  relationship: ['relationship_label', 'reciprocal_label', 'created_at'],
} as const;
export function syncChildProjectionSql(entity: SyncChildEntity, alias = 'item', parent = 'parent') {
  const reference = entity === 'family' ? 'linked_contact_id' : entity === 'relationship' ? 'related_contact_id' : null;
  return `json_object('contact_id', ${parent}.public_id, ${reference ? `'${reference}',
    (SELECT public_id FROM contacts linked WHERE linked.id = ${alias}.${reference} AND linked.workspace_id = ${alias}.workspace_id), ` : ''}${SYNC_CHILD_FIELDS[entity]
    .map((field) => `'${field}', ${alias}.${field}`).join(', ')})`;
}

/** Recovery replaces the dataset, so devices must reconcile using a fresh epoch. */
export function pauseCloudSyncStatements(db: CloudflareEnv['DB'], workspaceId: string) {
  return [
    db.prepare('UPDATE workspace_sync_state SET epoch = ?, paused = 1, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?')
      .bind(crypto.randomUUID(), workspaceId),
    ...['sync_contact_records', 'sync_entity_records', 'sync_changes', 'sync_mutation_receipts', 'contact_merge_aliases'].map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).bind(workspaceId)),
  ];
}

export function resumeCloudSyncStatements(db: CloudflareEnv['DB'], workspaceId: string) {
  return [
    db.prepare('DELETE FROM contact_merge_aliases WHERE workspace_id = ?').bind(workspaceId),
    db.prepare(`INSERT INTO contact_merge_aliases (workspace_id, public_id, canonical_public_id)
      SELECT c.workspace_id, aliases.value, c.public_id FROM contacts c, json_each(c.merge_aliases) aliases WHERE c.workspace_id = ?`).bind(workspaceId),
    db.prepare('DELETE FROM sync_contact_records WHERE workspace_id = ?').bind(workspaceId),
    db.prepare('DELETE FROM sync_entity_records WHERE workspace_id = ?').bind(workspaceId),
    db.prepare(`INSERT INTO sync_contact_records (workspace_id, public_id, legacy_id, revision, payload)
      SELECT c.workspace_id, c.public_id, c.id, 1, ${syncContactProjectionSql()} FROM contacts c WHERE c.workspace_id = ?`)
      .bind(workspaceId),
    ...SYNC_CHILD_ENTITIES.map((entity) => db.prepare(`INSERT INTO sync_entity_records
      (workspace_id, entity_type, public_id, legacy_id, revision, payload)
      SELECT item.workspace_id, ?, item.public_id, item.id, 1, ${syncChildProjectionSql(entity)}
      FROM ${SYNC_ENTITY_TABLES[entity]} item
      JOIN contacts parent ON parent.id = item.contact_id AND parent.workspace_id = item.workspace_id
      WHERE item.workspace_id = ?`).bind(entity, workspaceId)),
    db.prepare(`INSERT INTO sync_entity_records (workspace_id, entity_type, public_id, legacy_id, revision, payload) SELECT e.workspace_id, 'source_event', e.public_id, e.id, 1, ${calendarEventProjectionSql()} FROM calendar_events e WHERE e.workspace_id = ?`).bind(workspaceId),
    db.prepare('UPDATE workspace_sync_state SET paused = 0, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?')
      .bind(workspaceId),
  ];
}
