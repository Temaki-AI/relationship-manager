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
  publicId: text('public_id').notNull().default(''),
  mergeAliases: text('merge_aliases').notNull().default('[]'),
  contactMethods: text('contact_methods').notNull().default('null'),
  sourceRevision: integer('source_revision').notNull().default(0),
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
  uniqueIndex('contacts_workspace_public_id_idx').on(table.workspaceId, table.publicId),
  index('contacts_workspace_name_idx').on(table.workspaceId, table.name, table.id),
  index('contacts_workspace_last_contacted_idx').on(table.workspaceId, table.lastContacted),
]);

// Derived from contacts.merge_aliases; recovery rebuilds this index rather than backing it up.
export const contactMergeAliases = sqliteTable('contact_merge_aliases', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  publicId: text('public_id').notNull(),
  canonicalPublicId: text('canonical_public_id').notNull(),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.publicId] }),
  index('contact_merge_aliases_target_idx').on(table.workspaceId, table.canonicalPublicId)]);

export const contactRelationships = sqliteTable('contact_relationships', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull().default(''),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  relatedContactId: integer('related_contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  relationshipLabel: text('relationship_label').notNull(),
  reciprocalLabel: text('reciprocal_label').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex('relationships_workspace_public_id_idx').on(table.workspaceId, table.publicId),
  index('relationships_workspace_contact_idx').on(table.workspaceId, table.contactId, table.id),
  index('relationships_workspace_related_idx').on(table.workspaceId, table.relatedContactId, table.id),
]);

export const contactChildren = sqliteTable('contact_children', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull().default(''),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  linkedContactId: integer('linked_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  birthday: text('birthday'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex('children_workspace_public_id_idx').on(table.workspaceId, table.publicId),
  index('children_workspace_contact_idx').on(table.workspaceId, table.contactId, table.id),
  uniqueIndex('children_workspace_linked_idx').on(table.workspaceId, table.contactId, table.linkedContactId),
  index('children_linked_contact_idx').on(table.linkedContactId),
]);

export const interactions = sqliteTable('interactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull().default(''),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  occurredAt: text('occurred_at'),
  type: text('type').notNull(),
  summary: text('summary'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index('interactions_workspace_contact_date_idx').on(table.workspaceId, table.contactId, table.date, table.id),
  uniqueIndex('interactions_workspace_public_id_idx').on(table.workspaceId, table.publicId),
]);

export const reminders = sqliteTable('reminders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull().default(''),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  notes: text('notes'),
  remindAt: text('remind_at').notNull(),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index('reminders_workspace_due_idx').on(table.workspaceId, table.completedAt, table.remindAt, table.id),
  uniqueIndex('reminders_workspace_public_id_idx').on(table.workspaceId, table.publicId),
]);

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

