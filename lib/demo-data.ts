import type BetterSqlite3 from 'better-sqlite3';
import { withDatabaseBusyRetry } from './database-initialization.ts';

export const DEMO_SEED_KEY = 'demo-data-v1';

type Environment = Record<string, string | undefined>;

export type DemoDataInitialization =
  | 'already-initialized'
  | 'recorded-existing-data'
  | 'seeded'
  | 'skipped';

export function shouldSeedDemoData(environment: Environment = process.env): boolean {
  if (environment.SEED_DEMO_DATA === 'true') return true;
  if (environment.SEED_DEMO_DATA === 'false') return false;
  return environment.NODE_ENV === 'development';
}

export function initializeDemoData(
  db: BetterSqlite3.Database,
  environment: Environment = process.env
): DemoDataInitialization {
  const initialize = db.transaction((): DemoDataInitialization => {
    const existingMarker = db
      .prepare('SELECT value FROM app_metadata WHERE key = ?')
      .get(DEMO_SEED_KEY);

    if (existingMarker) return 'already-initialized';

    const { count } = db
      .prepare('SELECT COUNT(*) as count FROM contacts')
      .get() as { count: number };

    if (count > 0) {
      db.prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)')
        .run(DEMO_SEED_KEY, 'existing-data');
      return 'recorded-existing-data';
    }

    if (!shouldSeedDemoData(environment)) return 'skipped';

    const insertContact = db.prepare(`
      INSERT INTO contacts (
        name, email, phone, how_we_met, tags, last_contacted,
        contact_frequency, notes, birthday, custom_fields
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const contacts = [
      {
        name: 'Sarah Martinez',
        email: 'sarah@example.com',
        phone: '+1-555-0101',
        howWeMet: 'Running club 2023',
        tags: '["friend","running"]',
        lastContacted: '2026-02-26',
        frequency: 12,
        notes: 'Marathon training partner. Works at Google.',
        birthday: '1991-03-23',
        customFields: JSON.stringify({
          social: { linkedin: 'https://www.linkedin.com/in/sarah-martinez/' },
          linkedin: { company: 'Google', location: 'San Francisco', imported_at: '2026-02-01T09:00:00.000Z' },
        }),
      },
      {
        name: 'Mike Chen',
        email: 'mike@example.com',
        phone: '+1-555-0102',
        howWeMet: 'College roommate',
        tags: '["college","developer"]',
        lastContacted: '2026-03-05',
        frequency: 10,
        notes: 'Full-stack developer. Loves sci-fi books.',
        birthday: null,
        customFields: JSON.stringify({
          linkedin: { company: 'Linear', location: 'New York', imported_at: '2026-02-10T14:20:00.000Z' },
        }),
      },
      {
        name: 'Emily Rodriguez',
        email: 'emily@example.com',
        phone: '+1-555-0103',
        howWeMet: 'Conference 2024',
        tags: '["tech","design","work"]',
        lastContacted: '2026-03-18',
        frequency: 14,
        notes: 'UX designer. Birthday March 23.',
        birthday: '1992-03-23',
        customFields: JSON.stringify({
          linkedin: { company: 'Figma', location: 'London', imported_at: '2026-01-15T12:30:00.000Z' },
        }),
      },
      {
        name: 'David Lee',
        email: 'david@example.com',
        phone: '+1-555-0104',
        howWeMet: 'Previous coworker',
        tags: '["work","hiking"]',
        lastContacted: '2026-01-30',
        frequency: 21,
        notes: 'Product manager. Moved to Seattle last year.',
        birthday: null,
        customFields: JSON.stringify({
          linkedin: { company: 'Notion', location: 'Seattle', imported_at: '2026-02-21T08:45:00.000Z' },
        }),
      },
    ];

    const contactIds = contacts.map((contact) => Number(insertContact.run(
      contact.name,
      contact.email,
      contact.phone,
      contact.howWeMet,
      contact.tags,
      contact.lastContacted,
      contact.frequency,
      contact.notes,
      contact.birthday,
      contact.customFields
    ).lastInsertRowid));

    const insertInteraction = db.prepare(`
      INSERT INTO interactions (contact_id, date, type, summary, notes)
      VALUES (?, ?, ?, ?, ?)
    `);

    insertInteraction.run(contactIds[0], '2026-02-26', 'call', 'Discussed her new job at Google', 'She got the offer! Starting April 1. Very excited about the team.');
    insertInteraction.run(contactIds[0], '2026-03-20', 'message', 'Shared a long-run training plan', 'She is training for a spring half marathon.');
    insertInteraction.run(contactIds[1], '2026-03-05', 'message', 'Sent book recommendations', 'Recommended Project Hail Mary and The Expanse series.');
    insertInteraction.run(contactIds[2], '2026-03-18', 'meetup', 'Coffee catch-up', 'Talked about her new design system project. Seems stressed but passionate.');
    insertInteraction.run(contactIds[3], '2026-02-12', 'email', 'Followed up after product launch', 'He mentioned hiring might open later this quarter.');

    const insertReminder = db.prepare(`
      INSERT INTO reminders (contact_id, title, notes, remind_at)
      VALUES (?, ?, ?, ?)
    `);

    insertReminder.run(contactIds[0], 'Wish Sarah happy birthday', 'Send a quick voice note and ask about her first month at Google.', '2026-03-22T09:00:00.000Z');
    insertReminder.run(contactIds[3], 'Check in on Seattle move', 'Ask how the new team is settling in.', '2026-04-08T13:00:00.000Z');

    const insertFact = db.prepare(`
      INSERT INTO relationship_facts (contact_id, category, label, value, source, confidence, last_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertFact.run(contactIds[0], 'personal', 'Training goal', 'Half marathon in May', 'manual', 1, '2026-03-20T18:00:00.000Z');
    insertFact.run(contactIds[1], 'interest', 'Favorite genre', 'Science fiction', 'manual', 1, '2026-03-05T18:00:00.000Z');
    insertFact.run(contactIds[2], 'work', 'Current focus', 'Design systems', 'manual', 0.9, '2026-03-18T16:00:00.000Z');
    insertFact.run(contactIds[3], 'life', 'Recent move', 'Moved to Seattle', 'manual', 1, '2026-02-12T10:00:00.000Z');

    db.prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)')
      .run(DEMO_SEED_KEY, 'seeded');
    return 'seeded';
  });

  return withDatabaseBusyRetry(() => initialize.immediate());
}
