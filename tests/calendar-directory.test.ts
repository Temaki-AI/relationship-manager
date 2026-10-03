import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import {
  CalendarRangeError,
  listCalendarEvents,
  normalizeCalendarRange,
} from '../lib/calendar-directory.ts';
import { initializeDatabase } from '../lib/database-initialization.ts';

function createDatabase() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const contactId = Number(db.prepare(
    'INSERT INTO contacts (name, birthday) VALUES (?, ?)'
  ).run('Ada Lovelace', '1990-07-15').lastInsertRowid);
  return { db, contactId };
}

test('calendar combines recurring birthdays, children, reminders, plans, and history', () => {
  const { db, contactId } = createDatabase();
  try {
    db.prepare('INSERT INTO contact_children (contact_id, name, birthday) VALUES (?, ?, ?)')
      .run(contactId, 'Lin', '2020-07-16');
    db.prepare('INSERT INTO reminders (contact_id, title, remind_at) VALUES (?, ?, ?)')
      .run(contactId, 'Send a note', '2026-07-14T22:30:00.000Z');
    db.prepare(`
      INSERT INTO plans (contact_id, type, planned_date, summary, completed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(contactId, 'meetup', '2026-07-17', 'Coffee together', '2026-07-17T14:00:00.000Z');
    db.prepare('INSERT INTO interactions (contact_id, date, type, summary) VALUES (?, ?, ?, ?)')
      .run(contactId, '2026-07-18', 'call', 'Summer catch-up');

    const result = listCalendarEvents(db, {
      start: '2026-07-13',
      end: '2026-07-19',
      timeZone: 'Europe/Berlin',
    });

    assert.equal(result.truncated, false);
    assert.deepEqual(result.range, { start: '2026-07-13', end: '2026-07-19' });
    assert.deepEqual(result.events.map((event) => [event.kind, event.date, event.title]), [
      ['birthday', '2026-07-15', "Ada Lovelace's birthday"],
      ['reminder', '2026-07-15', 'Send a note'],
      ['birthday', '2026-07-16', "Lin's birthday"],
      ['plan', '2026-07-17', 'Coffee together'],
      ['interaction', '2026-07-18', 'Summer catch-up'],
    ]);
    assert.equal(result.events.find((event) => event.kind === 'plan')?.completed, true);
    assert.equal(result.events.find((event) => event.subtype === 'child')?.contact_id, contactId);
  } finally {
    db.close();
  }
});

test('calendar ranges are ordered, valid, and bounded', () => {
  assert.deepEqual(normalizeCalendarRange('2026-07-01', '2026-07-31'), {
    start: '2026-07-01',
    end: '2026-07-31',
  });
  assert.throws(
    () => normalizeCalendarRange('2026-07-31', '2026-07-01'),
    CalendarRangeError
  );
  assert.throws(
    () => normalizeCalendarRange('2026-01-01', '2026-04-01'),
    /limited to 62 days/i
  );
  assert.throws(() => normalizeCalendarRange('not-a-date', '2026-07-01'), /valid start/i);
});

test('a linked child has one birthday event from their contact profile', () => {
  const { db, contactId } = createDatabase();
  try {
    const childId = Number(db.prepare('INSERT INTO contacts (name, birthday) VALUES (?, ?)')
      .run('Lin', '2020-07-16').lastInsertRowid);
    db.prepare('INSERT INTO contact_children (contact_id, linked_contact_id, name, birthday) VALUES (?, ?, ?, ?)')
      .run(contactId, childId, 'Old alias', '2020-07-16');
    const events = listCalendarEvents(db, { start: '2026-07-16', end: '2026-07-16', timeZone: 'UTC' }).events;
    assert.deepEqual(events.filter((event) => event.kind === 'birthday').map((event) => [event.subtype, event.title]), [
      ['contact', "Lin's birthday"],
    ]);
  } finally { db.close(); }
});
