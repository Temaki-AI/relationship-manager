import { randomUUID } from 'crypto';
import {
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, resolve } from 'path';
import {
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from './filesystem-security.ts';

const LOCK_STALE_MILLISECONDS = 60 * 60 * 1000;
const DEFAULT_WAIT_MILLISECONDS = 10_000;
const RETRY_MILLISECONDS = 50;
type DatabaseLockKind = 'maintenance' | 'mutation';

export class DatabaseMaintenanceBusyError extends Error {
  constructor() {
    super('Another database maintenance operation is already running.');
    this.name = 'DatabaseMaintenanceBusyError';
  }
}

export function getDatabaseMaintenanceLockPath(backupDirectory: string): string {
  return `${resolve(backupDirectory)}.maintenance.lock`;
}

function wait(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function openOwnedLock(lockPath: string, owner: string): number {
  const descriptor = openSync(lockPath, 'wx', PRIVATE_FILE_MODE);
  try {
    writeFileSync(descriptor, owner);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
    throw error;
  }
}

function tryOpenLock(lockPath: string, now: Date, owner: string): number | null {
  try {
    return openOwnedLock(lockPath, owner);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
      throw error;
    }

    try {
      if (now.getTime() - statSync(lockPath).mtimeMs <= LOCK_STALE_MILLISECONDS) return null;
      rmSync(lockPath, { force: true });
      return openOwnedLock(lockPath, owner);
    } catch (lockError) {
      if (
        lockError
        && typeof lockError === 'object'
        && 'code' in lockError
        && (lockError.code === 'EEXIST' || lockError.code === 'ENOENT')
      ) {
        return null;
      }
      throw lockError;
    }
  }
}

function getExistingLockKind(lockPath: string): DatabaseLockKind | null {
  try {
    const owner = readFileSync(lockPath, 'utf8');
    if (!owner) return null; // An exclusive file may precede its owner's write.
    if (owner.startsWith('mutation:')) return 'mutation';
    return 'maintenance';
  } catch {
    return null;
  }
}

function withDatabaseLock<T>(
  backupDirectory: string,
  kind: DatabaseLockKind,
  operation: () => T,
  options: { now?: Date; waitMilliseconds?: number } = {}
): T {
  const lockPath = getDatabaseMaintenanceLockPath(backupDirectory);
  const waitMilliseconds = Math.max(0, options.waitMilliseconds ?? DEFAULT_WAIT_MILLISECONDS);
  const deadline = Date.now() + waitMilliseconds;
  const owner = `${kind}:${process.pid}:${randomUUID()}\n`;
  ensurePrivateDirectory(dirname(lockPath));

  let descriptor: number | null = null;
  do {
    descriptor = tryOpenLock(lockPath, options.now ?? new Date(), owner);
    if (descriptor !== null) break;
    if (kind === 'mutation' && getExistingLockKind(lockPath) === 'maintenance') {
      throw new DatabaseMaintenanceBusyError();
    }
    if (Date.now() >= deadline) throw new DatabaseMaintenanceBusyError();
    wait(Math.min(RETRY_MILLISECONDS, Math.max(1, deadline - Date.now())));
  } while (true);

  try {
    return operation();
  } finally {
    closeSync(descriptor);
    try {
      if (readFileSync(lockPath, 'utf8') === owner) rmSync(lockPath, { force: true });
    } catch {
      // A replacement owner or external cleanup is responsible for the current lock.
    }
  }
}

export function withDatabaseMaintenanceLock<T>(
  backupDirectory: string,
  operation: () => T,
  options: { now?: Date; waitMilliseconds?: number } = {}
): T {
  return withDatabaseLock(backupDirectory, 'maintenance', operation, options);
}

export function withDatabaseMutationLock<T>(
  backupDirectory: string,
  operation: () => T
): T {
  return withDatabaseLock(backupDirectory, 'mutation', operation);
}
