import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MOBILE_DATABASE_NAME,
  MOBILE_SCHEMA_SQL,
  MOBILE_SCHEMA_VERSION,
} from '../src/data/schema.ts';

test('the mobile database starts with a monotonic sync-ready schema', () => {
  assert.equal(MOBILE_DATABASE_NAME, 'bonds-mobile.db');
  assert.equal(MOBILE_SCHEMA_VERSION, 14);
  for (const table of ['contacts', 'interactions', 'reminders', 'sync_queue']) {
    assert.match(MOBILE_SCHEMA_SQL, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(MOBILE_SCHEMA_SQL, /id TEXT PRIMARY KEY NOT NULL/);
  assert.match(MOBILE_SCHEMA_SQL, /remote_id INTEGER UNIQUE/);
  assert.match(MOBILE_SCHEMA_SQL, /device_contact_id TEXT/);
  assert.match(MOBILE_SCHEMA_SQL, /deleted_at TEXT/);
  assert.match(MOBILE_SCHEMA_SQL, /FOREIGN KEY \(contact_id\) REFERENCES contacts\(id\) ON DELETE CASCADE/);
  assert.match(MOBILE_SCHEMA_SQL, /sync_state IN \('local', 'pending', 'synced', 'conflict'\)/);
  assert.match(MOBILE_SCHEMA_SQL, /operation IN \('create', 'update', 'delete'\)/);
});

test('the local schema contains no cloud account or analytics storage', () => {
  assert.doesNotMatch(MOBILE_SCHEMA_SQL, /password|session_secret|push_token|analytics|advertising/i);
});
