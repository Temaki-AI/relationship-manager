import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decryptPortableBackup,
  encryptPortableBackup,
  getPortableBackupFilename,
  isPortableBackup,
  PORTABLE_BACKUP_OVERHEAD_BYTES,
  PORTABLE_BACKUP_PBKDF2_ITERATIONS,
  PortableBackupError,
} from '../lib/portable-backup.ts';

const passphrase = 'correct horse battery staple';
const testIterations = 100_000;

test('portable backups round-trip with authenticated randomized encryption', async () => {
  const plaintext = new TextEncoder().encode('SQLite format 3\0private relationship data');
  const first = await encryptPortableBackup(plaintext, passphrase, { iterations: testIterations });
  const second = await encryptPortableBackup(plaintext, passphrase, { iterations: testIterations });

  assert.equal(PORTABLE_BACKUP_PBKDF2_ITERATIONS, 600_000);
  assert.equal(isPortableBackup(first), true);
  assert.equal(first.byteLength, plaintext.byteLength + PORTABLE_BACKUP_OVERHEAD_BYTES);
  assert.notDeepEqual(first, plaintext);
  assert.notDeepEqual(first, second);
  assert.deepEqual(await decryptPortableBackup(first, passphrase), plaintext);
});

test('portable backups reject wrong passphrases and authenticated-data tampering', async () => {
  const encrypted = await encryptPortableBackup(
    new TextEncoder().encode('private database'),
    passphrase,
    { iterations: testIterations }
  );

  await assert.rejects(
    decryptPortableBackup(encrypted, 'this passphrase is wrong'),
    (error: unknown) => error instanceof PortableBackupError
      && error.message === 'The passphrase is incorrect or the encrypted backup is damaged.'
  );

  encrypted[encrypted.length - 1] ^= 1;
  await assert.rejects(
    decryptPortableBackup(encrypted, passphrase),
    (error: unknown) => error instanceof PortableBackupError
      && error.message === 'The passphrase is incorrect or the encrypted backup is damaged.'
  );
});

test('portable backup validation rejects unsafe inputs and sanitizes download names', async () => {
  assert.equal(isPortableBackup(new Uint8Array([1, 2, 3])), false);
  await assert.rejects(
    encryptPortableBackup(new Uint8Array(), passphrase),
    /backup file is empty/i
  );
  await assert.rejects(
    encryptPortableBackup(new Uint8Array([1]), 'too short'),
    /at least 12 characters/i
  );
  await assert.rejects(
    decryptPortableBackup(new Uint8Array(100), passphrase),
    /not a supported encrypted Everclose CRM backup/i
  );
  assert.equal(
    getPortableBackupFilename('../../private contacts.db'),
    'private-contacts.bonds'
  );
  assert.equal(getPortableBackupFilename('...'), 'bonds-backup.bonds');
});
