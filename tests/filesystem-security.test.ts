import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, parse } from 'path';
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  hardenManagedBackupArtifacts,
  hardenSqliteArtifacts,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from '../lib/filesystem-security.ts';

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

test('filesystem privacy helpers remove group and world access', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-filesystem-security-'));
  try {
    const directory = join(root, 'data');
    const databasePath = join(directory, 'relationships.db');
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      writeFileSync(path, 'private', { mode: 0o644 });
      chmodSync(path, 0o644);
    }

    ensurePrivateDirectory(directory);
    hardenSqliteArtifacts(databasePath);
    assert.equal(mode(directory), PRIVATE_DIRECTORY_MODE);
    assert.equal(mode(databasePath), PRIVATE_FILE_MODE);
    assert.equal(mode(`${databasePath}-wal`), PRIVATE_FILE_MODE);
    assert.equal(mode(`${databasePath}-shm`), PRIVATE_FILE_MODE);

    const standaloneFile = join(root, 'standalone.db');
    writeFileSync(standaloneFile, 'private', { mode: 0o644 });
    ensurePrivateFile(standaloneFile);
    assert.equal(mode(standaloneFile), PRIVATE_FILE_MODE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('managed backup hardening leaves unrelated files untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-backup-security-'));
  const backupDirectory = join(root, 'backups');
  try {
    mkdirSync(backupDirectory, { mode: 0o755 });
    chmodSync(backupDirectory, 0o755);
    const backup = join(backupDirectory, 'bonds-manual-2026-07-11-test.db');
    const manifest = `${backup}.json`;
    const unrelated = join(backupDirectory, 'user-owned.txt');
    for (const path of [backup, manifest, unrelated]) {
      writeFileSync(path, 'private', { mode: 0o644 });
      chmodSync(path, 0o644);
    }

    hardenManagedBackupArtifacts(backupDirectory);
    assert.equal(mode(backupDirectory), PRIVATE_DIRECTORY_MODE);
    assert.equal(mode(backup), PRIVATE_FILE_MODE);
    assert.equal(mode(manifest), PRIVATE_FILE_MODE);
    assert.equal(mode(unrelated), 0o644);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('filesystem privacy never changes shared system directories', () => {
  for (const directory of [tmpdir(), parse(process.cwd()).root, process.cwd()]) {
    const originalMode = mode(directory);
    assert.throws(() => ensurePrivateDirectory(directory), /dedicated private subdirectory/i);
    assert.equal(mode(directory), originalMode);
  }
});
