import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join, resolve } from 'path';
import {
  DATABASE_SCHEMA_VERSION,
  DATABASE_SCHEMA_VERSION_KEY,
  DELETE_TABLE_ORDER,
  RESTORABLE_TABLES,
} from './database-schema.ts';
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  PRIVATE_FILE_MODE,
} from './filesystem-security.ts';

export type BackupReason = 'manual' | 'automatic' | 'pre-restore' | 'pre-merge' | 'pre-delete';

export type BackupMetadata = {
  filename: string;
  createdAt: string;
  reason: BackupReason;
  schemaVersion: string;
  sizeBytes: number;
  sha256: string;
  rowCounts: Record<string, number>;
};

export type BackupOptions = {
  backupDirectory: string;
  now?: Date;
  reason?: BackupReason;
  retentionCount?: number;
  prune?: boolean;
};

export type RestoreResult = {
  preRestoreBackup: BackupMetadata;
  restoredRowCounts: Record<string, number>;
};

const BACKUP_FILENAME_PATTERN = /^bonds-(manual|automatic|pre-restore|pre-merge|pre-delete)-[A-Za-z0-9-]+\.db$/;
const DEFAULT_RETENTION_COUNT = 20;
const BACKUP_REASON_RETENTION_PRIORITY: BackupReason[] = [
  'manual',
  'automatic',
  'pre-restore',
  'pre-merge',
  'pre-delete',
];

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function getSchemaVersion(db: Database.Database): string | null {
  const row = db.prepare('SELECT value FROM app_metadata WHERE key = ?')
    .get(DATABASE_SCHEMA_VERSION_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

function getTableSignature(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  return rows.map((row) => [
    row.name,
    row.type,
    row.notnull,
    row.dflt_value ?? '',
    row.pk,
  ].join(':'));
}

function getRowCounts(db: Database.Database): Record<string, number> {
  return Object.fromEntries(RESTORABLE_TABLES.map((table) => {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${quoteIdentifier(table)}`)
      .get() as { count: number };
    return [table, row.count];
  }));
}

function assertDatabaseIntegrity(db: Database.Database) {
  const integrity = db.pragma('integrity_check', { simple: true }) as string;
  if (integrity !== 'ok') {
    throw new Error(`SQLite integrity check failed: ${integrity}`);
  }

  const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
  if (foreignKeyViolations.length > 0) {
    throw new Error('SQLite foreign key check failed.');
  }
}

export function validateDatabaseFile(
  activeDb: Database.Database,
  candidatePath: string
): { rowCounts: Record<string, number>; schemaVersion: string } {
  const candidate = new Database(candidatePath, { readonly: true, fileMustExist: true });

  try {
    candidate.pragma('foreign_keys = ON');
    assertDatabaseIntegrity(candidate);

    const activeVersion = getSchemaVersion(activeDb);
    const candidateVersion = getSchemaVersion(candidate);
    if (!activeVersion || candidateVersion !== activeVersion || candidateVersion !== DATABASE_SCHEMA_VERSION) {
      throw new Error('Backup schema version is not compatible with this version of Everclose CRM.');
    }

    for (const table of RESTORABLE_TABLES) {
      const activeSignature = getTableSignature(activeDb, table);
      const candidateSignature = getTableSignature(candidate, table);
      if (activeSignature.length === 0 || activeSignature.join('|') !== candidateSignature.join('|')) {
        throw new Error(`Backup table schema does not match for ${table}.`);
      }
    }

    return {
      rowCounts: getRowCounts(candidate),
      schemaVersion: candidateVersion,
    };
  } finally {
    candidate.close();
  }
}

function hashFile(filename: string): string {
  const hash = createHash('sha256');
  const descriptor = openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);

  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }

  return hash.digest('hex');
}

export function verifyDatabaseBackupChecksum(filename: string, expectedSha256: string) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256) || hashFile(filename) !== expectedSha256.toLowerCase()) {
    throw new Error('Backup checksum does not match its integrity manifest.');
  }
}

function normalizeRetentionCount(value: number | undefined): number {
  if (!Number.isInteger(value) || !value || value < 1) return DEFAULT_RETENTION_COUNT;
  return Math.min(value, 100);
}

function createBackupFilename(reason: BackupReason, now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return `bonds-${reason}-${timestamp}-${randomUUID().slice(0, 8)}.db`;
}

function manifestPath(backupDirectory: string, filename: string): string {
  return join(backupDirectory, `${filename}.json`);
}

function writeManifest(backupDirectory: string, metadata: BackupMetadata) {
  const finalPath = manifestPath(backupDirectory, metadata.filename);
  const temporaryPath = `${finalPath}.partial`;
  writeFileSync(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
    flag: 'wx',
    mode: PRIVATE_FILE_MODE,
  });
  ensurePrivateFile(temporaryPath);
  renameSync(temporaryPath, finalPath);
}

export function resolveBackupPath(backupDirectory: string, filename: string): string {
  if (!BACKUP_FILENAME_PATTERN.test(filename) || basename(filename) !== filename) {
    throw new Error('Invalid backup filename.');
  }

  const directory = resolve(backupDirectory);
  const candidate = resolve(directory, filename);
  if (dirname(candidate) !== directory) throw new Error('Invalid backup filename.');
  return candidate;
}

export function listDatabaseBackups(backupDirectory: string): BackupMetadata[] {
  if (!existsSync(backupDirectory)) return [];

  return readdirSync(backupDirectory)
    .filter((filename) => BACKUP_FILENAME_PATTERN.test(filename))
    .flatMap((filename) => {
      const backupPath = resolveBackupPath(backupDirectory, filename);
      const metadataPath = manifestPath(backupDirectory, filename);
      if (!existsSync(backupPath) || !existsSync(metadataPath)) return [];

      try {
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as BackupMetadata;
        return metadata.filename === filename ? [metadata] : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function pruneDatabaseBackups(backupDirectory: string, retentionCount?: number) {
  const backups = listDatabaseBackups(backupDirectory);
  const keep = normalizeRetentionCount(retentionCount);
  const retained = new Set<string>();

  for (const reason of BACKUP_REASON_RETENTION_PRIORITY) {
    if (retained.size >= keep) break;
    const newestForReason = backups.find((backup) => backup.reason === reason);
    if (newestForReason) retained.add(newestForReason.filename);
  }

  for (const backup of backups) {
    if (retained.size >= keep) break;
    retained.add(backup.filename);
  }

  for (const backup of backups) {
    if (retained.has(backup.filename)) continue;
    rmSync(resolveBackupPath(backupDirectory, backup.filename), { force: true });
    rmSync(manifestPath(backupDirectory, backup.filename), { force: true });
  }
}

export function createDatabaseBackup(
  db: Database.Database,
  options: BackupOptions
): BackupMetadata {
  const reason = options.reason ?? 'manual';
  const now = options.now ?? new Date();
  ensurePrivateDirectory(options.backupDirectory);

  const filename = createBackupFilename(reason, now);
  const finalPath = resolveBackupPath(options.backupDirectory, filename);
  const temporaryPath = `${finalPath}.partial`;
  let manifestWritten = false;

  try {
    db.prepare('VACUUM INTO ?').run(temporaryPath);
    ensurePrivateFile(temporaryPath);
    const validation = validateDatabaseFile(db, temporaryPath);
    renameSync(temporaryPath, finalPath);

    const metadata: BackupMetadata = {
      filename,
      createdAt: now.toISOString(),
      reason,
      schemaVersion: validation.schemaVersion,
      sizeBytes: statSync(finalPath).size,
      sha256: hashFile(finalPath),
      rowCounts: validation.rowCounts,
    };

    writeManifest(options.backupDirectory, metadata);
    manifestWritten = true;
    if (options.prune !== false) {
      pruneDatabaseBackups(options.backupDirectory, options.retentionCount);
    }
    return metadata;
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    if (!manifestWritten) {
      rmSync(finalPath, { force: true });
      rmSync(manifestPath(options.backupDirectory, filename), { force: true });
      rmSync(`${manifestPath(options.backupDirectory, filename)}.partial`, { force: true });
    }
    throw error;
  }
}

export function deleteDatabaseBackup(backupDirectory: string, filename: string) {
  const backupPath = resolveBackupPath(backupDirectory, filename);
  if (!existsSync(backupPath)) throw new Error('Backup not found.');
  rmSync(backupPath);
  rmSync(manifestPath(backupDirectory, filename), { force: true });
}

const MANAGED_BACKUP_ARTIFACT_PATTERN =
  /^bonds-(manual|automatic|pre-restore|pre-merge|pre-delete)-[A-Za-z0-9-]+\.db(?:\.json)?(?:\.partial)?$/;

export function deleteManagedDatabaseBackupArtifacts(backupDirectory: string): number {
  if (!existsSync(backupDirectory)) return 0;

  let removed = 0;
  for (const filename of readdirSync(backupDirectory)) {
    if (filename !== '.automatic-backup.lock' && !MANAGED_BACKUP_ARTIFACT_PATTERN.test(filename)) {
      continue;
    }
    rmSync(join(backupDirectory, filename), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

export function restoreDatabaseBackup(
  db: Database.Database,
  candidatePath: string,
  options: Omit<BackupOptions, 'reason'>
): RestoreResult {
  const validation = validateDatabaseFile(db, candidatePath);
  const preRestoreBackup = createDatabaseBackup(db, {
    ...options,
    reason: 'pre-restore',
    prune: false,
  });

  db.prepare('ATTACH DATABASE ? AS restore_source').run(candidatePath);

  try {
    const restore = db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');

      for (const table of DELETE_TABLE_ORDER) {
        db.prepare(`DELETE FROM main.${quoteIdentifier(table)}`).run();
      }

      for (const table of RESTORABLE_TABLES) {
        db.prepare(
          `INSERT INTO main.${quoteIdentifier(table)} SELECT * FROM restore_source.${quoteIdentifier(table)}`
        ).run();
      }

      assertDatabaseIntegrity(db);
    });

    restore();
  } finally {
    db.prepare('DETACH DATABASE restore_source').run();
  }

  assertDatabaseIntegrity(db);
  pruneDatabaseBackups(options.backupDirectory, options.retentionCount);

  return {
    preRestoreBackup,
    restoredRowCounts: validation.rowCounts,
  };
}
