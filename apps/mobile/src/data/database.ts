import type { SQLiteDatabase } from 'expo-sqlite';

import { MOBILE_SCHEMA_SQL, MOBILE_SCHEMA_VERSION, MOBILE_SYNC_MIGRATION_SQL, MOBILE_ENTITY_SYNC_MIGRATION_SQL, MOBILE_CONTEXT_SYNC_MIGRATION_SQL, MOBILE_CONTACT_ALIAS_MIGRATION_SQL, MOBILE_CONTACT_METHODS_MIGRATION_SQL, MOBILE_CONTACT_SOURCES_MIGRATION_SQL, MOBILE_PROVIDER_SOURCES_MIGRATION_SQL, MOBILE_DEVICE_CONTACT_REVIEW_MIGRATION_SQL, MOBILE_DEVICE_SOURCE_SYNC_MIGRATION_SQL, MOBILE_DEVICE_CONTACT_POLICY_MIGRATION_SQL, MOBILE_CALENDAR_CONTEXT_MIGRATION_SQL, MOBILE_CALENDAR_LINKS_MIGRATION_SQL, MOBILE_APPLE_CALENDAR_MIGRATION_SQL, MOBILE_GMAIL_CONTEXT_MIGRATION_SQL, MOBILE_TODAY_SNOOZES_MIGRATION_SQL, MOBILE_CALENDAR_RESERVATION_MIGRATION_SQL } from './schema';

type UserVersionRow = { user_version: number };

export async function migrateDatabase(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
  `);

  const versionRow = await db.getFirstAsync<UserVersionRow>('PRAGMA user_version');
  const currentVersion = versionRow?.user_version ?? 0;
  if (currentVersion > MOBILE_SCHEMA_VERSION) {
    throw new Error(
      `This Everclose database uses schema ${currentVersion}, but this app supports ${MOBILE_SCHEMA_VERSION}.`
    );
  }

  if (currentVersion < MOBILE_SCHEMA_VERSION) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      if (currentVersion < 1) await transaction.execAsync(MOBILE_SCHEMA_SQL);
      if (currentVersion < 2) await transaction.execAsync(MOBILE_SYNC_MIGRATION_SQL);
      if (currentVersion < 3) await transaction.execAsync(MOBILE_ENTITY_SYNC_MIGRATION_SQL);
      if (currentVersion < 4) await transaction.execAsync(MOBILE_CONTEXT_SYNC_MIGRATION_SQL);
      if (currentVersion < 5) await transaction.execAsync(MOBILE_CONTACT_ALIAS_MIGRATION_SQL);
      if (currentVersion < 6) {
        await transaction.execAsync(MOBILE_CONTACT_METHODS_MIGRATION_SQL);
        // The server backfilled methods without replaying its old journal. Pull
        // a complete current collection before resuming incremental downloads.
        await transaction.runAsync("DELETE FROM app_metadata WHERE key = 'sync-cursor-v3'");
      }
      if (currentVersion < 7) {
        await transaction.execAsync(MOBILE_CONTACT_SOURCES_MIGRATION_SQL);
        await transaction.runAsync("DELETE FROM app_metadata WHERE key = 'sync-cursor-v3'");
      }
      if (currentVersion < 8) {
        await transaction.execAsync(MOBILE_PROVIDER_SOURCES_MIGRATION_SQL);
        await transaction.runAsync("DELETE FROM app_metadata WHERE key = 'sync-cursor-v3'");
      }
      if (currentVersion < 9) await transaction.execAsync(MOBILE_DEVICE_CONTACT_REVIEW_MIGRATION_SQL);
      if (currentVersion < 10) {
        await transaction.execAsync(MOBILE_DEVICE_SOURCE_SYNC_MIGRATION_SQL);
        await transaction.runAsync("DELETE FROM app_metadata WHERE key = 'sync-cursor-v3'");
      }
      if (currentVersion < 11) await transaction.execAsync(MOBILE_DEVICE_CONTACT_POLICY_MIGRATION_SQL);
      if (currentVersion < 12) {
        await transaction.execAsync(MOBILE_CALENDAR_CONTEXT_MIGRATION_SQL);
        // A v3 cursor skipped event history; only a complete v4 bootstrap can seed the cache.
        await transaction.runAsync("DELETE FROM app_metadata WHERE key = 'sync-cursor-v4'");
      }
      if (currentVersion < 13) await transaction.execAsync(MOBILE_CALENDAR_LINKS_MIGRATION_SQL);
      if (currentVersion < 14) await transaction.execAsync(MOBILE_APPLE_CALENDAR_MIGRATION_SQL);
      if (currentVersion < 15) await transaction.execAsync(MOBILE_GMAIL_CONTEXT_MIGRATION_SQL);
      if (currentVersion < 16) await transaction.execAsync(MOBILE_TODAY_SNOOZES_MIGRATION_SQL);
      if (currentVersion < 17) await transaction.execAsync(MOBILE_CALENDAR_RESERVATION_MIGRATION_SQL);
      await transaction.execAsync(`PRAGMA user_version = ${MOBILE_SCHEMA_VERSION}`);
      await transaction.runAsync(
        `INSERT OR REPLACE INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)`,
        'schema-version',
        String(MOBILE_SCHEMA_VERSION),
        new Date().toISOString()
      );
    });
  }

  const quickCheck = await db.getFirstAsync<Record<string, string>>('PRAGMA quick_check');
  if (!quickCheck || Object.values(quickCheck)[0] !== 'ok') {
    throw new Error('The local Everclose database did not pass its integrity check.');
  }
}

export async function bindDatabaseAccount(db: SQLiteDatabase, scope: string): Promise<void> {
  const existing = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'account-scope'");
  if (existing && existing.value !== scope) throw new Error('This local database belongs to another account.');
  await db.runAsync("INSERT OR IGNORE INTO app_metadata (key, value, updated_at) VALUES ('account-scope', ?, ?)", scope, new Date().toISOString());
  const owner = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'account-scope'");
  if (owner?.value !== scope) throw new Error('This local database belongs to another account.');
}
