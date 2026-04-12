import Database from 'better-sqlite3';
import { join } from 'path';

const dbPath = join(process.cwd(), 'data', 'relationships.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'premium',
    persona TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    photo_url TEXT,
    birthday DATE,
    how_we_met TEXT,
    tags TEXT,
    notes TEXT,
    gift_ideas TEXT,
    custom_fields TEXT,
    last_contacted DATE,
    contact_frequency INTEGER DEFAULT 14,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    date DATE NOT NULL,
    type TEXT NOT NULL,
    summary TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    notes TEXT,
    remind_at DATETIME NOT NULL,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contact_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contact_group_members (
    contact_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    PRIMARY KEY (contact_id, group_id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES contact_groups(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS relationship_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    label TEXT NOT NULL,
    value TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    confidence REAL NOT NULL DEFAULT 1,
    last_verified_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS integration_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'disconnected',
    account_email TEXT,
    last_synced_at DATETIME,
    sync_frequency_minutes INTEGER NOT NULL DEFAULT 60,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (workspace_id, provider),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sync_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    metadata TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_last_contacted ON contacts(last_contacted);
  CREATE INDEX IF NOT EXISTS idx_interactions_contact_id ON interactions(contact_id);
  CREATE INDEX IF NOT EXISTS idx_interactions_date ON interactions(date);
  CREATE INDEX IF NOT EXISTS idx_reminders_contact_id ON reminders(contact_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_remind_at ON reminders(remind_at);
  CREATE INDEX IF NOT EXISTS idx_relationship_facts_contact_id ON relationship_facts(contact_id);
  CREATE INDEX IF NOT EXISTS idx_integration_connections_workspace ON integration_connections(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_sync_jobs_workspace_provider ON sync_jobs(workspace_id, provider, started_at DESC);
`);

const workspaceCount = db.prepare('SELECT COUNT(*) as count FROM workspaces').get() as { count: number };

if (workspaceCount.count === 0) {
  db.prepare(
    'INSERT INTO workspaces (name, plan, persona) VALUES (?, ?, ?)'
  ).run('Bonds HQ', 'premium', 'automation-first');
}

const defaultWorkspace = db.prepare('SELECT * FROM workspaces ORDER BY id LIMIT 1').get() as Workspace;

const defaultIntegrationSeed = [
  {
    provider: 'local',
    label: 'Local CRM',
    status: 'connected',
    syncFrequencyMinutes: 15,
    metadata: JSON.stringify({ description: 'Primary local data store and migration bridge.' }),
  },
  {
    provider: 'google',
    label: 'Google Contacts, Gmail, Calendar',
    status: 'disconnected',
    syncFrequencyMinutes: 30,
    metadata: JSON.stringify({ roadmap: 'phase-2' }),
  },
  {
    provider: 'outlook',
    label: 'Microsoft 365',
    status: 'disconnected',
    syncFrequencyMinutes: 30,
    metadata: JSON.stringify({ roadmap: 'phase-2' }),
  },
  {
    provider: 'linkedin',
    label: 'LinkedIn Extension',
    status: 'attention',
    syncFrequencyMinutes: 120,
    metadata: JSON.stringify({ roadmap: 'phase-4', channel: 'browser-extension' }),
  },
  {
    provider: 'mobile',
    label: 'Mobile Capture',
    status: 'disconnected',
    syncFrequencyMinutes: 10,
    metadata: JSON.stringify({ roadmap: 'phase-4' }),
  },
];

const insertIntegration = db.prepare(`
  INSERT OR IGNORE INTO integration_connections (
    workspace_id, provider, label, status, sync_frequency_minutes, metadata, last_synced_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`);

for (const integration of defaultIntegrationSeed) {
  insertIntegration.run(
    defaultWorkspace.id,
    integration.provider,
    integration.label,
    integration.status,
    integration.syncFrequencyMinutes,
    integration.metadata,
    integration.status === 'connected' ? new Date().toISOString() : null
  );
}

const syncJobCount = db.prepare('SELECT COUNT(*) as count FROM sync_jobs').get() as { count: number };

if (syncJobCount.count === 0) {
  db.prepare(`
    INSERT INTO sync_jobs (workspace_id, provider, job_type, status, summary, finished_at, metadata)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
  `).run(
    defaultWorkspace.id,
    'local',
    'migration',
    'success',
    'Initialized Bonds V2 workspace foundation',
    JSON.stringify({ version: '2.0-foundation' })
  );
}

const contactCount = db.prepare('SELECT COUNT(*) as count FROM contacts').get() as { count: number };

if (contactCount.count === 0) {
  const insertContact = db.prepare(`
    INSERT INTO contacts (name, email, phone, how_we_met, tags, last_contacted, contact_frequency, notes, birthday, custom_fields)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const sampleContacts = [
    [
      'Sarah Martinez',
      'sarah@example.com',
      '+1-555-0101',
      'Running club 2023',
      '["friend","running"]',
      '2026-02-26',
      12,
      'Marathon training partner. Works at Google.',
      '1991-03-23',
      JSON.stringify({
        social: { linkedin: 'https://www.linkedin.com/in/sarah-martinez/' },
        linkedin: { company: 'Google', location: 'San Francisco', imported_at: '2026-02-01T09:00:00.000Z' },
      }),
    ],
    [
      'Mike Chen',
      'mike@example.com',
      '+1-555-0102',
      'College roommate',
      '["college","developer"]',
      '2026-03-05',
      10,
      'Full-stack developer. Loves sci-fi books.',
      null,
      JSON.stringify({
        linkedin: { company: 'Linear', location: 'New York', imported_at: '2026-02-10T14:20:00.000Z' },
      }),
    ],
    [
      'Emily Rodriguez',
      'emily@example.com',
      '+1-555-0103',
      'Conference 2024',
      '["tech","design","work"]',
      '2026-03-18',
      14,
      'UX designer. Birthday March 23.',
      '1992-03-23',
      JSON.stringify({
        linkedin: { company: 'Figma', location: 'London', imported_at: '2026-01-15T12:30:00.000Z' },
      }),
    ],
    [
      'David Lee',
      'david@example.com',
      '+1-555-0104',
      'Previous coworker',
      '["work","hiking"]',
      '2026-01-30',
      21,
      'Product manager. Moved to Seattle last year.',
      null,
      JSON.stringify({
        linkedin: { company: 'Notion', location: 'Seattle', imported_at: '2026-02-21T08:45:00.000Z' },
      }),
    ],
  ];

  for (const contact of sampleContacts) {
    insertContact.run(...contact);
  }

  const insertInteraction = db.prepare(`
    INSERT INTO interactions (contact_id, date, type, summary, notes)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertInteraction.run(1, '2026-02-26', 'call', 'Discussed her new job at Google', 'She got the offer! Starting April 1. Very excited about the team.');
  insertInteraction.run(1, '2026-03-20', 'message', 'Shared a long-run training plan', 'She is training for a spring half marathon.');
  insertInteraction.run(2, '2026-03-05', 'message', 'Sent book recommendations', 'Recommended Project Hail Mary and The Expanse series.');
  insertInteraction.run(3, '2026-03-18', 'meetup', 'Coffee catch-up', 'Talked about her new design system project. Seems stressed but passionate.');
  insertInteraction.run(4, '2026-02-12', 'email', 'Followed up after product launch', 'He mentioned hiring might open later this quarter.');

  const insertReminder = db.prepare(`
    INSERT INTO reminders (contact_id, title, notes, remind_at)
    VALUES (?, ?, ?, ?)
  `);

  insertReminder.run(1, 'Wish Sarah happy birthday', 'Send a quick voice note and ask about her first month at Google.', '2026-03-22T09:00:00.000Z');
  insertReminder.run(4, 'Check in on Seattle move', 'Ask how the new team is settling in.', '2026-04-08T13:00:00.000Z');

  const insertFact = db.prepare(`
    INSERT INTO relationship_facts (contact_id, category, label, value, source, confidence, last_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertFact.run(1, 'personal', 'Training goal', 'Half marathon in May', 'manual', 1, '2026-03-20T18:00:00.000Z');
  insertFact.run(2, 'interest', 'Favorite genre', 'Science fiction', 'manual', 1, '2026-03-05T18:00:00.000Z');
  insertFact.run(3, 'work', 'Current focus', 'Design systems', 'manual', 0.9, '2026-03-18T16:00:00.000Z');
  insertFact.run(4, 'life', 'Recent move', 'Moved to Seattle', 'manual', 1, '2026-02-12T10:00:00.000Z');
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
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  photo_url: string | null;
  birthday: string | null;
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

export type Interaction = {
  id: number;
  contact_id: number;
  date: string;
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
