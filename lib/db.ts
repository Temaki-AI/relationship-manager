import Database from 'better-sqlite3';
import { join } from 'path';

const dbPath = join(process.cwd(), 'data', 'relationships.db');
const db = new Database(dbPath);

// Initialize schema
db.exec(`
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

  CREATE INDEX IF NOT EXISTS idx_contacts_last_contacted ON contacts(last_contacted);
  CREATE INDEX IF NOT EXISTS idx_interactions_contact_id ON interactions(contact_id);
  CREATE INDEX IF NOT EXISTS idx_interactions_date ON interactions(date);
`);

// Check if we need seed data
const contactCount = db.prepare('SELECT COUNT(*) as count FROM contacts').get() as { count: number };

if (contactCount.count === 0) {
  // Seed with sample data
  const insert = db.prepare(`
    INSERT INTO contacts (name, email, phone, how_we_met, tags, last_contacted, contact_frequency, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const sampleContacts = [
    ['Sarah Martinez', 'sarah@example.com', '+1-555-0101', 'Running club 2023', '["running","tech"]', '2026-02-26', 12, 'Marathon training partner. Works at Google.'],
    ['Mike Chen', 'mike@example.com', '+1-555-0102', 'College roommate', '["college","developer"]', '2026-03-05', 10, 'Full-stack developer. Loves sci-fi books.'],
    ['Emily Rodriguez', 'emily@example.com', '+1-555-0103', 'Conference 2024', '["tech","design"]', '2026-03-18', 14, 'UX designer. Birthday March 23.'],
    ['David Lee', 'david@example.com', '+1-555-0104', 'Previous coworker', '["work","hiking"]', '2026-01-30', 21, 'Product manager. Moved to Seattle last year.'],
  ];

  for (const contact of sampleContacts) {
    insert.run(...contact);
  }

  // Add sample interactions
  const insertInteraction = db.prepare(`
    INSERT INTO interactions (contact_id, date, type, summary, notes)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertInteraction.run(1, '2026-02-26', 'call', 'Discussed her new job at Google', 'She got the offer! Starting April 1. Very excited about the team.');
  insertInteraction.run(2, '2026-03-05', 'message', 'Sent book recommendations', 'Recommended Project Hail Mary and The Expanse series.');
  insertInteraction.run(3, '2026-03-18', 'meetup', 'Coffee catch-up', 'Talked about her new design system project. Seems stressed but passionate.');
}

export default db;

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
