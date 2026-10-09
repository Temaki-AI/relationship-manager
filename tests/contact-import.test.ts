import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importVCardContacts } from '../lib/contact-import.ts';
import { parseVCards } from '../lib/vcard.ts';
import { initializeDatabase } from '../lib/database-initialization.ts';

function createDatabase() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  return db;
}

test('vCard import skips database and within-batch duplicates while preserving valid rows', () => {
  const db = createDatabase();
  try {
    db.prepare('INSERT INTO contacts (name, email, phone) VALUES (?, ?, ?)')
      .run('Existing Ada', 'ada@example.test', '+44 20 1111 2222');

    const contacts = parseVCards(`BEGIN:VCARD\nFN:Ada Duplicate\nEMAIL:ADA@example.test\nEND:VCARD\nBEGIN:VCARD\nFN:Grace Hopper\nNICKNAME:Amazing Grace\nEMAIL:grace@example.test\nTEL:+1 555 555 0100\nEND:VCARD\nBEGIN:VCARD\nFN:Grace Again\nEMAIL:GRACE@example.test\nEND:VCARD\nBEGIN:VCARD\nFN:Phone Duplicate\nTEL:+44 (20) 1111-2222\nEND:VCARD\nBEGIN:VCARD\nEMAIL:missing-name@example.test\nEND:VCARD\nBEGIN:VCARD\nFN:Katherine Johnson\nBDAY:1918-08-26\nEND:VCARD`);

    const result = importVCardContacts(db, contacts, '2026-07-10T12:00:00.000Z');
    assert.deepEqual(
      {
        imported: result.imported,
        skippedDuplicates: result.skippedDuplicates,
        skippedInvalid: result.skippedInvalid,
      },
      { imported: 3, skippedDuplicates: 3, skippedInvalid: 0 }
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) as count FROM contacts').get() as { count: number }).count,
      4
    );
    const grace = db.prepare('SELECT custom_fields FROM contacts WHERE email = ?')
      .get('grace@example.test') as { custom_fields: string };
    assert.equal(JSON.parse(grace.custom_fields).import.source, 'vcard');
    assert.equal(
      db.prepare('SELECT nickname FROM contacts WHERE email = ?').pluck().get('grace@example.test'),
      'Amazing Grace'
    );
    assert.equal(
      db.prepare('SELECT name FROM contacts WHERE email = ?').pluck().get('missing-name@example.test'),
      'missing-name@example.test'
    );
  } finally {
    db.close();
  }
});

test('name and birthday deduplicate contacts without email or phone', () => {
  const db = createDatabase();
  try {
    db.prepare('INSERT INTO contacts (name, birthday) VALUES (?, ?)')
      .run('Katherine Johnson', '1918-08-26');
    const contacts = parseVCards('BEGIN:VCARD\nFN:Katherine Johnson\nBDAY:19180826\nEND:VCARD');
    const result = importVCardContacts(db, contacts);
    assert.equal(result.skippedDuplicates, 1);
    assert.equal(result.imported, 0);
  } finally {
    db.close();
  }
});

test('secondary vCard addresses participate in duplicate prevention', () => {
  const db = createDatabase();
  try {
    db.prepare('INSERT INTO contacts (name, email, custom_fields) VALUES (?, ?, ?)')
      .run(
        'Existing Grace',
        'primary@example.test',
        JSON.stringify({ vcard: { additional_emails: ['grace@example.test'] } })
      );
    const contacts = parseVCards('BEGIN:VCARD\nFN:Grace Duplicate\nEMAIL:GRACE@example.test\nEND:VCARD');
    const result = importVCardContacts(db, contacts);
    assert.equal(result.skippedDuplicates, 1);
    assert.equal(result.imported, 0);
  } finally {
    db.close();
  }
});

test('concurrent import processes serialize duplicate checks and create one contact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-concurrent-import-'));
  const databasePath = join(root, 'contacts.db');
  const setup = new Database(databasePath);
  initializeDatabase(setup);
  setup.close();

  const childScript = `
    import Database from 'better-sqlite3';
    import { importVCardContacts } from './lib/contact-import.ts';
    import { parseVCards } from './lib/vcard.ts';
    const db = new Database(process.argv[1]);
    db.pragma('busy_timeout = 10000');
    try {
      importVCardContacts(db, parseVCards('BEGIN:VCARD\\nFN:Concurrent Ada\\nEMAIL:concurrent@example.test\\nEND:VCARD'));
    } finally {
      db.close();
    }
  `;

  try {
    await Promise.all(Array.from({ length: 8 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        childScript,
        databasePath,
      ], {
        cwd: process.cwd(),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `Importer exited with code ${code}`));
      });
    })));

    const verification = new Database(databasePath, { readonly: true });
    try {
      assert.equal(
        (verification.prepare('SELECT COUNT(*) AS count FROM contacts').get() as { count: number }).count,
        1
      );
    } finally {
      verification.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
