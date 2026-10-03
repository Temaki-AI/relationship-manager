import { relations, sql } from 'drizzle-orm';
import {
  blob,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const sessions = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (table) => [index('session_user_idx').on(table.userId)]);

export const accounts = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('account_user_idx').on(table.userId),
  uniqueIndex('account_provider_idx').on(table.providerId, table.accountId),
]);

export const verifications = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
}, (table) => [index('verification_identifier_idx').on(table.identifier)]);

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('free'),
  persona: text('persona'),
  recoveryRevision: integer('recovery_revision').notNull().default(0),
  lifecycle: text('lifecycle').notNull().default('active'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const workspaceMembers = sqliteTable('workspace_members', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('owner'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId] }),
  index('workspace_members_user_idx').on(table.userId, table.workspaceId),
]);

export const contacts = sqliteTable('contacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  nickname: text('nickname'),
  email: text('email'),
  phone: text('phone'),
  photoUrl: text('photo_url'),
  birthday: text('birthday'),
  birthdayReminderDays: integer('birthday_reminder_days').notNull().default(7),
  howWeMet: text('how_we_met'),
  tags: text('tags'),
  notes: text('notes'),
  giftIdeas: text('gift_ideas'),
  customFields: text('custom_fields'),
  lastContacted: text('last_contacted'),
  contactFrequency: integer('contact_frequency').default(14),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index('contacts_workspace_name_idx').on(table.workspaceId, table.name, table.id),
  index('contacts_workspace_last_contacted_idx').on(table.workspaceId, table.lastContacted),
]);

export const contactRelationships = sqliteTable('contact_relationships', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  relatedContactId: integer('related_contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  relationshipLabel: text('relationship_label').notNull(),
  reciprocalLabel: text('reciprocal_label').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index('relationships_workspace_contact_idx').on(table.workspaceId, table.contactId, table.id),
  index('relationships_workspace_related_idx').on(table.workspaceId, table.relatedContactId, table.id),
]);

export const contactChildren = sqliteTable('contact_children', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  linkedContactId: integer('linked_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  birthday: text('birthday'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index('children_workspace_contact_idx').on(table.workspaceId, table.contactId, table.id),
  uniqueIndex('children_workspace_linked_idx').on(table.workspaceId, table.contactId, table.linkedContactId),
  index('children_linked_contact_idx').on(table.linkedContactId),
]);

export const interactions = sqliteTable('interactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  type: text('type').notNull(),
  summary: text('summary'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index('interactions_workspace_contact_date_idx').on(table.workspaceId, table.contactId, table.date, table.id)]);

export const reminders = sqliteTable('reminders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  notes: text('notes'),
  remindAt: text('remind_at').notNull(),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index('reminders_workspace_due_idx').on(table.workspaceId, table.completedAt, table.remindAt, table.id)]);

export const reminderEmailPreferences = sqliteTable('reminder_email_preferences', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  enabledAt: text('enabled_at'),
  timeZone: text('time_zone').notNull().default('UTC'),
  quietStartHour: integer('quiet_start_hour').notNull().default(22),
  quietEndHour: integer('quiet_end_hour').notNull().default(8),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.userId] })]);

export const reminderEmailDeliveries = sqliteTable('reminder_email_deliveries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  reminderId: integer('reminder_id').notNull().references(() => reminders.id, { onDelete: 'cascade' }),
  remindAt: text('remind_at').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: text('next_attempt_at').notNull(),
  leaseUntil: text('lease_until'),
  sentAt: text('sent_at'),
  providerMessageId: text('provider_message_id'),
}, (table) => [
  uniqueIndex('reminder_email_delivery_event_idx').on(table.workspaceId, table.userId, table.reminderId, table.remindAt),
  index('reminder_email_delivery_queue_idx').on(table.status, table.nextAttemptAt, table.id),
]);

