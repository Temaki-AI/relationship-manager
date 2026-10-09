import { getTableColumns } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { contacts, contactRelationships, contactChildren, interactions, reminders, dailySnoozes, contactGroups, contactGroupMembers, relationshipFacts, integrationConnections, syncJobs, plans, contactSourceLinks, contactProviderLinks, providerFieldRules, contactDeviceLinks, calendarEvents, calendarEventPeople, calendarEventPlans } from '@/lib/cloud/schema';
import { readCalendarEventFacts } from '@/packages/domain/src/calendar-events';
import { calendarIdentifier } from '@/packages/domain/src/calendars';
import { parseDateOnly } from '@/lib/relationship-validation';
import { parseTodaySnoozeTarget } from '@/lib/today-snooze';
import { readContactMethods } from '@/packages/domain/src/contact-methods';
import { readContactMergeAliases } from '@/packages/domain/src/contact-aliases';
import { readContactSources, SOURCE_PROJECTION_COLUMNS } from '@/packages/domain/src/contact-sources';
import { readAppliedProviderFields, readProviderSources, PROVIDER_SOURCE_COLUMNS } from '@/packages/domain/src/provider-sources';
import { SYNC_CONTACT_FIELDS } from './sync-projection';
import { readProviderRules } from '@/packages/domain/src/provider-rules';
import { deviceSourceProjection, DEVICE_SOURCE_COLUMNS } from '@/packages/domain/src/device-sources';

export const SNAPSHOT_SCHEMA = {
  contacts, contact_groups: contactGroups, contact_relationships: contactRelationships,
  contact_children: contactChildren, interactions, reminders, daily_snoozes: dailySnoozes, contact_group_members: contactGroupMembers,
  relationship_facts: relationshipFacts, integration_connections: integrationConnections, sync_jobs: syncJobs, plans, contact_source_links: contactSourceLinks, contact_provider_links: contactProviderLinks, provider_field_rules: providerFieldRules, contact_device_links: contactDeviceLinks,
  calendar_events: calendarEvents, calendar_event_people: calendarEventPeople, calendar_event_plans: calendarEventPlans,
};
export type SnapshotTable = keyof typeof SNAPSHOT_SCHEMA;
export const SNAPSHOT_TABLES = Object.keys(SNAPSHOT_SCHEMA) as SnapshotTable[];
export const MAX_CLOUD_BACKUP_BYTES = 16 * 1024 * 1024;
export const CLOUD_BACKUP_RETENTION = 20;
export type SnapshotRow = Record<string, string | number | null>;
export type CloudSnapshot = {
  format: 'bonds-cloud-backup';
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
  workspaceId: string;
  createdAt: string;
  workspace?: { name: string; persona: string | null };
  tables: Record<SnapshotTable, SnapshotRow[]>;
};

export class CloudRecoveryError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = 'CloudRecoveryError'; }
}

export function recoveryErrorResponse(error: unknown): Response | null {
  if (error instanceof CloudRecoveryError) return Response.json({ error: error.message }, { status: error.status });
  const message = error instanceof Error ? error.message : '';
  if (message.includes('CLOUD_BACKUP_TOO_LARGE')) return Response.json({ error: 'This workspace exceeds the 16 MB interactive recovery limit. No data was changed. A larger, resumable recovery job is required.' }, { status: 413 });
  if (message.includes('CLOUD_RECOVERY_CONFLICT')) return Response.json({ error: 'Your workspace or recovery file changed during this operation. No data was replaced or deleted. Refresh and try again.' }, { status: 409 });
  if (message.includes('CLOUD_WORKSPACE_ERASING')) return Response.json({ error: 'Workspace maintenance is in progress. Open Data & recovery before making changes.' }, { status: 409 });
  if (message.includes('CLOUD_CHILD_LINK_INVALID')) return Response.json({ error: 'The linked profile changed or belongs to another workspace. Refresh and try again.' }, { status: 409 });
  return null;
}

