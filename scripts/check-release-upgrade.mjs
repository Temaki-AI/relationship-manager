import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

// Rehearse the real D1 upgrade on a private local copy, without logging CRM data.
const [snapshot, output] = process.argv.slice(2);
if (!snapshot || !output) throw new Error('Usage: node scripts/check-release-upgrade.mjs SNAPSHOT.sql NEW-COPY.db');
if (existsSync(output)) throw new Error('Choose a new output file; existing databases are never replaced.');
writeFileSync(output, '', { mode: 0o600, flag: 'wx' });
const database = new Database(resolve(output));
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
function fingerprint(table, columns) {
  const rows = database.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}`).all();
  const encoded = rows.map((row) => JSON.stringify(row)).sort();
  return { rows: rows.length, sha256: createHash('sha256').update(JSON.stringify(encoded)).digest('hex') };
}
try {
  // D1 exports order tables independently of their foreign-key dependencies.
  // Validate references after loading the complete isolated copy.
  database.pragma('foreign_keys = OFF');
  database.exec(readFileSync(snapshot, 'utf8'));
  database.pragma('foreign_keys = ON');
  assert.deepEqual(database.pragma('foreign_key_check'), [], 'The original backup has broken references.');
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations' ORDER BY name").all();
  const original = tables.map(({ name }) => {
    // Existing recovery triggers advance this counter when migrations backfill
    // the added identities/methods. The actual workspace and CRM fields must match.
    const columns = database.pragma(`table_info(${quote(name)})`).map((column) => column.name)
      .filter((column) => name !== 'workspaces' || column !== 'recovery_revision');
    return { name, columns, ...fingerprint(name, columns) };
  });
  const recoveryRevisions = database.prepare('SELECT id, recovery_revision FROM workspaces').all();
  const applied = new Set(database.prepare('SELECT name FROM d1_migrations').all().map((row) => row.name));
  const migrations = readdirSync('drizzle').filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const name of applied) assert.ok(migrations.includes(name), 'Backup migration is not in this checkout.');
  const pending = migrations.filter((name) => !applied.has(name));
  for (const name of pending) {
    database.transaction(() => {
      database.exec(readFileSync(resolve('drizzle', name), 'utf8'));
      database.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
    })();
  }
  for (const table of original) {
    assert.deepEqual(fingerprint(table.name, table.columns), { rows: table.rows, sha256: table.sha256 }, `Upgrade changed original fields in ${table.name}.`);
  }
  for (const row of recoveryRevisions) {
    const current = database.prepare('SELECT recovery_revision FROM workspaces WHERE id = ?').get(row.id);
    assert.ok(current && current.recovery_revision >= row.recovery_revision, 'Recovery revision must advance monotonically.');
  }
  assert.deepEqual(database.pragma('foreign_key_check'), [], 'Upgrade has broken references.');
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  const report = { verified_at: new Date().toISOString(), applied_migrations: pending, preserved_tables: original, latest_migration: migrations.at(-1) };
  writeFileSync(output + '.verification.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ pending_migrations_applied: pending.length, original_tables_preserved: original.length,
    contacts_preserved: original.find((table) => table.name === 'contacts')?.rows, latest_migration: report.latest_migration,
    integrity: 'ok', foreign_keys: 'ok' }));
} finally {
  database.close();
  chmodSync(output, 0o600);
}