// Provider authorization is operational state, excluded from portable CRM snapshots.
export const providerConnections = sqliteTable('provider_connections', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  purpose: text('purpose').notNull().default('contacts'),
  accountId: text('account_id').notNull(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  grantedScopes: text('granted_scopes').notNull(),
  status: text('status').notNull(),
  datasetEpoch: text('dataset_epoch').notNull(),
  revision: integer('revision').notNull().default(1),
  authorizationRevision: integer('authorization_revision').notNull().default(1),
  credentials: text('credentials'),
  accessExpiresAt: integer('access_expires_at'),
  refreshExpiresAt: integer('refresh_expires_at'),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until'),
  issue: text('issue'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('provider_connections_identity_idx').on(table.workspaceId, table.provider, table.accountId, table.purpose),
  index('provider_connections_owner_idx').on(table.workspaceId, table.userId),
]);

export const providerAuthorizationAttempts = sqliteTable('provider_authorization_attempts', {
  purpose: text('purpose').notNull().default('contacts'),
  stateHash: text('state_hash').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  datasetEpoch: text('dataset_epoch').notNull(),
  connectionId: text('connection_id').references(() => providerConnections.id, { onDelete: 'cascade' }),
  connectionRevision: integer('connection_revision'),
  verifier: text('verifier').notNull(),
  claimToken: text('claim_token'),
  expiresAt: integer('expires_at').notNull(),
}, (table) => [index('provider_authorization_owner_idx').on(table.workspaceId, table.userId, table.expiresAt)]);

// Calendar authorization, discovery and choices are operational, outside CRM recovery.
export const providerCalendarResources = sqliteTable('provider_calendar_resources', {
  connectionId: text('connection_id').primaryKey().references(() => providerConnections.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  datasetEpoch: text('dataset_epoch').notNull(),
  authorizationRevision: integer('authorization_revision').notNull(),
  activeGeneration: text('active_generation'),
  selectionRevision: integer('selection_revision').notNull().default(1),
  selectedIds: text('selected_ids').notNull().default('[]'),
  lastDiscoveredAt: text('last_discovered_at'),
});
export const providerCalendarRuns = sqliteTable('provider_calendar_runs', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').notNull().references(() => providerConnections.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  datasetEpoch: text('dataset_epoch').notNull(),
  authorizationRevision: integer('authorization_revision').notNull(),
  status: text('status').notNull().default('active'),
  generation: text('generation').notNull(),
  baseGeneration: text('base_generation'),
  nextPage: text('next_page'),
  pages: integer('pages').notNull().default(0),
  processed: integer('processed').notNull().default(0),
  revision: integer('revision').notNull().default(1),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until'),
  failures: integer('failures').notNull().default(0),
  retryAt: integer('retry_at').notNull().default(0),
  issue: text('issue'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [index('provider_calendar_runs_connection_idx').on(table.connectionId, table.createdAt)]);
export const providerCalendarCatalog = sqliteTable('provider_calendar_catalog', {
  connectionId: text('connection_id').notNull().references(() => providerConnections.id, { onDelete: 'cascade' }),
  generation: text('generation').notNull(),
  calendarId: text('calendar_id').notNull(),
  facts: text('facts').notNull(),
}, (table) => [uniqueIndex('provider_calendar_catalog_identity_idx').on(table.connectionId, table.generation, table.calendarId)]);
export const providerCalendars = sqliteTable('provider_calendars', {
  connectionId: text('connection_id').notNull().references(() => providerConnections.id, { onDelete: 'cascade' }),
  calendarId: text('calendar_id').notNull(),
  facts: text('facts').notNull(),
  availability: text('availability').notNull(),
  observedAt: text('observed_at').notNull(),
}, (table) => [uniqueIndex('provider_calendars_identity_idx').on(table.connectionId, table.calendarId)]);
export const providerCalendarSelectionReceipts = sqliteTable('provider_calendar_selection_receipts', {
  connectionId: text('connection_id').notNull().references(() => providerConnections.id, { onDelete: 'cascade' }),
  operationId: text('operation_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  resultRevision: integer('result_revision').notNull(),
  datasetEpoch: text('dataset_epoch').notNull(),
  authorizationRevision: integer('authorization_revision').notNull(),
}, (table) => [uniqueIndex('provider_calendar_selection_identity_idx').on(table.connectionId, table.operationId)]);

// Selected-calendar downloads are an operational source index. Reviewed CRM event
// associations belong to a separate canonical model, not these provider checkpoints.
export const providerEventResources = sqliteTable('provider_event_resources', {
  connectionId: text('connection_id').notNull().references(() => providerConnections.id, { onDelete: 'cascade' }),
  calendarId: text('calendar_id').notNull(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  activeGeneration: text('active_generation'),
  windowStart: text('window_start'),
  windowEnd: text('window_end'),
  lastDownloadedAt: text('last_downloaded_at'),
  availability: text('availability').notNull().default('available'),
  syncEnabled: integer('sync_enabled').notNull().default(0),
  syncInterval: integer('sync_interval').notNull().default(86400),
  settingsRevision: integer('settings_revision').notNull().default(0),
  pastDays: integer('past_days').notNull().default(90),
  futureDays: integer('future_days').notNull().default(180),
  nextSyncAt: integer('next_sync_at').notNull().default(0),
}, (table) => [primaryKey({ columns: [table.connectionId, table.calendarId] }), index('provider_event_resources_due_idx').on(table.syncEnabled, table.nextSyncAt)]);
export const providerEventRuns = sqliteTable('provider_event_runs', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').notNull().references(() => providerConnections.id, { onDelete: 'cascade' }),
  calendarId: text('calendar_id').notNull(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  datasetEpoch: text('dataset_epoch').notNull(),
  authorizationRevision: integer('authorization_revision').notNull(),
  selectionRevision: integer('selection_revision').notNull(),
  fingerprint: text('fingerprint').notNull(),
  scheduleRevision: integer('schedule_revision'),
  status: text('status').notNull().default('active'),
  generation: text('generation').notNull(),
  baseGeneration: text('base_generation'),
  calendarTimeZone: text('calendar_time_zone').notNull(),
  windowStart: text('window_start').notNull(),
  windowEnd: text('window_end').notNull(),
  nextPage: text('next_page'),
  pages: integer('pages').notNull().default(0),
  processed: integer('processed').notNull().default(0),
  revision: integer('revision').notNull().default(1),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until'),
  failures: integer('failures').notNull().default(0),
  retryAt: integer('retry_at').notNull().default(0),
  issue: text('issue'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [index('provider_event_runs_resource_idx').on(table.connectionId, table.calendarId, table.createdAt)]);
export const providerEventIndex = sqliteTable('provider_event_index', {
  connectionId: text('connection_id').notNull().references(() => providerConnections.id, { onDelete: 'cascade' }),
  calendarId: text('calendar_id').notNull(),
  generation: text('generation').notNull(),
  eventId: text('event_id').notNull(),
  sortKey: text('sort_key').notNull(),
  facts: text('facts').notNull(),
}, (table) => [primaryKey({ columns: [table.connectionId, table.calendarId, table.generation, table.eventId] }),
  index('provider_event_index_order_idx').on(table.connectionId, table.calendarId, table.generation, table.sortKey, table.eventId)]);
export const providerEventPages = sqliteTable('provider_event_pages', {
  runId: text('run_id').notNull().references(() => providerEventRuns.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.tokenHash] })]);

// Gmail checkpoints and projections are a consented operational source cache.
// Canonical people, notes and confirmed activities are stored separately.
export const providerGmailResources = sqliteTable('provider_gmail_resources', {
  connectionId: text('connection_id').primaryKey().references(() => providerConnections.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  datasetEpoch: text('dataset_epoch').notNull(), authorizationRevision: integer('authorization_revision').notNull(),
  settingsRevision: integer('settings_revision').notNull().default(1), choices: text('choices').notNull(), activeGeneration: text('active_generation'),
  checkpoint: text('checkpoint'), coverage: text('coverage').notNull().default('none'), windowStart: integer('window_start'), windowEnd: integer('window_end'), lastDownloadedAt: text('last_downloaded_at'),
  syncEnabled: integer('sync_enabled').notNull().default(0), syncInterval: integer('sync_interval').notNull().default(86400),
  syncRevision: integer('sync_revision').notNull().default(0), nextSyncAt: integer('next_sync_at').notNull().default(0), repairRequired: integer('repair_required').notNull().default(0),
}, (table) => [index('provider_gmail_due').on(table.syncEnabled, table.nextSyncAt, table.connectionId)]);
export const providerGmailRuns = sqliteTable('provider_gmail_runs', {
  id: text('id').primaryKey(), connectionId: text('connection_id').notNull().references(() => providerGmailResources.connectionId, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  datasetEpoch: text('dataset_epoch').notNull(), authorizationRevision: integer('authorization_revision').notNull(), settingsRevision: integer('settings_revision').notNull(),
  fingerprint: text('fingerprint').notNull(), generation: text('generation').notNull(), baseGeneration: text('base_generation'), mode: text('mode').notNull(),
  phase: text('phase').notNull().default('profile'), windowStart: integer('window_start').notNull(), windowEnd: integer('window_end').notNull(),
  historyStart: text('history_start'), historyCheckpoint: text('history_checkpoint'), labelPosition: integer('label_position').notNull().default(0), nextPage: text('next_page'),
  pages: integer('pages').notNull().default(0), processed: integer('processed').notNull().default(0), limited: integer('limited').notNull().default(0),
  status: text('status').notNull().default('active'), revision: integer('revision').notNull().default(1), leaseToken: text('lease_token'), leaseUntil: integer('lease_until'),
  failures: integer('failures').notNull().default(0), retryAt: integer('retry_at').notNull().default(0), issue: text('issue'), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
  scheduleRevision: integer('schedule_revision'),
}, (table) => [uniqueIndex('provider_gmail_one_active_run').on(table.connectionId).where(sql`${table.status} = 'active'`),
  uniqueIndex('provider_gmail_run_generation').on(table.connectionId, table.generation), index('provider_gmail_runs_owner').on(table.workspaceId, table.userId, table.connectionId, table.createdAt),
  index('provider_gmail_dispatch').on(table.status, table.scheduleRevision, table.updatedAt, table.id)]);
export const providerGmailPending = sqliteTable('provider_gmail_pending', {
  runId: text('run_id').notNull().references(() => providerGmailRuns.id, { onDelete: 'cascade' }), messageId: text('message_id').notNull(), phase: text('phase').notNull(), done: integer('done').notNull().default(0),
}, (table) => [primaryKey({ columns: [table.runId, table.phase, table.messageId] })]);
export const providerGmailIndex = sqliteTable('provider_gmail_index', {
  connectionId: text('connection_id').notNull(), generation: text('generation').notNull(), messageId: text('message_id').notNull(), receivedAt: integer('received_at').notNull(), observedAt: integer('observed_at').notNull(), facts: text('facts').notNull(),
}, (table) => [primaryKey({ columns: [table.connectionId, table.generation, table.messageId] }),
  foreignKey({ columns: [table.connectionId, table.generation], foreignColumns: [providerGmailRuns.connectionId, providerGmailRuns.generation] }).onDelete('cascade'),
  index('provider_gmail_index_date').on(table.connectionId, table.generation, table.receivedAt, table.messageId)]);
export const providerGmailPages = sqliteTable('provider_gmail_pages', {
  runId: text('run_id').notNull().references(() => providerGmailRuns.id, { onDelete: 'cascade' }), phase: text('phase').notNull(), tokenHash: text('token_hash').notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.phase, table.tokenHash] })]);

export const gmailContactDirectory = sqliteTable('gmail_contact_directory', {
  workspaceId: text('workspace_id').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull().default(0), cursorId: integer('cursor_id').notNull().default(0),
  bootstrapped: integer('bootstrapped').notNull().default(0), progressRevision: integer('progress_revision').notNull().default(0),
});
export const gmailContactDirectoryPending = sqliteTable('gmail_contact_directory_pending', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), contactPublicId: text('contact_public_id').notNull(),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.contactPublicId] })]);
export const gmailContactDirectoryEntries = sqliteTable('gmail_contact_directory_entries', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), email: text('email').notNull(), contactPublicId: text('contact_public_id').notNull(),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.email, table.contactPublicId] }), index('gmail_contact_directory_person').on(table.workspaceId, table.contactPublicId)]);
export const providerGmailParticipants = sqliteTable('provider_gmail_participants', {
  connectionId: text('connection_id').notNull(), generation: text('generation').notNull(), messageId: text('message_id').notNull(),
  email: text('email').notNull(), roles: text('roles').notNull(), receivedAt: integer('received_at').notNull(),
}, (table) => [primaryKey({ columns: [table.connectionId, table.generation, table.messageId, table.email] }),
  foreignKey({ columns: [table.connectionId, table.generation, table.messageId], foreignColumns: [providerGmailIndex.connectionId, providerGmailIndex.generation, providerGmailIndex.messageId] }).onDelete('cascade'),
  index('provider_gmail_participants_email').on(table.connectionId, table.generation, table.email, table.receivedAt, table.messageId)]);
