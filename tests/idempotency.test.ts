import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  fingerprintIdempotencyInput,
  IdempotencyError,
  requireIdempotencyKey,
  runIdempotentCreate,
} from '../lib/idempotency.ts';

const KEY = 'fcefab31-9a20-49a7-95ec-86bd146bb268';

function createDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      value TEXT NOT NULL
    );
  `);
  return db;
}

test('create requests require a random UUID idempotency key', () => {
  assert.throws(
    () => requireIdempotencyKey(new Headers()),
    (error: unknown) => error instanceof IdempotencyError && error.status === 400
  );
  assert.throws(
    () => requireIdempotencyKey(new Headers({ 'Idempotency-Key': 'predictable-key' })),
    (error: unknown) => error instanceof IdempotencyError && error.status === 400
  );
  assert.equal(
    requireIdempotencyKey(new Headers({ 'Idempotency-Key': KEY.toUpperCase() })),
    KEY
  );
});

test('canonical request fingerprints ignore object key order', () => {
  assert.equal(
    fingerprintIdempotencyInput({ name: 'Ada', tags: ['friend'], nested: { b: 2, a: 1 } }),
    fingerprintIdempotencyInput({ nested: { a: 1, b: 2 }, tags: ['friend'], name: 'Ada' })
  );
});

test('replaying a create key returns the original record exactly once', () => {
  const db = createDatabase();
  let createCount = 0;
  const run = () => runIdempotentCreate(db, {
    scope: 'contacts-create',
    idempotencyKey: KEY,
    fingerprint: fingerprintIdempotencyInput({ name: 'Ada' }),
    create: () => {
      createCount++;
      const result = db.prepare('INSERT INTO records (value) VALUES (?)').run('Ada');
      return db.prepare('SELECT * FROM records WHERE id = ?').get(result.lastInsertRowid) as { id: number; value: string };
    },
    load: (id) => db.prepare('SELECT * FROM records WHERE id = ?').get(id) as { id: number; value: string } | undefined,
  });

  const created = run();
  const replayed = run();
  assert.equal(created.replayed, false);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.resource, created.resource);
  assert.equal(createCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM records').pluck().get(), 1);
  db.close();
});

test('key reuse with changed input or a missing original result fails closed', () => {
  const db = createDatabase();
  const run = (fingerprint: string) => runIdempotentCreate(db, {
    scope: 'reminders-create',
    idempotencyKey: KEY,
    fingerprint,
    create: () => {
      const result = db.prepare('INSERT INTO records (value) VALUES (?)').run('Follow up');
      return db.prepare('SELECT * FROM records WHERE id = ?').get(result.lastInsertRowid) as { id: number; value: string };
    },
    load: (id) => db.prepare('SELECT * FROM records WHERE id = ?').get(id) as { id: number; value: string } | undefined,
  });

  const fingerprint = fingerprintIdempotencyInput({ title: 'Follow up' });
  const created = run(fingerprint);
  assert.throws(
    () => run(fingerprintIdempotencyInput({ title: 'Changed' })),
    (error: unknown) => error instanceof IdempotencyError && error.status === 409
  );
  db.prepare('DELETE FROM records WHERE id = ?').run(created.resource!.id);
  assert.throws(
    () => run(fingerprint),
    (error: unknown) => error instanceof IdempotencyError && error.status === 409
  );
  assert.equal(db.prepare('SELECT COUNT(*) FROM records').pluck().get(), 0);
  db.close();
});

test('expired ledger entries are pruned without touching unrelated metadata', () => {
  const db = createDatabase();
  db.prepare(`INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, datetime('now', '-8 days'))`)
    .run('idempotency:contacts-create:expired', '{}');
  db.prepare(`INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, datetime('now', '-8 days'))`)
    .run('schema-version', '1');

  runIdempotentCreate(db, {
    scope: 'contacts-create',
    idempotencyKey: KEY,
    fingerprint: fingerprintIdempotencyInput({ name: 'Grace' }),
    create: () => {
      const result = db.prepare('INSERT INTO records (value) VALUES (?)').run('Grace');
      return { id: Number(result.lastInsertRowid) };
    },
    load: (id) => ({ id }),
  });

  assert.equal(db.prepare(`SELECT COUNT(*) FROM app_metadata WHERE key = 'idempotency:contacts-create:expired'`).pluck().get(), 0);
  assert.equal(db.prepare(`SELECT value FROM app_metadata WHERE key = 'schema-version'`).pluck().get(), '1');
  db.close();
});

test('capacity pruning protects a replayed key and bounds genuinely new records', () => {
  const db = createDatabase();
  const fingerprint = fingerprintIdempotencyInput({ name: 'Protected replay' });
  db.prepare(`INSERT INTO records (id, value) VALUES (1, 'Protected replay')`).run();
  const insertMetadata = db.prepare(`
    INSERT INTO app_metadata (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `);
  insertMetadata.run(
    `idempotency:contacts-create:${KEY}`,
    JSON.stringify({ fingerprint, resourceId: 1 })
  );
  for (let index = 0; index < 5_000; index++) {
    insertMetadata.run(
      `idempotency:seed:${String(index).padStart(5, '0')}`,
      JSON.stringify({ fingerprint, resourceId: 1 })
    );
  }

  const replay = runIdempotentCreate(db, {
    scope: 'contacts-create',
    idempotencyKey: KEY,
    fingerprint,
    create: () => assert.fail('A protected replay must never create again'),
    load: (id) => db.prepare('SELECT * FROM records WHERE id = ?').get(id) as { id: number; value: string } | undefined,
  });
  assert.equal(replay.replayed, true);
  assert.equal(db.prepare(`SELECT COUNT(*) FROM app_metadata WHERE key LIKE 'idempotency:%'`).pluck().get(), 5_001);

  runIdempotentCreate(db, {
    scope: 'contacts-create',
    idempotencyKey: 'e0109af7-f9f5-4c43-a66e-4c8ea91e25c6',
    fingerprint: fingerprintIdempotencyInput({ name: 'New record' }),
    create: () => {
      const result = db.prepare('INSERT INTO records (value) VALUES (?)').run('New record');
      return { id: Number(result.lastInsertRowid) };
    },
    load: (id) => ({ id }),
  });
  assert.equal(db.prepare(`SELECT COUNT(*) FROM app_metadata WHERE key LIKE 'idempotency:%'`).pluck().get(), 5_000);
  db.close();
});
