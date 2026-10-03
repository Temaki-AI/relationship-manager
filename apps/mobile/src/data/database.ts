import type { SQLiteDatabase } from 'expo-sqlite';

import { MOBILE_SCHEMA_SQL, MOBILE_SCHEMA_VERSION } from './schema';

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
      `This Bonds database uses schema ${currentVersion}, but this app supports ${MOBILE_SCHEMA_VERSION}.`
    );
  }

  if (currentVersion < 1) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(MOBILE_SCHEMA_SQL);
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
    throw new Error('The local Bonds database did not pass its integrity check.');
  }
}
