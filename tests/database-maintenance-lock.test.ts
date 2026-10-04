import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DatabaseMaintenanceBusyError,
  getDatabaseMaintenanceLockPath,
  withDatabaseMaintenanceLock,
  withDatabaseMutationLock,
} from '../lib/database-maintenance-lock.ts';

test('maintenance locks are exclusive, cleaned up, and recover stale owners', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-maintenance-lock-'));
  const backupDirectory = join(root, 'backups');
  const lockPath = getDatabaseMaintenanceLockPath(backupDirectory);
  try {
    assert.equal(withDatabaseMaintenanceLock(backupDirectory, () => {
      assert.equal(statSync(lockPath).mode & 0o777, 0o600);
      assert.equal(statSync(root).mode & 0o777, 0o700);
      return 'completed';
    }), 'completed');
    assert.equal(existsSync(lockPath), false);

    mkdirSync(root, { recursive: true });
    writeFileSync(lockPath, 'active');
    const now = new Date('2026-07-11T12:00:00.000Z');
    utimesSync(lockPath, now, now);
    assert.throws(
      () => withDatabaseMaintenanceLock(backupDirectory, () => undefined, {
        now,
        waitMilliseconds: 0,
      }),
      DatabaseMaintenanceBusyError
    );
    assert.equal(existsSync(lockPath), true);

    const stale = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    utimesSync(lockPath, stale, stale);
    assert.equal(withDatabaseMaintenanceLock(backupDirectory, () => 42, {
      now,
      waitMilliseconds: 0,
    }), 42);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(lockPath, { force: true });
  }
});

test('maintenance cleanup never removes a replacement owner lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-maintenance-owner-'));
  const backupDirectory = join(root, 'backups');
  const lockPath = getDatabaseMaintenanceLockPath(backupDirectory);
  try {
    withDatabaseMaintenanceLock(backupDirectory, () => {
      rmSync(lockPath);
      writeFileSync(lockPath, 'replacement-owner\n');
    });

    assert.equal(readFileSync(lockPath, 'utf8'), 'replacement-owner\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(lockPath, { force: true });
  }
});

test('ordinary mutations fail fast while maintenance owns the database boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-mutation-lock-'));
  const backupDirectory = join(root, 'backups');
  try {
    withDatabaseMaintenanceLock(backupDirectory, () => {
      assert.throws(
        () => withDatabaseMutationLock(backupDirectory, () => 'must not run'),
        DatabaseMaintenanceBusyError
      );
    });
    assert.equal(withDatabaseMutationLock(backupDirectory, () => 'saved'), 'saved');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(getDatabaseMaintenanceLockPath(backupDirectory), { force: true });
  }
});

test('ordinary mutations wait for another ordinary writer instead of failing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-mutation-queue-'));
  const backupDirectory = join(root, 'backups');
  const lockPath = getDatabaseMaintenanceLockPath(backupDirectory);
  try {
    writeFileSync(lockPath, 'mutation:external-writer\n');
    const releaser = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { rmSync } from 'node:fs'; setTimeout(() => rmSync(process.argv[1], { force: true }), 150);`,
      lockPath,
    ], { stdio: 'ignore' });
    const startedAt = Date.now();
    assert.equal(withDatabaseMutationLock(backupDirectory, () => 'queued'), 'queued');
    assert(Date.now() - startedAt >= 75);
    await once(releaser, 'exit');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(lockPath, { force: true });
  }
});

test('a writer released between exclusive-open and lock inspection is retried before the next mutation runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-lock-release-race-'));
  const backupDirectory = join(root, 'backups'), lockPath = getDatabaseMaintenanceLockPath(backupDirectory);
  writeFileSync(lockPath, 'mutation:external-writer\n');
  const originalStat = fs.statSync;
  let released = false, calls = 0;
  const inspection = mock.method(fs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
    if (String(args[0]) === lockPath && !released) { released = true; rmSync(lockPath); }
    return originalStat(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(withDatabaseMutationLock(backupDirectory, () => { calls++; return 'saved'; }), 'saved');
    assert.equal(released, true); assert.equal(calls, 1); assert.equal(existsSync(lockPath), false);
  } finally {
    inspection.mock.restore(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true });
  }
});

test('an exclusive file awaiting its owner contents does not get mistaken for maintenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-lock-owner-publication-'));
  const backupDirectory = join(root, 'backups'), lockPath = getDatabaseMaintenanceLockPath(backupDirectory);
  writeFileSync(lockPath, '');
  const releaser = spawn(process.execPath, ['--input-type=module', '--eval',
    `import { writeFileSync, rmSync } from 'node:fs'; setTimeout(() => writeFileSync(process.argv[1], 'mutation:external-writer'), 50); setTimeout(() => rmSync(process.argv[1], { force: true }), 150);`, lockPath], { stdio: 'ignore' });
  try {
    assert.equal(withDatabaseMutationLock(backupDirectory, () => 'saved'), 'saved');
    await once(releaser, 'exit');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(lockPath, { force: true }); }
});
