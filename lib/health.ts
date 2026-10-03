import type Database from 'better-sqlite3';
import type { AuthConfiguration } from './auth.ts';
import { getAutomaticBackupStatus, type AutomaticBackupState } from './automatic-backup.ts';
import { DATABASE_SCHEMA_VERSION, DATABASE_SCHEMA_VERSION_KEY } from './database-schema.ts';

export type ReadinessStatus = 'ok' | 'degraded' | 'unavailable';

export type ReadinessReport = {
  status: ReadinessStatus;
  ready: boolean;
  checks: {
    authentication: AuthConfiguration['mode'];
    database: 'ok';
    schema: 'current' | 'incompatible';
    backup: AutomaticBackupState;
  };
};

export function getReadinessReport(
  db: Database.Database,
  backupDirectory: string,
  authentication: AuthConfiguration
): ReadinessReport {
  const schema = db.prepare('SELECT value FROM app_metadata WHERE key = ?')
    .get(DATABASE_SCHEMA_VERSION_KEY) as { value: string } | undefined;
  const schemaCurrent = schema?.value === DATABASE_SCHEMA_VERSION;
  const backup = getAutomaticBackupStatus(backupDirectory);
  const ready = authentication.mode !== 'misconfigured' && schemaCurrent;
  const backupHealthy = backup.state === 'current' || backup.state === 'disabled';

  return {
    status: !ready ? 'unavailable' : backupHealthy ? 'ok' : 'degraded',
    ready,
    checks: {
      authentication: authentication.mode,
      database: 'ok',
      schema: schemaCurrent ? 'current' : 'incompatible',
      backup: backup.state,
    },
  };
}