export const providerGmailMatching = sqliteTable('provider_gmail_matching', {
  connectionId: text('connection_id').primaryKey().references(() => providerGmailResources.connectionId, { onDelete: 'cascade' }), revision: integer('revision').notNull().default(0),
});
export const providerGmailMatchRules = sqliteTable('provider_gmail_match_rules', {
  connectionId: text('connection_id').notNull().references(() => providerGmailMatching.connectionId, { onDelete: 'cascade' }), email: text('email').notNull(),
  action: text('action').notNull(), targetPublicId: text('target_public_id'), candidateBasis: text('candidate_basis').notNull(),
}, (table) => [primaryKey({ columns: [table.connectionId, table.email] }), index('provider_gmail_match_rules_person').on(table.connectionId, table.targetPublicId, table.email)]);
export const providerGmailMatchReceipts = sqliteTable('provider_gmail_match_receipts', {
  connectionId: text('connection_id').notNull().references(() => providerGmailMatching.connectionId, { onDelete: 'cascade' }), operationId: text('operation_id').notNull(),
  fingerprint: text('fingerprint').notNull(), revision: integer('revision').notNull(), action: text('action').notNull(), email: text('email').notNull(), targetPublicId: text('target_public_id'),
}, (table) => [primaryKey({ columns: [table.connectionId, table.operationId] })]);

