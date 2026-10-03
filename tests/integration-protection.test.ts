import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import { initializeDatabase } from '../lib/database-initialization.ts';
import {
  consumeScopedImportAttempt,
  SCOPED_IMPORT_DAILY_ATTEMPTS,
  SCOPED_IMPORT_DAILY_WINDOW_MILLISECONDS,
  SCOPED_IMPORT_MINUTE_ATTEMPTS,
  SCOPED_IMPORT_MINUTE_WINDOW_MILLISECONDS,
} from '../lib/integration-protection.ts';

function createDatabase() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  return db;
}

test('scoped imports are bounded by a durable minute window', () => {
  const db = createDatabase();
  const now = Date.UTC(2026, 6, 11, 12, 0, 0);
  try {
    for (let attempt = 0; attempt < SCOPED_IMPORT_MINUTE_ATTEMPTS; attempt++) {
      assert.deepEqual(consumeScopedImportAttempt(db, now), {
        allowed: true,
        retryAfterSeconds: 0,
      });
    }
    assert.deepEqual(consumeScopedImportAttempt(db, now), {
      allowed: false,
      retryAfterSeconds: 60,
    });
    assert.equal(
      consumeScopedImportAttempt(db, now + SCOPED_IMPORT_MINUTE_WINDOW_MILLISECONDS).allowed,
      true
    );
  } finally {
    db.close();
  }
});

test('scoped imports retain a daily account ceiling across minute windows', () => {
  const db = createDatabase();
  const start = Date.UTC(2026, 6, 11, 12, 0, 0);
  try {
    for (let attempt = 0; attempt < SCOPED_IMPORT_DAILY_ATTEMPTS; attempt++) {
      const minuteWindow = Math.floor(attempt / SCOPED_IMPORT_MINUTE_ATTEMPTS);
      const now = start + minuteWindow * (SCOPED_IMPORT_MINUTE_WINDOW_MILLISECONDS + 1);
      assert.equal(consumeScopedImportAttempt(db, now).allowed, true, String(attempt));
    }
    const afterLastMinuteWindow = start
      + Math.floor(SCOPED_IMPORT_DAILY_ATTEMPTS / SCOPED_IMPORT_MINUTE_ATTEMPTS)
        * (SCOPED_IMPORT_MINUTE_WINDOW_MILLISECONDS + 1);
    const blocked = consumeScopedImportAttempt(db, afterLastMinuteWindow);
    assert.equal(blocked.allowed, false);
    assert(blocked.retryAfterSeconds > 60);
    assert.equal(
      consumeScopedImportAttempt(db, start + SCOPED_IMPORT_DAILY_WINDOW_MILLISECONDS).allowed,
      true
    );
  } finally {
    db.close();
  }
});