export function snapshotColumns(table: SnapshotTable) {
  return Object.values(getTableColumns(SNAPSHOT_SCHEMA[table]));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidSnapshot(message: string): never { throw new CloudRecoveryError(message, 400); }

// Legacy snapshots did not carry public IDs. Derive the same UUID on each read
// so resumable restore and its independent verification agree on the identity.
function legacyMethods(workspaceId: string, row: Record<string, unknown>) {
  const values: Array<{ kind: string; value: string; label: string | null; preferred: boolean }> = [];
  for (const kind of ['email', 'phone']) if (typeof row[kind] === 'string' && String(row[kind]).trim()) values.push({ kind, value: String(row[kind]), label: null, preferred: true });
  let custom: Record<string, unknown> = {}; try { custom = JSON.parse(String(row.custom_fields ?? '{}')); } catch { /* Older raw context remains preserved. */ }
  const vcard = record(custom.vcard) ? custom.vcard : {};
  for (const [key, kind] of [['additional_emails', 'email'], ['additional_phones', 'phone']]) if (Array.isArray(vcard[key])) {
    for (const value of vcard[key]) if (typeof value === 'string' && value.trim()) values.push({ kind, value, label: null, preferred: false });
  }
  if (record(custom.social)) for (const [label, value] of Object.entries(custom.social)) if (typeof value === 'string' && value.trim()) values.push({ kind: 'profile', value, label, preferred: false });
  return JSON.stringify(values.map((item, index) => ({ id: legacyContactId(`${workspaceId}:method:${index}:${item.kind}:${item.value}`, row.id),
    ...item, country: null, source: 'legacy', source_value: item.value, user_override: false })));
}
function legacyContactId(workspaceId: string, id: unknown): string {
  const digest = createHash('sha1').update(new Uint8Array([
    0x74, 0xea, 0x62, 0xc8, 0xd3, 0x99, 0x49, 0x3c, 0xb0, 0x58, 0x48, 0xeb, 0xd1, 0x8e, 0xe7, 0xaf,
  ])).update(`${workspaceId}:${id}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${((parseInt(digest[16], 16) & 3) | 8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function validateSnapshotRows(table: SnapshotTable, sourceRows: unknown, workspaceId: string, version: CloudSnapshot['version']): SnapshotRow[] {
  if (!Array.isArray(sourceRows) || sourceRows.length > 100_000) return invalidSnapshot(`Invalid or oversized ${table} table.`);
  const columns = snapshotColumns(table);
  const names = new Set(columns.map((column) => column.name));
  const seen = new Set<number | string>();
  const publicIds = new Set<string>();
  return sourceRows.map((sourceRow, index) => {
    if (!record(sourceRow)) return invalidSnapshot(`Unsupported data in ${table} row ${index + 1}.`);
    let row = sourceRow;
    if (table === 'contacts' && version < 10 && row.source_revision === undefined) row = { ...row, source_revision: 0 };
    if (table === 'contacts' && version < 9 && row.contact_methods === undefined) row = { ...row, contact_methods: legacyMethods(workspaceId, row) };
    if (table === 'contacts' && version < 8 && row.merge_aliases === undefined) row = { ...row, merge_aliases: '[]' };
    if (table === 'contact_children' && version < 4 && row.linked_contact_id === undefined) row = { ...row, linked_contact_id: null };
    if (table === 'contacts' && version < 5 && row.public_id === undefined) row = { ...row, public_id: legacyContactId(workspaceId, row.id) };
    if ((table === 'interactions' || table === 'reminders') && version < 6 && row.public_id === undefined) {
      row = { ...row, public_id: legacyContactId(`${workspaceId}:${table}`, row.id) };
    }
    if (['plans', 'contact_children', 'contact_relationships'].includes(table) && version < 7 && row.public_id === undefined) {
      row = { ...row, public_id: legacyContactId(`${workspaceId}:${table}`, row.id) };
    }
    if (table === 'interactions' && version < 6 && row.occurred_at === undefined) row = { ...row, occurred_at: null };
    if (Object.keys(row).some((key) => !names.has(key))) return invalidSnapshot(`Unsupported data in ${table} row ${index + 1}.`);
    if (row.workspace_id !== workspaceId) return invalidSnapshot(`Cross-workspace data in ${table}.`);
    for (const column of columns) {
      const field = row[column.name];
      if (field === undefined || (field === null && column.notNull)) return invalidSnapshot(`Missing ${column.name} in ${table}.`);
      if (field === null) continue;
      if (column.dataType === 'number' ? typeof field !== 'number' || !Number.isFinite(field) : typeof field !== 'string') return invalidSnapshot(`Invalid ${column.name} in ${table}.`);
      if (typeof field === 'string' && field.length > 1_000_000) return invalidSnapshot(`Oversized ${column.name} in ${table}.`);
      if (column.name === 'public_id') {
        if (typeof field !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(field)) return invalidSnapshot(`Invalid public identifier in ${table}.`);
        if (publicIds.has(field)) return invalidSnapshot(`Duplicate public identifier in ${table}.`);
        publicIds.add(field);
      } else if (table === 'daily_snoozes' && column.name === 'id') {
        if (!parseTodaySnoozeTarget(field)) return invalidSnapshot(`Invalid prompt identifier in ${table}.`);
      } else if ((column.name === 'id' || column.name.endsWith('_id') && column.name !== 'workspace_id'
        && !(['contact_source_links', 'contact_provider_links', 'contact_device_links', 'calendar_events'].includes(table) && column.name === 'external_id')
        && !(table === 'contact_device_links' && column.name === 'installation_id')) && (!Number.isSafeInteger(field) || Number(field) < 1)) return invalidSnapshot(`Invalid identifier in ${table}.`);
    }
    if (table === 'daily_snoozes' && !parseDateOnly(row.until_date)) return invalidSnapshot(`Invalid snooze date in ${table}.`);
    if (table === 'contacts') {
      try { readContactMergeAliases(row.merge_aliases, String(row.public_id)); readContactMethods(row.contact_methods); }
      catch { return invalidSnapshot('Invalid merged contact identities.'); }
      if (!Number.isSafeInteger(row.source_revision) || Number(row.source_revision) < 0) return invalidSnapshot('Invalid contact source revision.');
    }
    if (table === 'contact_source_links') {
      try { readContactSources(JSON.stringify([Object.fromEntries(SOURCE_PROJECTION_COLUMNS.map((key) => [key, row[key]]))])); }
      catch { return invalidSnapshot('Invalid contact source facts.'); }
    }
    if (table === 'contact_provider_links') {
      try { readProviderSources(JSON.stringify([Object.fromEntries(PROVIDER_SOURCE_COLUMNS.map((key) => [key, row[key]]))])); }
      catch { return invalidSnapshot('Invalid authenticated provider source facts.'); }
    }
    if (table === 'provider_field_rules') {
      try { readProviderRules(row.fields); } catch { return invalidSnapshot('Invalid source field settings.'); }
      if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1) return invalidSnapshot('Invalid field settings revision.');
    }
    if (table === 'contact_device_links') {
      try { deviceSourceProjection(row); } catch { return invalidSnapshot('Invalid device source observations.'); }
    }
    if (table === 'calendar_events') {
      try {
        const facts = readCalendarEventFacts(JSON.parse(String(row.facts))); calendarIdentifier(row.external_id); calendarIdentifier(row.calendar_key); calendarIdentifier(row.account_key);
        new Intl.DateTimeFormat('en', { timeZone: String(row.calendar_time_zone) });
        if (facts.id !== row.external_id || row.provider !== 'google-calendar' || !['available', 'unavailable'].includes(String(row.availability))
          || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || String(row.account_key).length > 512
          || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(String(row.account_email)) || String(row.account_email).length > 320
          || !String(row.calendar_label).trim() || String(row.calendar_label).length > 500 || /[\u0000-\u001f\u007f]/u.test(String(row.calendar_label))
          || ['observed_at', 'created_at', 'updated_at'].some((key) => !Number.isFinite(Date.parse(String(row[key]))))) throw new Error();
      } catch { return invalidSnapshot('Invalid saved calendar event.'); }
    }
    if ('id' in row) {
      const id = table === 'daily_snoozes' ? String(row.id) : Number(row.id);
      if (seen.has(id)) return invalidSnapshot(`Duplicate identifier in ${table}.`);
      seen.add(id);
    }
    return row as SnapshotRow;
  });
}

/** Validate the whole graph before creating a recovery point or changing data. */
export function validateCloudSnapshot(value: unknown, workspaceId: string): CloudSnapshot {
  const invalid = invalidSnapshot;
  if (!record(value) || value.format !== 'bonds-cloud-backup' || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].includes(Number(value.version)) || typeof value.version !== 'number') return invalid('This is not a supported cloud backup. Local SQLite backups cannot be restored into cloud mode.');
  if (value.workspaceId !== workspaceId) return invalid('This backup belongs to a different workspace.');
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !record(value.tables)) return invalid('The backup manifest is incomplete.');
  if (Object.keys(value.tables).some((table) => !SNAPSHOT_TABLES.includes(table as SnapshotTable))) return invalid('The backup contains unsupported tables.');
  if (value.workspace !== undefined && (!record(value.workspace) || typeof value.workspace.name !== 'string' || !value.workspace.name.trim() || value.workspace.name.length > 200 || (value.workspace.persona !== null && typeof value.workspace.persona !== 'string'))) return invalid('Invalid workspace metadata.');
  const tables = {} as CloudSnapshot['tables'];
  const ids = new Map<SnapshotTable, Set<number | string>>();
  for (const table of SNAPSHOT_TABLES) {
    const rows = (table === 'daily_snoozes' && value.version < 3 || table === 'contact_source_links' && value.version < 10 || table === 'contact_provider_links' && value.version < 11 || table === 'provider_field_rules' && value.version < 12 || table === 'contact_device_links' && value.version < 13 || table.startsWith('calendar_event') && value.version < 14) && value.tables[table] === undefined
      ? [] : value.tables[table];
    tables[table] = validateSnapshotRows(table, rows, workspaceId, value.version as CloudSnapshot['version']);
    ids.set(table, new Set(tables[table].filter((row) => row.id !== undefined)
      .map((row) => table === 'daily_snoozes' ? String(row.id) : Number(row.id))));
  }
  const pairs = new Set<string>();
  const sourceKeys = new Set<string>();
  const sourceCollections = new Map<number, Record<string, unknown>[]>(), providerCollections = new Map<number, Record<string, unknown>[]>(), deviceCollections = new Map<number, Record<string, unknown>[]>();
  for (const [rows, collections, columns] of [[tables.contact_source_links, sourceCollections, SOURCE_PROJECTION_COLUMNS], [tables.contact_provider_links, providerCollections, PROVIDER_SOURCE_COLUMNS], [tables.contact_device_links, deviceCollections, DEVICE_SOURCE_COLUMNS]] as const) {
    for (const link of rows) {
      const id = Number(link.contact_id), collection = collections.get(id) ?? [];
      collection.push(Object.fromEntries(columns.map((column) => [column, link[column]]))); collections.set(id, collection);
    }
    for (const collection of collections.values()) if (collection.length > 32 || new TextEncoder().encode(JSON.stringify(collection)).byteLength > 131072) return invalid('Too many or oversized contact sources.');
  }
  const ruleSources = new Set<number>(), authorities = new Set<string>(), ruleCollections = new Map<number, unknown[]>();
  for (const row of tables.provider_field_rules) {
    const link = tables.contact_provider_links.find((link) => link.id === row.source_link_id);
    if (!link || ruleSources.has(Number(row.source_link_id))) return invalid('Missing or repeated source field settings.');
    ruleSources.add(Number(row.source_link_id));
    const fields = readProviderRules(row.fields), audit = readAppliedProviderFields(link.applied_fields);
    for (const method of fields.methods) if (!audit.methods.some((item) => item.method.id === method.id && item.method.kind === method.kind)) return invalid('Source field settings reference an unaccepted method.');
    const followed = [...(fields.name.mode === 'follow' ? ['name'] : []), ...fields.methods.filter((method) => method.mode === 'follow').map((method) => method.id)];
    for (const field of followed) { const key = link.contact_id + ':' + field; if (authorities.has(key)) return invalid('More than one source follows the same contact field.'); authorities.add(key); }
    const collection = ruleCollections.get(Number(link.contact_id)) ?? [];
    collection.push({ source_public_id: link.public_id, revision: row.revision, fields }); ruleCollections.set(Number(link.contact_id), collection);
  }
  for (const collection of ruleCollections.values()) if (new TextEncoder().encode(JSON.stringify(collection)).byteLength > 131072) return invalid('Oversized source field settings.');
  for (const contact of tables.contacts) {
    const projection = { ...Object.fromEntries(SYNC_CONTACT_FIELDS.map((field) => [field, contact[field]])),
      source_links: JSON.stringify(sourceCollections.get(Number(contact.id)) ?? []), provider_links: JSON.stringify(providerCollections.get(Number(contact.id)) ?? []), device_links: JSON.stringify(deviceCollections.get(Number(contact.id)) ?? []), photo_available: contact.photo_url === null ? 0 : 1 };
    if (new TextEncoder().encode(JSON.stringify(projection)).byteLength > 522240) return invalid('A contact is too large for device sync.');
  }
  const linkedChildren = new Set<string>();
  const activeContactIds = new Set(tables.contacts.map((row) => String(row.public_id)));
  const retiredContactIds = new Set<string>();
  for (const row of tables.contacts) for (const alias of readContactMergeAliases(row.merge_aliases, String(row.public_id))) {
    if (activeContactIds.has(alias) || retiredContactIds.has(alias)) return invalid('A merged contact identity has more than one owner.');
    retiredContactIds.add(alias);
  }
  const remindersById = new Map(tables.reminders.map((row) => [Number(row.id), row]));
  const calendarKeys = new Set<string>(), eventPeople = new Set<string>(), eventPlans = new Set<number>(), eventCounts = new Map<string, number>();
  for (const table of SNAPSHOT_TABLES) for (const row of tables[table]) {
    if (row.contact_id !== undefined && !ids.get('contacts')!.has(Number(row.contact_id))) return invalid(`Missing contact referenced by ${table}.`);
    if (row.group_id !== undefined && !ids.get('contact_groups')!.has(Number(row.group_id))) return invalid('Missing group referenced by membership.');
    if (table === 'calendar_events') { const key = JSON.stringify([row.provider, row.account_key, row.calendar_key, row.external_id]); if (calendarKeys.has(key)) return invalid('Duplicate saved calendar event.'); calendarKeys.add(key); }
    if (table === 'calendar_event_people' || table === 'calendar_event_plans') {
      if (!ids.get('calendar_events')!.has(Number(row.event_id))) return invalid('Missing saved event.');
      const countKey = table + ':' + row.event_id, count = (eventCounts.get(countKey) ?? 0) + 1; eventCounts.set(countKey, count); if (count > 20) return invalid('Too many saved event associations.');
      if (table === 'calendar_event_people') { const key = row.event_id + ':' + row.contact_id; if (eventPeople.has(key)) return invalid('Duplicate event person.'); eventPeople.add(key); }
      else { if (!ids.get('plans')!.has(Number(row.plan_id)) || eventPlans.has(Number(row.plan_id))) return invalid('Missing or multiply linked event plan.'); eventPlans.add(Number(row.plan_id)); }
    }
    if (table === 'contact_source_links' || table === 'contact_provider_links') {
      const key = JSON.stringify([row.provider, row.account_key, row.external_id]);
      if (sourceKeys.has(key)) return invalid('An external profile is linked more than once.');
      sourceKeys.add(key);
    }
    if (table === 'contact_device_links') {
      const key = JSON.stringify(['device', row.installation_id, row.external_id]);
      if (sourceKeys.has(key)) return invalid('An iPhone source is linked more than once.'); sourceKeys.add(key);
    }
    if (table === 'contact_relationships') {
      if (!ids.get('contacts')!.has(Number(row.related_contact_id)) || row.contact_id === row.related_contact_id) return invalid('Invalid related contact.');
      const pair = [row.contact_id, row.related_contact_id].sort().join(':');
      if (pairs.has(pair)) return invalid('The backup contains duplicate relationships.');
      pairs.add(pair);
    }
    if (table === 'contact_children' && row.linked_contact_id !== null) {
      if (!ids.get('contacts')!.has(Number(row.linked_contact_id)) || row.linked_contact_id === row.contact_id) return invalid('Invalid linked child profile.');
      const pair = `${row.contact_id}:${row.linked_contact_id}`;
      if (linkedChildren.has(pair)) return invalid('Duplicate linked child profile.');
      linkedChildren.add(pair);
    }
    if (table === 'daily_snoozes') {
      const target = parseTodaySnoozeTarget(row.id);
      if (!target) return invalid('Invalid snoozed prompt.');
      if (target.kind === 'reminder') {
        const reminder = remindersById.get(target.id);
        if (row.reminder_id !== target.id || !reminder || reminder.contact_id !== row.contact_id) return invalid('Invalid snoozed reminder.');
      } else if (row.reminder_id !== null || row.contact_id !== target.id) return invalid('Invalid snoozed contact prompt.');
    }
  }
  return { format: 'bonds-cloud-backup', version: value.version as CloudSnapshot['version'], workspaceId, createdAt: value.createdAt, workspace: value.workspace as CloudSnapshot['workspace'], tables };
}