export const birthdayEmailDeliveries = sqliteTable('birthday_email_deliveries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  childId: integer('child_id').references(() => contactChildren.id, { onDelete: 'cascade' }),
  occurrence: text('occurrence').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: text('next_attempt_at').notNull(),
  leaseUntil: text('lease_until'),
  sentAt: text('sent_at'),
  providerMessageId: text('provider_message_id'),
}, (table) => [
  uniqueIndex('birthday_email_delivery_event_idx').on(table.workspaceId, table.userId, table.contactId, sql`case when ${table.childId} is null then 0 else ${table.childId} end`, table.occurrence),
  index('birthday_email_delivery_queue_idx').on(table.status, table.nextAttemptAt, table.id),
  index('birthday_email_delivery_child_idx').on(table.childId),
]);

export const birthdayEmailScanState = sqliteTable('birthday_email_scan_state', {
  id: integer('id').primaryKey(),
  workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  contactId: integer('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const childBirthdayEmailScanState = sqliteTable('child_birthday_email_scan_state', {
  id: integer('id').primaryKey(),
  workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  childId: integer('child_id').references(() => contactChildren.id, { onDelete: 'set null' }),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const dailySnoozes = sqliteTable('daily_snoozes', {
  id: text('id').notNull(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  reminderId: integer('reminder_id').references(() => reminders.id, { onDelete: 'cascade' }),
  untilDate: text('until_date').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.id] }),
  index('daily_snoozes_until_idx').on(table.workspaceId, table.untilDate, table.id),
]);

export const contactGroups = sqliteTable('contact_groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex('groups_workspace_name_idx').on(table.workspaceId, table.name)]);

export const contactGroupMembers = sqliteTable('contact_group_members', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  groupId: integer('group_id').notNull().references(() => contactGroups.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.contactId, table.groupId] }),
  index('group_members_workspace_group_idx').on(table.workspaceId, table.groupId, table.contactId),
]);

export const relationshipFacts = sqliteTable('relationship_facts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  label: text('label').notNull(),
  value: text('value'),
  source: text('source').notNull().default('manual'),
  confidence: real('confidence').notNull().default(1),
  lastVerifiedAt: text('last_verified_at'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index('facts_workspace_contact_idx').on(table.workspaceId, table.contactId, table.id)]);

export const integrationConnections = sqliteTable('integration_connections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  label: text('label').notNull(),
  status: text('status').notNull().default('disconnected'),
  accountEmail: text('account_email'),
  lastSyncedAt: text('last_synced_at'),
  syncFrequencyMinutes: integer('sync_frequency_minutes').notNull().default(60),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex('connections_workspace_provider_idx').on(table.workspaceId, table.provider)]);

export const syncJobs = sqliteTable('sync_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  jobType: text('job_type').notNull(),
  status: text('status').notNull(),
  summary: text('summary'),
  startedAt: text('started_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: text('finished_at'),
  metadata: text('metadata'),
}, (table) => [index('sync_jobs_workspace_provider_idx').on(table.workspaceId, table.provider, table.startedAt)]);

export const plans = sqliteTable('plans', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  plannedDate: text('planned_date').notNull(),
  summary: text('summary'),
  notes: text('notes'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index('plans_workspace_contact_date_idx').on(table.workspaceId, table.contactId, table.plannedDate, table.id)]);

export const mutationReceipts = sqliteTable('mutation_receipts', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  scope: text('scope').notNull(),
  requestKey: text('request_key').notNull(),
  fingerprint: text('fingerprint').notNull(),
  ownerToken: text('owner_token').notNull(),
  resourceId: integer('resource_id'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.scope, table.requestKey] })]);

export const cloudBackupFiles = sqliteTable('cloud_backup_files', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  state: text('state').notNull().default('ready'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.filename] }), index('cloud_backup_files_cleanup_idx').on(table.state, table.createdAt)]);

export const cloudBackupSchedules = sqliteTable('cloud_backup_schedules', {
  workspaceId: text('workspace_id').notNull().primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  nextAttemptAt: text('next_attempt_at').notNull(),
  leaseUntil: text('lease_until'),
  lastSuccessAt: text('last_success_at'),
  lastFailureCode: text('last_failure_code'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [index('cloud_backup_schedules_due_idx').on(table.nextAttemptAt, table.leaseUntil)]);

export const cloudBackupPins = sqliteTable('cloud_backup_pins', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  token: text('token').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.filename, table.token] })]);

