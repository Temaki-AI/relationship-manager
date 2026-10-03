import type Database from 'better-sqlite3';
import { rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import {
  DATABASE_SCHEMA_VERSION,
  DATABASE_SCHEMA_VERSION_KEY,
  DELETE_TABLE_ORDER,
} from './database-schema.ts';
import { withDatabaseBusyRetry } from './database-initialization.ts';
import { withDatabaseMaintenanceLock } from './database-maintenance-lock.ts';
import {
  deleteManagedDatabaseBackupArtifacts,
  listDatabaseBackups,
} from './database-maintenance.ts';
import { DEMO_SEED_KEY } from './demo-data.ts';

export type WorkspaceErasureResult = {
  erased: true;
  deletedRows: Record<string, number>;
  deletedBackups: number;
  deletedBackupArtifacts: number;
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function assertDatabaseHealthy(db: Database.Database) {
  const integrity = db.pragma('integrity_check', { simple: true }) as string;
  if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
  if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
    throw new Error('SQLite foreign key check failed.');
  }
}

export function eraseWorkspaceData(
  db: Database.Database,
  options: { backupDirectory: string; databasePath: string }
): WorkspaceErasureResult {
  return withDatabaseMaintenanceLock(options.backupDirectory, () => {
    const deletedBackups = listDatabaseBackups(options.backupDirectory).length;
    const deletedRows: Record<string, number> = {};

    db.pragma('secure_delete = ON');
    const erase = db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');
      for (const table of DELETE_TABLE_ORDER) {
        deletedRows[table] = db
          .prepare(`DELETE FROM ${quoteIdentifier(table)}`)
          .run().changes;
      }

      db.prepare('DELETE FROM sqlite_sequence').run();
      db.prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)')
        .run(DATABASE_SCHEMA_VERSION_KEY, DATABASE_SCHEMA_VERSION);
      db.prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)')
        .run(DEMO_SEED_KEY, 'erased');
      db.prepare('INSERT INTO workspaces (name, plan, persona) VALUES (?, ?, ?)')
        .run('My Everclose CRM', 'local', 'private-first');
      assertDatabaseHealthy(db);
    });

    withDatabaseBusyRetry(() => erase.immediate());
    withDatabaseBusyRetry(() => db.pragma('wal_checkpoint(TRUNCATE)'));
    withDatabaseBusyRetry(() => db.exec('VACUUM'));
    withDatabaseBusyRetry(() => db.pragma('wal_checkpoint(TRUNCATE)'));
    assertDatabaseHealthy(db);

    const deletedBackupArtifacts = deleteManagedDatabaseBackupArtifacts(
      options.backupDirectory
    );
    rmSync(join(dirname(resolve(options.databasePath)), 'restore-staging'), {
      recursive: true,
      force: true,
    });

    return {
      erased: true,
      deletedRows,
      deletedBackups,
      deletedBackupArtifacts,
    };
  });
}
