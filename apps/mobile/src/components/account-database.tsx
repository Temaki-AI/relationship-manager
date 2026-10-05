import { SQLiteProvider, type SQLiteDatabase } from 'expo-sqlite';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform } from 'react-native';

import { bindDatabaseAccount, migrateDatabase } from '@/data/database';
import { accountDatabaseName, useNativeAccount } from '@/native/account';
import { accountScope } from '../../../../packages/domain/src/devices';
import { deviceContactInstallation } from '@/native/device-installation';
import { bindDeviceInstallation } from '@/data/device-source-sync';
import { palette } from '@/theme';
import { StartupBoundary, StartupRecovery } from './startup-recovery';

export function AccountDatabase({ children }: { children: ReactNode }) {
  const { account, loading, startupError, reload } = useNativeAccount();
  const [database, setDatabase] = useState<{ scope: string; name: string } | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scope = accountScope(account);
  const initializeDatabase = useCallback(async (db: SQLiteDatabase) => {
    try {
      await migrateDatabase(db);
      await bindDatabaseAccount(db, scope);
      if (Platform.OS !== 'web') await bindDeviceInstallation(db, await deviceContactInstallation());
    } catch (error) {
      // SQLiteProvider cannot retain a database that fails onInit. Release its
      // handle before retrying; the database file and queued edits remain intact.
      await db.closeAsync().catch(() => {});
      throw error;
    }
  }, [scope]);
  useEffect(() => {
    let active = true;
    if (!loading && !startupError) {
      void accountDatabaseName(account).then((name) => {
        if (active) { setSelectionError(null); setDatabase({ scope, name }); }
      }, () => { if (active) setSelectionError(scope); });
    }
    return () => { active = false; };
  }, [account, loading, startupError, scope, attempt]);

  if (startupError) return <StartupRecovery message={startupError} retryLabel="Try unlocking again" onRetry={() => { void reload(); }} />;
  if (selectionError === scope) return <StartupRecovery onRetry={() => { setSelectionError(null); setAttempt((value) => value + 1); }} />;
  if (loading || database?.scope !== scope) return <ActivityIndicator color={palette.primary} />;
  return <StartupBoundary key={scope}>
    <SQLiteProvider databaseName={database.name} onInit={initializeDatabase}>{children}</SQLiteProvider>
  </StartupBoundary>;
}