export const cloudSnapshotCaptureJobs = sqliteTable('cloud_snapshot_capture_jobs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  state: text('state').notNull().default('capturing'),
  tableIndex: integer('table_index').notNull().default(0),
  cursorKey: text('cursor_key').notNull().default(''),
  chunkCount: integer('chunk_count').notNull().default(0),
  rowCounts: text('row_counts').notNull().default('{}'),
  verifyIndex: integer('verify_index').notNull().default(0),
  manifestPartCount: integer('manifest_part_count').notNull().default(0),
  manifestChain: text('manifest_chain').notNull().default(''),
  manifestSha256: text('manifest_sha256'),
  manifestBytes: integer('manifest_bytes'),
  leaseToken: text('lease_token'),
  leaseUntil: text('lease_until'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index('cloud_snapshot_capture_workspace_idx').on(table.workspaceId, table.state, table.updatedAt),
  uniqueIndex('cloud_snapshot_capture_one_active').on(table.workspaceId)
    .where(sql`${table.state} IN ('capturing', 'awaiting_verification')`),
]);

export const cloudSnapshotCaptureChunks = sqliteTable('cloud_snapshot_capture_chunks', {
  jobId: text('job_id').notNull().references(() => cloudSnapshotCaptureJobs.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  tableName: text('table_name').notNull(),
  cursorKey: text('cursor_key').notNull(),
  rowCount: integer('row_count').notNull(),
  byteLength: integer('byte_length').notNull(),
  sha256: text('sha256').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.sequence] }),
  index('cloud_snapshot_capture_chunks_workspace_idx').on(table.workspaceId, table.jobId),
]);

export const cloudSnapshotReadJobs = sqliteTable('cloud_snapshot_read_jobs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  captureJobId: text('capture_job_id').notNull().references(() => cloudSnapshotCaptureJobs.id, { onDelete: 'cascade' }),
  manifestSha256: text('manifest_sha256').notNull(),
  state: text('state').notNull().default('reading'),
  partIndex: integer('part_index').notNull().default(0),
  chunkIndex: integer('chunk_index').notNull().default(0),
  partChain: text('part_chain').notNull().default(''),
  rowCounts: text('row_counts').notNull().default('{}'),
  lastTableIndex: integer('last_table_index').notNull().default(-1),
  lastCursorKey: text('last_cursor_key').notNull().default(''),
  leaseToken: text('lease_token'),
  leaseUntil: text('lease_until'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index('cloud_snapshot_read_workspace_idx').on(table.workspaceId, table.captureJobId, table.state, table.updatedAt),
]);

export const cloudMaintenanceGuards = sqliteTable('cloud_maintenance_guards', {
  token: text('token').primaryKey(),
  allowed: integer('allowed').notNull(),
});

export const cloudSnapshotRestoreJobs = sqliteTable('cloud_snapshot_restore_jobs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  targetCaptureJobId: text('target_capture_job_id').notNull().references(() => cloudSnapshotCaptureJobs.id),
  targetReadJobId: text('target_read_job_id').references(() => cloudSnapshotReadJobs.id),
  rollbackCaptureJobId: text('rollback_capture_job_id').references(() => cloudSnapshotCaptureJobs.id),
  rollbackReadJobId: text('rollback_read_job_id').references(() => cloudSnapshotReadJobs.id),
  baseRevision: integer('base_revision').notNull(),
  state: text('state').notNull().default('preparing'),
  applySource: text('apply_source').notNull().default('target'),
  applyTableIndex: integer('apply_table_index').notNull().default(0),
  applyChunkIndex: integer('apply_chunk_index').notNull().default(0),
  applyRowIndex: integer('apply_row_index').notNull().default(0),
  applyPartChain: text('apply_part_chain').notNull().default(''),
  applyRowCounts: text('apply_row_counts').notNull().default('{}'),
  backgroundState: text('background_state').notNull().default('idle'),
  backgroundVersion: integer('background_version').notNull().default(0),
  leaseToken: text('lease_token'),
  leaseUntil: text('lease_until'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index('cloud_snapshot_restore_workspace_idx').on(table.workspaceId, table.state, table.updatedAt),
  uniqueIndex('cloud_snapshot_restore_one_active').on(table.workspaceId)
    .where(sql`${table.state} NOT IN ('invalid', 'completed', 'rolled_back')`),
]);