// An outbound calendar create has no provider idempotency key. Keep its frozen
// request and attempted marker across reauthorization/recovery for read-only repair.
export const providerOwnedCalendars = sqliteTable('provider_owned_calendars', {
  connectionId: text('connection_id').primaryKey().references(() => providerConnections.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  operationId: text('operation_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  requestJson: text('request_json').notNull(),
  datasetEpoch: text('dataset_epoch').notNull(),
  authorizationRevision: integer('authorization_revision').notNull(),
  attempted: integer('attempted').notNull().default(0),
  status: text('status').notNull().default('pending'),
  calendarId: text('calendar_id'),
  issue: text('issue'),
  revision: integer('revision').notNull().default(1),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [uniqueIndex('provider_owned_calendars_operation_idx').on(table.operationId)]);

// Download checkpoints and source previews are operational, not canonical CRM records.
export const providerContactResources = sqliteTable('provider_contact_resources', {
  connectionId: text('connection_id').primaryKey().references(() => providerConnections.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  datasetEpoch: text('dataset_epoch').notNull(),
  authorizationRevision: integer('authorization_revision').notNull(),
  activeGeneration: text('active_generation'),
  syncCursor: text('sync_cursor'),
  cursorIssuedAt: integer('cursor_issued_at'),
  requestVersion: integer('request_version').notNull(),
  lastSyncedAt: text('last_synced_at'),
  syncEnabled: integer('sync_enabled').notNull().default(0),
  syncInterval: integer('sync_interval').notNull().default(86400),
  nextSyncAt: integer('next_sync_at').notNull().default(0),
  settingsRevision: integer('settings_revision').notNull().default(1),
});

export const providerContactRuns = sqliteTable('provider_contact_runs', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').notNull().references(() => providerConnections.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  datasetEpoch: text('dataset_epoch').notNull(),
  authorizationRevision: integer('authorization_revision').notNull(),
  forceFull: integer('force_full').notNull(),
  mode: text('mode').notNull(),
  phase: text('phase').notNull(),
  status: text('status').notNull(),
  generation: text('generation').notNull(),
  baseGeneration: text('base_generation'),
  inputCursor: text('input_cursor'),
  nextPage: text('next_page'),
  copyAfter: text('copy_after'),
  reconcileAfter: integer('reconcile_after').notNull().default(0),
  reconciled: integer('reconciled').notNull().default(0),
  reconcileSkipped: integer('reconcile_skipped').notNull().default(0),
  scheduleRevision: integer('schedule_revision'),
  pages: integer('pages').notNull().default(0),
  failures: integer('failures').notNull().default(0),
  processed: integer('processed').notNull().default(0),
  revision: integer('revision').notNull().default(1),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until'),
  nextAttemptAt: integer('next_attempt_at').notNull().default(0),
  issue: text('issue'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('provider_contact_active_run_idx').on(table.connectionId).where(sql`status = 'active'`),
  index('provider_contact_run_owner_idx').on(table.workspaceId, table.connectionId, table.createdAt),
  index('provider_contact_run_retry_idx').on(table.status, table.nextAttemptAt, table.updatedAt),
]);

export const providerContactIndex = sqliteTable('provider_contact_index', {
  connectionId: text('connection_id').notNull().references(() => providerConnections.id, { onDelete: 'cascade' }),
  generation: text('generation').notNull(),
  sourceId: text('source_id').notNull(),
  resourceName: text('resource_name').notNull(),
  facts: text('facts').notNull(),
  observedAt: text('observed_at').notNull(),
}, (table) => [
  uniqueIndex('provider_contact_index_identity_idx').on(table.connectionId, table.generation, table.sourceId),
  index('provider_contact_index_resource_idx').on(table.connectionId, table.generation, table.resourceName),
]);

export const deviceAuthorizationCodes = sqliteTable('device_authorization_codes', {
  codeHash: text('code_hash').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  challenge: text('challenge').notNull(),
  state: text('state').notNull(),
  deviceName: text('device_name').notNull(),
  expiresAt: text('expires_at').notNull(),
  deviceId: text('device_id'),
  consumedAt: text('consumed_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [index('device_codes_user_expiry_idx').on(table.userId, table.expiresAt)]);

export const deviceSessions = sqliteTable('device_sessions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  deviceName: text('device_name').notNull(),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [index('device_sessions_owner_idx').on(table.workspaceId, table.userId, table.expiresAt)]);

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

// Source facts and identity are CRM data; credentials never belong in this table.
export const contactSourceLinks = sqliteTable('contact_source_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  accountKey: text('account_key').notNull(),
  externalId: text('external_id').notNull(),
  profileUrl: text('profile_url').notNull(),
  origin: text('origin').notNull(),
  fields: text('fields').notNull().default('{}'),
  revision: integer('revision').notNull().default(1),
  observedAt: text('observed_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('source_links_workspace_public_idx').on(table.workspaceId, table.publicId),
  uniqueIndex('source_links_external_idx').on(table.workspaceId, table.provider, table.accountKey, table.externalId),
  index('source_links_contact_idx').on(table.workspaceId, table.contactId, table.id),
]);

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
  publicId: text('public_id').notNull().default(''),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  plannedDate: text('planned_date').notNull(),
  summary: text('summary'),
  notes: text('notes'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex('plans_workspace_public_id_idx').on(table.workspaceId, table.publicId),
  index('plans_workspace_contact_date_idx').on(table.workspaceId, table.contactId, table.plannedDate, table.id),
]);

export const contactProviderLinks = sqliteTable('contact_provider_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  accountKey: text('account_key').notNull(),
  accountEmail: text('account_email').notNull(),
  externalId: text('external_id').notNull(),
  resourceName: text('resource_name').notNull(),
  originalFacts: text('original_facts').notNull(),
  observedFacts: text('observed_facts').notNull(),
  appliedFields: text('applied_fields').notNull(),
  status: text('status').notNull(),
  revision: integer('revision').notNull().default(1),
  observedAt: text('observed_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('provider_links_workspace_public_idx').on(table.workspaceId, table.publicId),
  uniqueIndex('provider_links_identity_idx').on(table.workspaceId, table.provider, table.accountKey, table.externalId),
  index('provider_links_contact_idx').on(table.workspaceId, table.contactId, table.id),
]);

export const providerFieldRules = sqliteTable('provider_field_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceLinkId: integer('source_link_id').notNull().references(() => contactProviderLinks.id, { onDelete: 'cascade' }),
  fields: text('fields').notNull(),
  revision: integer('revision').notNull().default(1),
  updatedAt: text('updated_at').notNull(),
}, (table) => [uniqueIndex('provider_field_rules_source_idx').on(table.workspaceId, table.sourceLinkId)]);

export const contactDeviceLinks = sqliteTable('contact_device_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  installationId: text('installation_id').notNull(),
  externalId: text('external_id').notNull(),
  originalFacts: text('original_facts').notNull(),
  observedFacts: text('observed_facts').notNull(),
  appliedFields: text('applied_fields').notNull(),
  revision: integer('revision').notNull().default(1),
  observedAt: text('observed_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [uniqueIndex('device_links_workspace_public_idx').on(table.workspaceId, table.publicId),
  uniqueIndex('device_links_identity_idx').on(table.workspaceId, table.installationId, table.externalId),
  index('device_links_contact_idx').on(table.workspaceId, table.contactId, table.id)]);

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

export const calendarPlanPublications = sqliteTable('calendar_plan_publications', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id').notNull().references(() => providerConnections.id, { onDelete: 'cascade' }),
  planPublicId: text('plan_public_id').notNull(),
  calendarId: text('calendar_id').notNull(),
  eventId: text('event_id').notNull(),
  creatorClientId: text('creator_client_id').notNull(),
  followDate: integer('follow_date').notNull().default(0),
  lastPlanDate: text('last_plan_date'),
  lastEtag: text('last_etag'),
  status: text('status').notNull().default('pending'),
  issue: text('issue'),
  revision: integer('revision').notNull().default(1),
  confirmedAt: text('confirmed_at'),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [uniqueIndex('calendar_plan_publications_plan_idx').on(table.workspaceId, table.planPublicId),
  uniqueIndex('calendar_plan_publications_event_idx').on(table.workspaceId, table.connectionId, table.calendarId, table.eventId)]);
export const calendarPlanWrites = sqliteTable('calendar_plan_writes', {
  id: text('id').primaryKey(),
  publicationId: text('publication_id').notNull().references(() => calendarPlanPublications.id, { onDelete: 'cascade' }),
  fingerprint: text('fingerprint').notNull(),
  requestJson: text('request_json').notNull(),
  planFingerprint: text('plan_fingerprint').notNull(),
  datasetEpoch: text('dataset_epoch').notNull(),
  authorizationRevision: integer('authorization_revision').notNull(),
  publicationRevision: integer('publication_revision').notNull(),
  kind: text('kind').notNull(),
  baseEtag: text('base_etag'),
  attempts: integer('attempts').notNull().default(0),
  status: text('status').notNull().default('pending'),
  issue: text('issue'),
  revision: integer('revision').notNull().default(1),
  retryAt: integer('retry_at').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [index('calendar_plan_writes_current_idx').on(table.publicationId, table.createdAt)]);

export const calendarPublicationReviews = sqliteTable('calendar_publication_reviews', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  receiptId: text('receipt_id').notNull(),
  planPublicId: text('plan_public_id').notNull(),
  reviewingDeviceId: text('reviewing_device_id').notNull(),
  epoch: text('epoch').notNull(),
  expectedRevision: integer('expected_revision'),
  planFingerprint: text('plan_fingerprint').notNull(),
  observedMarker: text('observed_marker').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [index('calendar_publication_reviews_receipt_idx').on(table.workspaceId, table.receiptId, table.createdAt)]);

export const calendarPublicationReservations = sqliteTable('calendar_publication_reservations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  planPublicId: text('plan_public_id').notNull(),
  provider: text('provider').notNull(),
  publisherId: text('publisher_id').notNull(),
  epoch: text('epoch').notNull(),
  planFingerprint: text('plan_fingerprint'),
  requestFingerprint: text('request_fingerprint'),
  status: text('status').notNull().default('reserved'),
  attempted: integer('attempted').notNull().default(0),
  resultAction: text('result_action'),
  revision: integer('revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [uniqueIndex('calendar_reservations_live_plan_idx').on(table.workspaceId, table.planPublicId).where(sql`${table.status} != 'cancelled'`),
  index('calendar_reservations_workspace_idx').on(table.workspaceId, table.createdAt)]);

export const calendarEvents = sqliteTable('calendar_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  accountKey: text('account_key').notNull(),
  accountEmail: text('account_email').notNull(),
  calendarKey: text('calendar_key').notNull(),
  calendarLabel: text('calendar_label').notNull(),
  calendarTimeZone: text('calendar_time_zone').notNull(),
  externalId: text('external_id').notNull(),
  facts: text('facts').notNull(),
  availability: text('availability').notNull(),
  revision: integer('revision').notNull().default(1),
  observedAt: text('observed_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [uniqueIndex('calendar_events_public_idx').on(table.workspaceId, table.publicId),
  uniqueIndex('calendar_events_source_idx').on(table.workspaceId, table.provider, table.accountKey, table.calendarKey, table.externalId)]);
export const calendarEventPeople = sqliteTable('calendar_event_people', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  eventId: integer('event_id').notNull().references(() => calendarEvents.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, (table) => [uniqueIndex('calendar_event_people_identity_idx').on(table.workspaceId, table.eventId, table.contactId), index('calendar_event_people_contact_idx').on(table.workspaceId, table.contactId, table.eventId)]);
export const calendarEventPlans = sqliteTable('calendar_event_plans', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  eventId: integer('event_id').notNull().references(() => calendarEvents.id, { onDelete: 'cascade' }),
  planId: integer('plan_id').notNull().references(() => plans.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, (table) => [uniqueIndex('calendar_event_plans_plan_idx').on(table.workspaceId, table.planId), index('calendar_event_plans_event_idx').on(table.workspaceId, table.eventId)]);

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

export const workspaceSyncState = sqliteTable('workspace_sync_state', {
  workspaceId: text('workspace_id').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  epoch: text('epoch').notNull(),
  paused: integer('paused').notNull().default(0),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// The latest replica projection retains deletion markers to reject resurrected IDs.
export const syncContactRecords = sqliteTable('sync_contact_records', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  publicId: text('public_id').notNull(),
  legacyId: integer('legacy_id').notNull(),
  revision: integer('revision').notNull(),
  payload: text('payload'),
  deletedAt: text('deleted_at'),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.publicId] }),
  index('sync_contacts_bootstrap_idx').on(table.workspaceId, table.deletedAt, table.publicId),
]);

export const syncChanges = sqliteTable('sync_changes', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  epoch: text('epoch').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  operation: text('operation').notNull(),
  revision: integer('revision').notNull(),
  payload: text('payload'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index('sync_changes_pull_idx').on(table.workspaceId, table.epoch, table.sequence)]);

export const syncEntityRecords = sqliteTable('sync_entity_records', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  entityType: text('entity_type').notNull(),
  publicId: text('public_id').notNull(),
  legacyId: integer('legacy_id').notNull(),
  revision: integer('revision').notNull(),
  payload: text('payload'),
  deletedAt: text('deleted_at'),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.entityType, table.publicId] }),
  index('sync_entities_bootstrap_idx').on(table.workspaceId, table.deletedAt, table.entityType, table.publicId),
]);

export const syncMutationReceipts = sqliteTable('sync_mutation_receipts', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  epoch: text('epoch').notNull(),
  operationId: text('operation_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  ownerToken: text('owner_token').notNull(),
  result: text('result'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.epoch, table.operationId] })]);

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
  deviceAuthorizationCodes,
  deviceSessions,
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
  providerConnections,
  providerAuthorizationAttempts,
  providerCalendarResources,
  providerCalendarRuns,
  providerCalendarCatalog,
  providerCalendars,
  providerCalendarSelectionReceipts,
  providerEventResources,
  providerEventRuns,
  providerEventIndex,
  providerEventPages,
  providerGmailResources,
  providerGmailRuns,
  providerGmailPending,
  providerGmailIndex,
  providerGmailPages,
  gmailContactDirectory,
  gmailContactDirectoryPending,
  gmailContactDirectoryEntries,
  providerGmailParticipants,
  providerGmailMatching,
  providerGmailMatchRules,
  providerGmailMatchReceipts,
  providerOwnedCalendars,
  providerContactResources,
  providerContactRuns,
  providerContactIndex,
  contactProviderLinks,
  providerFieldRules,
  contactDeviceLinks,
  syncJobs,
  plans,
  calendarEvents,
  calendarPlanPublications,
  calendarPlanWrites,
  calendarPublicationReservations,
  calendarPublicationReviews,
  calendarEventPeople,
  calendarEventPlans,
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
  workspaceSyncState,
  syncContactRecords,
  syncChanges,
  syncEntityRecords,
  syncMutationReceipts,
};
