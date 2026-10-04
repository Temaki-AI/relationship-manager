import Database from 'better-sqlite3';
import { dirname, join, resolve } from 'path';
import { initializeDemoData } from './demo-data.ts';
import { initializeDatabase } from './database-initialization.ts';
import { initializeWorkspaceFoundation } from './database-foundation.ts';
import { startAutomaticBackupScheduler } from './automatic-backup.ts';
import { logWarning } from './observability.ts';
import {
  ensurePrivateDirectory,
  hardenManagedBackupArtifacts,
  hardenSqliteArtifacts,
} from './filesystem-security.ts';

export const databasePath = process.env.CRM_DATABASE_PATH
  ? resolve(process.cwd(), process.env.CRM_DATABASE_PATH)
  : join(process.cwd(), 'data', 'relationships.db');
export const backupDirectory = process.env.CRM_BACKUP_DIRECTORY
  ? resolve(process.cwd(), process.env.CRM_BACKUP_DIRECTORY)
  : join(dirname(databasePath), 'backups');

ensurePrivateDirectory(dirname(databasePath));
hardenManagedBackupArtifacts(backupDirectory);
const db = new Database(databasePath);
hardenSqliteArtifacts(databasePath);
initializeDatabase(db);
hardenSqliteArtifacts(databasePath);
initializeWorkspaceFoundation(db);
initializeDemoData(db);
const automaticBackupStatus = startAutomaticBackupScheduler(db, backupDirectory);
if (automaticBackupStatus.state === 'failed') {
  logWarning('backup.initialization_failed', {
    operation: 'automatic_backup',
    backup_state: automaticBackupStatus.state,
  });
}

export default db;

export type Workspace = {
  id: number;
  name: string;
  plan: string;
  persona: string | null;
  created_at: string;
};

export type Contact = {
  contact_methods?: string;
  id: number;
  name: string;
  nickname: string | null;
  email: string | null;
  phone: string | null;
  photo_url: string | null;
  birthday: string | null;
  birthday_reminder_days: number;
  how_we_met: string | null;
  tags: string | null;
  notes: string | null;
  gift_ideas: string | null;
  custom_fields: string | null;
  last_contacted: string | null;
  contact_frequency: number;
  created_at: string;
  updated_at: string;
};

export type ContactRelationship = {
  id: number;
  contact_id: number;
  related_contact_id: number;
  relationship_label: string;
  reciprocal_label: string;
  created_at: string;
};

export type ContactChild = {
  id: number;
  contact_id: number;
  name: string;
  birthday: string | null;
  created_at: string;
  updated_at: string;
};

export type Interaction = {
  id: number;
  contact_id: number;
  date: string;
  occurred_at?: string | null;
  type: string;
  summary: string | null;
  notes: string | null;
  created_at: string;
};

export type Reminder = {
  id: number;
  contact_id: number;
  title: string;
  notes: string | null;
  remind_at: string;
  completed_at: string | null;
  created_at: string;
};

export type Plan = {
  id: number;
  contact_id: number;
  type: string;
  planned_date: string;
  summary: string | null;
  notes: string | null;
  completed_at: string | null;
  created_at: string;
};

export type ContactGroup = {
  id: number;
  name: string;
  color: string | null;
  created_at: string;
};

export type RelationshipFact = {
  id: number;
  contact_id: number;
  category: string;
  label: string;
  value: string | null;
  source: string;
  confidence: number;
  last_verified_at: string | null;
  created_at: string;
};

export type IntegrationConnection = {
  id: number;
  workspace_id: number;
  provider: string;
  label: string;
  status: 'connected' | 'attention' | 'disconnected';
  account_email: string | null;
  last_synced_at: string | null;
  sync_frequency_minutes: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
};

export type SyncJob = {
  id: number;
  workspace_id: number;
  provider: string;
  job_type: string;
  status: string;
  summary: string | null;
  started_at: string;
  finished_at: string | null;
  metadata: string | null;
};