export const cloudErasureBatches = sqliteTable('cloud_erasure_batches', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  objectKeys: text('object_keys').notNull(),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.token] })]);

export const contactImportJobs = sqliteTable('contact_import_jobs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  requestKey: text('request_key').notNull(),
  fingerprint: text('fingerprint').notNull(),
  filename: text('filename').notNull(),
  format: text('format').notNull(),
  total: integer('total').notNull(),
  sourceBytes: integer('source_bytes').notNull(),
  state: text('state').notNull().default('preparing'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('import_jobs_request_idx').on(table.workspaceId, table.requestKey),
  uniqueIndex('import_jobs_owner_idx').on(table.id, table.workspaceId),
  index('import_jobs_workspace_idx').on(table.workspaceId, table.createdAt),
]);

export const contactImportRows = sqliteTable('contact_import_rows', {
  workspaceId: text('workspace_id').notNull(),
  jobId: text('job_id').notNull(),
  rowNumber: integer('row_number').notNull(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  birthday: text('birthday'),
  payload: text('payload'),
  state: text('state').notNull(),
  forceCreate: integer('force_create').notNull().default(0),
  message: text('message'),
  contactId: integer('contact_id'),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.rowNumber] }),
  foreignKey({ columns: [table.jobId, table.workspaceId], foreignColumns: [contactImportJobs.id, contactImportJobs.workspaceId] }).onDelete('cascade'),
  index('import_rows_state_idx').on(table.workspaceId, table.jobId, table.state, table.rowNumber),
]);

export const contactImportSources = sqliteTable('contact_import_sources', {
  workspaceId: text('workspace_id').notNull(),
  jobId: text('job_id').notNull(),
  part: integer('part').notNull(),
  data: blob('data', { mode: 'buffer' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.part] }),
  foreignKey({ columns: [table.jobId, table.workspaceId], foreignColumns: [contactImportJobs.id, contactImportJobs.workspaceId] }).onDelete('cascade'),
]);

export const contactExportJobs = sqliteTable('contact_export_jobs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  requestKey: text('request_key').notNull(),
  format: text('format').notNull(),
  state: text('state').notNull().default('running'),
  revision: integer('revision').notNull(),
  total: integer('total').notNull(),
  maxId: integer('max_id').notNull(),
  exported: integer('exported').notNull().default(0),
  cursorId: integer('cursor_id').notNull().default(0),
  uploadId: text('upload_id'),
  partEtags: text('part_etags').notNull().default('[]'),
  scratchSize: integer('scratch_size').notNull().default(0),
  leaseToken: text('lease_token'),
  leaseUntil: text('lease_until'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (table) => [
  uniqueIndex('export_jobs_request_idx').on(table.workspaceId, table.requestKey),
  index('export_jobs_workspace_idx').on(table.workspaceId, table.createdAt),
  index('export_jobs_retention_idx').on(table.updatedAt),
]);

export const userRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  memberships: many(workspaceMembers),
}));

export const workspaceRelations = relations(workspaces, ({ many }) => ({
  members: many(workspaceMembers),
  contacts: many(contacts),
}));

export const workspaceMemberRelations = relations(workspaceMembers, ({ one }) => ({
  user: one(users, { fields: [workspaceMembers.userId], references: [users.id] }),
  workspace: one(workspaces, { fields: [workspaceMembers.workspaceId], references: [workspaces.id] }),
}));

export const schema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  workspaces,
  workspaceMembers,
  contacts,
  contactRelationships,
  contactChildren,
  interactions,
  reminders,
  dailySnoozes,
  contactGroups,
  contactGroupMembers,
  relationshipFacts,
  integrationConnections,
  syncJobs,
  plans,
  mutationReceipts,
  cloudBackupFiles,
  cloudBackupPins,
  cloudSnapshotCaptureJobs,
  cloudSnapshotCaptureChunks,
  cloudSnapshotReadJobs,
  cloudSnapshotRestoreJobs,
  cloudMaintenanceGuards,
  cloudErasureBatches,
  contactImportJobs,
  contactImportRows,
  contactImportSources,
  contactExportJobs,
};
