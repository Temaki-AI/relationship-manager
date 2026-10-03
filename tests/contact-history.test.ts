import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import {
  listContactFactsPage,
  listContactInteractionsPage,
  listContactPlansPage,
  listContactRemindersPage,
  listContactTimelinePage,
  loadContactDetailData,
  parseTimelineKindFilter,
} from '../lib/contact-history.ts';
import type { Contact } from '../lib/db.ts';
import { buildTimeline } from '../lib/intelligence.ts';

function createDatabase(): { db: Database.Database; contact: Contact } {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      nickname TEXT,
      email TEXT,
      phone TEXT,
      photo_url TEXT,
      birthday TEXT,
      birthday_reminder_days INTEGER NOT NULL,
      how_we_met TEXT,
      tags TEXT,
      notes TEXT,
      gift_ideas TEXT,
      custom_fields TEXT,
      last_contacted TEXT,
      contact_frequency INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE interactions (
      id INTEGER PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      summary TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      remind_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE relationship_facts (
      id INTEGER PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      value TEXT,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      last_verified_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE plans (
      id INTEGER PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      planned_date TEXT NOT NULL,
      summary TEXT,
      notes TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE contact_relationships (
      id INTEGER PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      related_contact_id INTEGER NOT NULL,
      relationship_label TEXT NOT NULL,
      reciprocal_label TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE contact_children (
      id INTEGER PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      linked_contact_id INTEGER,
      name TEXT NOT NULL,
      birthday TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const contact: Contact = {
    id: 1,
    name: 'History Scale Contact',
    nickname: null,
    email: 'history@example.test',
    phone: null,
    photo_url: null,
    birthday: null,
    birthday_reminder_days: 7,
    how_we_met: 'Community dinner',
    tags: '["friend"]',
    notes: 'Long-running relationship.',
    gift_ideas: '["Book","Coffee"]',
    custom_fields: JSON.stringify({
      linkedin: {
        company: 'Scale Labs',
        location: 'Berlin',
        imported_at: '2026-01-02T10:00:00.000Z',
      },
    }),
    last_contacted: '2026-07-10',
    contact_frequency: 14,
    created_at: '2025-01-01T10:00:00.000Z',
    updated_at: '2026-07-10T10:00:00.000Z',
  };
  db.prepare(`
    INSERT INTO contacts VALUES (
      @id, @name, @nickname, @email, @phone, @photo_url, @birthday, @birthday_reminder_days, @how_we_met,
      @tags, @notes, @gift_ideas, @custom_fields, @last_contacted,
      @contact_frequency, @created_at, @updated_at
    )
  `).run(contact);

  const insertInteraction = db.prepare(`
    INSERT INTO interactions (id, contact_id, date, type, summary, notes, created_at)
    VALUES (?, 1, ?, 'message', ?, ?, ?)
  `);
  for (let id = 1; id <= 137; id += 1) {
    const timestamp = new Date(Date.UTC(2026, 0, id, 12)).toISOString();
    insertInteraction.run(id, timestamp.slice(0, 10), `Interaction ${id}`, `Note ${id}`, timestamp);
  }

  const insertReminder = db.prepare(`
    INSERT INTO reminders (id, contact_id, title, notes, remind_at, completed_at, created_at)
    VALUES (?, 1, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')
  `);
  for (let id = 1; id <= 27; id += 1) {
    insertReminder.run(
      id,
      `Reminder ${id}`,
      `Reminder note ${id}`,
      new Date(Date.UTC(2026, 7, id, 9)).toISOString(),
      id > 25 ? new Date(Date.UTC(2026, 6, id, 9)).toISOString() : null
    );
  }

  const insertFact = db.prepare(`
    INSERT INTO relationship_facts (
      id, contact_id, category, label, value, source, confidence, last_verified_at, created_at
    ) VALUES (?, 1, 'personal', ?, ?, 'manual', 1, ?, '2026-01-01T00:00:00.000Z')
  `);
  for (let id = 1; id <= 45; id += 1) {
    insertFact.run(id, `Fact ${id}`, `Value ${id}`, new Date(Date.UTC(2026, 2, id)).toISOString());
  }

  const insertPlan = db.prepare(`
    INSERT INTO plans (
      id, contact_id, type, planned_date, summary, notes, completed_at, created_at
    ) VALUES (?, 1, 'call', ?, ?, NULL, ?, '2026-01-01T00:00:00.000Z')
  `);
  for (let id = 1; id <= 43; id += 1) {
    insertPlan.run(
      id,
      new Date(Date.UTC(2026, 8, id)).toISOString().slice(0, 10),
      `Plan ${id}`,
      id > 40 ? '2026-06-01T10:00:00.000Z' : null
    );
  }
  return { db, contact };
}

test('contact history collections are independently paged with exact totals', () => {
  const { db, contact } = createDatabase();
  try {
    const interactions = listContactInteractionsPage(db, contact.id);
    assert.equal(interactions.interactions.length, 30);
    assert.deepEqual(interactions.pagination, {
      page: 1,
      pageSize: 30,
      total: 137,
      totalPages: 5,
    });
    assert.equal(interactions.interactions[0].id, 137);
    assert.match(interactions.interactions[0].edit_revision, /^[a-f0-9]{64}$/);
    const lastInteractions = listContactInteractionsPage(db, contact.id, { page: 99 });
    assert.equal(lastInteractions.pagination.page, 5);
    assert.equal(lastInteractions.interactions.length, 17);

    const reminders = listContactRemindersPage(db, contact.id);
    assert.equal(reminders.reminders.length, 3);
    assert.equal(reminders.pagination.total, 25);
    assert(reminders.reminders.every((reminder) => reminder.completed_at === null));

    const facts = listContactFactsPage(db, contact.id);
    assert.equal(facts.facts.length, 4);
    assert.equal(facts.pagination.total, 45);

    const plans = listContactPlansPage(db, contact.id);
    assert.equal(plans.plans.length, 20);
    assert.equal(plans.pagination.total, 40);
    assert(plans.plans.every((plan) => plan.completed_at === null));
  } finally {
    db.close();
  }
});

test('merged contact timeline stays bounded, chronological, and fully pageable', () => {
  const { db, contact } = createDatabase();
  try {
    const derivedCount = buildTimeline(contact, [], [], []).length;
    const first = listContactTimelinePage(db, contact);
    const expectedTotal = 137 + 27 + 45 + derivedCount;
    assert.equal(first.timeline.length, 30);
    assert.equal(first.pagination.total, expectedTotal);
    assert.equal(first.pagination.totalPages, Math.ceil(expectedTotal / 30));
    assert.deepEqual(
      Object.keys(first.timeline[0]).sort(),
      ['date', 'id', 'kind', 'summary', 'title', 'tone']
    );
    const timestamps = first.timeline.map((item) => Date.parse(item.date));
    assert.deepEqual(timestamps, [...timestamps].sort((left, right) => right - left));

    const last = listContactTimelinePage(db, contact, { page: 999 });
    assert.equal(last.pagination.page, last.pagination.totalPages);
    assert(last.timeline.length > 0 && last.timeline.length <= 30);
  } finally {
    db.close();
  }
});

test('timeline kind filters page matching source records without leaking other kinds', () => {
  const { db, contact } = createDatabase();
  try {
    assert.equal(parseTimelineKindFilter('interaction'), 'interaction');
    assert.equal(parseTimelineKindFilter('other'), null);
    const first = listContactTimelinePage(db, contact, { kind: 'interaction', pageSize: 10 });
    assert.equal(first.pagination.total, 137);
    assert.equal(first.timeline.length, 10);
    assert(first.timeline.every((item) => item.kind === 'interaction'));
    const second = listContactTimelinePage(db, contact, { kind: 'interaction', pageSize: 10, page: 2 });
    assert.equal(second.timeline.length, 10);
    assert.equal(new Set([...first.timeline, ...second.timeline].map((item) => item.id)).size, 20);
    const reminders = listContactTimelinePage(db, contact, { kind: 'reminder' });
    assert.equal(reminders.pagination.total, 27);
    assert(reminders.timeline.every((item) => item.kind === 'reminder'));
  } finally {
    db.close();
  }
});

test('contact detail bootstrap is bounded while briefs use full activity totals', () => {
  const { db, contact } = createDatabase();
  try {
    const detail = loadContactDetailData(db, contact);
    assert.equal(detail.interactions.length, 30);
    assert.equal(detail.reminders.length, 3);
    assert.equal(detail.facts.length, 4);
    assert.equal(detail.plans.length, 20);
    assert.equal(detail.timeline.length, 30);
    assert.equal(detail.history.interactions.total, 137);
    assert.equal(detail.history.reminders.total, 25);
    assert.equal(detail.history.facts.total, 45);
    assert.equal(detail.history.plans.total, 40);
    assert.match(detail.brief.summary, /Interaction 137|Scale Labs/);
  } finally {
    db.close();
  }
});
