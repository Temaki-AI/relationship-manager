import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join, parse, resolve } from 'path';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const MANAGED_BACKUP_ARTIFACT_PATTERN =
  /^bonds-(manual|automatic|pre-restore|pre-merge|pre-delete)-[A-Za-z0-9-]+\.db(?:\.json)?(?:\.partial)?$/;

function assertDedicatedPrivateDirectory(directory: string): void {
  const resolved = resolve(directory);
  const protectedDirectories = new Set([
    parse(resolved).root,
    resolve(tmpdir()),
    resolve(homedir()),
    resolve(dirname(homedir())),
    resolve(process.cwd()),
    '/bin',
    '/etc',
    '/opt',
    '/sbin',
    '/usr',
    '/var',
  ]);
  if (protectedDirectories.has(resolved)) {
    throw new Error(`CRM data must use a dedicated private subdirectory, not ${resolved}.`);
  }
}

export function ensurePrivateDirectory(directory: string): void {
  assertDedicatedPrivateDirectory(directory);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateFile(filename: string): void {
  try {
    chmodSync(filename, PRIVATE_FILE_MODE);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

export function hardenSqliteArtifacts(databasePath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    ensurePrivateFile(`${databasePath}${suffix}`);
  }
}

export function hardenManagedBackupArtifacts(backupDirectory: string): void {
  ensurePrivateDirectory(backupDirectory);
  for (const filename of readdirSync(backupDirectory)) {
    if (filename !== '.automatic-backup.lock' && !MANAGED_BACKUP_ARTIFACT_PATTERN.test(filename)) {
      continue;
    }
    const path = join(backupDirectory, filename);
    if (lstatSync(path).isFile()) ensurePrivateFile(path);
  }
}
