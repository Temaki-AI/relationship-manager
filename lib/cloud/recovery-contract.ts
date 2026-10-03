import { getTableColumns } from 'drizzle-orm';
import { contacts, contactRelationships, contactChildren, interactions, reminders, dailySnoozes, contactGroups, contactGroupMembers, relationshipFacts, integrationConnections, syncJobs, plans } from '@/lib/cloud/schema';
import { parseDateOnly } from '@/lib/relationship-validation';
import { parseTodaySnoozeTarget } from '@/lib/today-snooze';

export const SNAPSHOT_SCHEMA = {
  contacts, contact_groups: contactGroups, contact_relationships: contactRelationships,
  contact_children: contactChildren, interactions, reminders, daily_snoozes: dailySnoozes, contact_group_members: contactGroupMembers,
  relationship_facts: relationshipFacts, integration_connections: integrationConnections, sync_jobs: syncJobs, plans,
};
export type SnapshotTable = keyof typeof SNAPSHOT_SCHEMA;
export const SNAPSHOT_TABLES = Object.keys(SNAPSHOT_SCHEMA) as SnapshotTable[];
export const MAX_CLOUD_BACKUP_BYTES = 16 * 1024 * 1024;
export const CLOUD_BACKUP_RETENTION = 20;
export type SnapshotRow = Record<string, string | number | null>;
export type CloudSnapshot = {
  format: 'bonds-cloud-backup';
  version: 1 | 2 | 3 | 4;
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

export function validateSnapshotRows(table: SnapshotTable, sourceRows: unknown, workspaceId: string, version: CloudSnapshot['version']): SnapshotRow[] {
  if (!Array.isArray(sourceRows) || sourceRows.length > 100_000) return invalidSnapshot(`Invalid or oversized ${table} table.`);
  const columns = snapshotColumns(table);
  const names = new Set(columns.map((column) => column.name));
  const seen = new Set<number | string>();
  return sourceRows.map((sourceRow, index) => {
    if (!record(sourceRow)) return invalidSnapshot(`Unsupported data in ${table} row ${index + 1}.`);
    const row = table === 'contact_children' && version !== 4 && sourceRow.linked_contact_id === undefined
      ? { ...sourceRow, linked_contact_id: null } : sourceRow;
    if (Object.keys(row).some((key) => !names.has(key))) return invalidSnapshot(`Unsupported data in ${table} row ${index + 1}.`);
    if (row.workspace_id !== workspaceId) return invalidSnapshot(`Cross-workspace data in ${table}.`);
    for (const column of columns) {
      const field = row[column.name];
      if (field === undefined || (field === null && column.notNull)) return invalidSnapshot(`Missing ${column.name} in ${table}.`);
      if (field === null) continue;
      if (column.dataType === 'number' ? typeof field !== 'number' || !Number.isFinite(field) : typeof field !== 'string') return invalidSnapshot(`Invalid ${column.name} in ${table}.`);
      if (typeof field === 'string' && field.length > 1_000_000) return invalidSnapshot(`Oversized ${column.name} in ${table}.`);
      if (table === 'daily_snoozes' && column.name === 'id') {
        if (!parseTodaySnoozeTarget(field)) return invalidSnapshot(`Invalid prompt identifier in ${table}.`);
      } else if ((column.name === 'id' || column.name.endsWith('_id') && column.name !== 'workspace_id') && (!Number.isSafeInteger(field) || Number(field) < 1)) return invalidSnapshot(`Invalid identifier in ${table}.`);
    }
    if (table === 'daily_snoozes' && !parseDateOnly(row.until_date)) return invalidSnapshot(`Invalid snooze date in ${table}.`);
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
  if (!record(value) || value.format !== 'bonds-cloud-backup' || (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4)) return invalid('This is not a supported cloud backup. Local SQLite backups cannot be restored into cloud mode.');
  if (value.workspaceId !== workspaceId) return invalid('This backup belongs to a different workspace.');
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !record(value.tables)) return invalid('The backup manifest is incomplete.');
  if (Object.keys(value.tables).some((table) => !SNAPSHOT_TABLES.includes(table as SnapshotTable))) return invalid('The backup contains unsupported tables.');
  if (value.workspace !== undefined && (!record(value.workspace) || typeof value.workspace.name !== 'string' || !value.workspace.name.trim() || value.workspace.name.length > 200 || (value.workspace.persona !== null && typeof value.workspace.persona !== 'string'))) return invalid('Invalid workspace metadata.');
  const tables = {} as CloudSnapshot['tables'];
  const ids = new Map<SnapshotTable, Set<number | string>>();
  for (const table of SNAPSHOT_TABLES) {
    const rows = table === 'daily_snoozes' && value.version < 3 && value.tables[table] === undefined
      ? [] : value.tables[table];
    tables[table] = validateSnapshotRows(table, rows, workspaceId, value.version as CloudSnapshot['version']);
    ids.set(table, new Set(tables[table].filter((row) => row.id !== undefined)
      .map((row) => table === 'daily_snoozes' ? String(row.id) : Number(row.id))));
  }
  const pairs = new Set<string>();
  const linkedChildren = new Set<string>();
  const remindersById = new Map(tables.reminders.map((row) => [Number(row.id), row]));
  for (const table of SNAPSHOT_TABLES) for (const row of tables[table]) {
    if (row.contact_id !== undefined && !ids.get('contacts')!.has(Number(row.contact_id))) return invalid(`Missing contact referenced by ${table}.`);
    if (row.group_id !== undefined && !ids.get('contact_groups')!.has(Number(row.group_id))) return invalid('Missing group referenced by membership.');
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
  return { format: 'bonds-cloud-backup', version: value.version as 1 | 2 | 3 | 4, workspaceId, createdAt: value.createdAt, workspace: value.workspace as CloudSnapshot['workspace'], tables };
}
