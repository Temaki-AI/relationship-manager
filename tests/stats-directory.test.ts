import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { birthdayStatsSQL, checkInStatsSQL, MAX_STATS_BIRTHDAYS, statsResponse } from '../lib/stats-directory.ts';

test('stats queries include a check-in due today and observe leap-day birthdays on March 1', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE contacts (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, birthday TEXT, last_contacted TEXT, contact_frequency INTEGER
    )`);
    db.prepare('INSERT INTO contacts (id, name, birthday, last_contacted, contact_frequency) VALUES (?, ?, ?, ?, ?)')
      .run(1, 'Ada', '2000-02-29', '2025-02-22', 7);
    db.prepare('INSERT INTO contacts (id, name, birthday, last_contacted, contact_frequency) VALUES (?, ?, ?, ?, ?)')
      .run(2, 'Grace', '1990-03-02', '2025-02-28', 7);
    const rhythms = db.prepare(checkInStatsSQL(false, false)).get('2025-03-01') as { ready: number; neglected: number };
    const actionItems = db.prepare(checkInStatsSQL(false, true)).all('2025-03-01') as Array<{ id: number }>;
    const birthdays = db.prepare(birthdayStatsSQL(false)).all('2025-03-01') as Array<{
      id: number; name: string; birthday: string; daysUntil: number; total: number;
    }>;
    const response = statsResponse(2, 0, rhythms, actionItems, birthdays);
    assert.equal(response.stats.readyToReconnectCount, 1);
    assert.equal(response.stats.neglectedCount, 0);
    assert.deepEqual(response.actionItems, [1]);
    assert.deepEqual(response.upcomingBirthdays.map(({ id, daysUntil }) => ({ id, daysUntil })), [
      { id: 1, daysUntil: 0 }, { id: 2, daysUntil: 1 },
    ]);
  } finally { db.close(); }
});

test('stats birthday results are bounded without hiding the total', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, birthday TEXT)');
    const insert = db.prepare('INSERT INTO contacts (name, birthday) VALUES (?, ?)');
    for (let index = 0; index < MAX_STATS_BIRTHDAYS + 1; index += 1) insert.run(`Person ${index}`, '2000-10-02');
    const birthdays = db.prepare(birthdayStatsSQL(false)).all('2026-10-02') as Array<{
      id: number; name: string; birthday: string; daysUntil: number; total: number;
    }>;
    const response = statsResponse(MAX_STATS_BIRTHDAYS + 1, 0, null, [], birthdays);
    assert.equal(response.stats.upcomingBirthdaysCount, MAX_STATS_BIRTHDAYS + 1);
    assert.equal(response.upcomingBirthdays.length, MAX_STATS_BIRTHDAYS);
    assert.equal(response.upcomingBirthdaysTruncated, true);
  } finally { db.close(); }
});
