import type Database from 'better-sqlite3';
import { resolve } from 'path';
import { getAutomaticBackupIntervalHours, getBackupRetentionCount } from './database-maintenance-config.ts';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMaintenanceLock,
} from './database-maintenance-lock.ts';
import { createDatabaseBackup, listDatabaseBackups, type BackupMetadata } from './database-maintenance.ts';
import { logError, logInfo, logWarning } from './observability.ts';

export type AutomaticBackupState = 'disabled' | 'current' | 'due' | 'failed';

export type AutomaticBackupStatus = {
  enabled: boolean;
  state: AutomaticBackupState;
  intervalHours: number;
  latestBackupAt: string | null;
  nextBackupAt: string | null;
};

type AutomaticBackupOptions = {
  now?: Date;
  intervalHours?: number;
  retentionCount?: number;
};

const BACKUP_ERROR_LOG_INTERVAL_MILLISECONDS = 5 * 60 * 1000;
const backupErrors = new Map<string, {
  at: number;
  message: string;
  lastLoggedAt: number;
}>();

function recordBackupError(
  directory: string,
  error: unknown,
  now: Date,
  log: () => void
) {
  const message = error instanceof Error ? error.message : 'Automatic backup failed';
  const previous = backupErrors.get(directory);
  const shouldLog = !previous
    || previous.message !== message
    || now.getTime() - previous.lastLoggedAt >= BACKUP_ERROR_LOG_INTERVAL_MILLISECONDS;
  if (shouldLog) log();
  backupErrors.set(directory, {
    at: now.getTime(),
    message,
    lastLoggedAt: shouldLog ? now.getTime() : previous.lastLoggedAt,
  });
}

function getIntervalHours(options?: AutomaticBackupOptions): number {
  return options?.intervalHours ?? getAutomaticBackupIntervalHours();
}

function getLatestAutomaticBackup(backupDirectory: string): BackupMetadata | null {
  return listDatabaseBackups(backupDirectory).find((backup) => backup.reason === 'automatic') || null;
}

export function getAutomaticBackupStatus(
  backupDirectory: string,
  options: AutomaticBackupOptions = {}
): AutomaticBackupStatus {
  const intervalHours = getIntervalHours(options);
  if (intervalHours === 0) {
    return {
      enabled: false,
      state: 'disabled',
      intervalHours,
      latestBackupAt: null,
      nextBackupAt: null,
    };
  }

  const directory = resolve(backupDirectory);
  try {
    const latest = getLatestAutomaticBackup(directory);
    const latestTimestamp = latest ? Date.parse(latest.createdAt) : Number.NaN;
    const nextTimestamp = Number.isFinite(latestTimestamp)
      ? latestTimestamp + intervalHours * 60 * 60 * 1000
      : Number.NaN;
    const error = backupErrors.get(directory);
    if (error && (!Number.isFinite(latestTimestamp) || error.at >= latestTimestamp)) {
      return {
        enabled: true,
        state: 'failed',
        intervalHours,
        latestBackupAt: latest?.createdAt || null,
        nextBackupAt: Number.isFinite(nextTimestamp) ? new Date(nextTimestamp).toISOString() : null,
      };
    }

    return {
      enabled: true,
      state: Number.isFinite(nextTimestamp) && nextTimestamp > (options.now || new Date()).getTime()
        ? 'current'
        : 'due',
      intervalHours,
      latestBackupAt: latest?.createdAt || null,
      nextBackupAt: Number.isFinite(nextTimestamp) ? new Date(nextTimestamp).toISOString() : null,
    };
  } catch (error) {
    const now = options.now || new Date();
    recordBackupError(directory, error, now, () => {
      logError('backup.status_failed', error, undefined, {
        operation: 'automatic_backup_status',
        backup_state: 'failed',
      });
    });
    return {
      enabled: true,
      state: 'failed',
      intervalHours,
      latestBackupAt: null,
      nextBackupAt: null,
    };
  }
}

export function ensureAutomaticDatabaseBackup(
  db: Database.Database,
  backupDirectory: string,
  options: AutomaticBackupOptions = {}
): AutomaticBackupStatus {
  const now = options.now || new Date();
  const initialStatus = getAutomaticBackupStatus(backupDirectory, { ...options, now });
  if (initialStatus.state !== 'due' && initialStatus.state !== 'failed') return initialStatus;

  const directory = resolve(backupDirectory);
  try {
    withDatabaseMaintenanceLock(directory, () => {
      const lockedStatus = getAutomaticBackupStatus(directory, { ...options, now });
      if (lockedStatus.state === 'current') return;

      createDatabaseBackup(db, {
        backupDirectory: directory,
        now,
        reason: 'automatic',
        retentionCount: options.retentionCount ?? getBackupRetentionCount(),
      });
    }, {
      now,
      waitMilliseconds: 0,
    });
    logInfo('backup.automatic_created', {
      operation: 'automatic_backup',
      backup_state: 'current',
    });
    backupErrors.delete(directory);
    return getAutomaticBackupStatus(directory, { ...options, now });
  } catch (error) {
    if (error instanceof DatabaseMaintenanceBusyError) {
      return getAutomaticBackupStatus(directory, { ...options, now });
    }
    recordBackupError(directory, error, now, () => {
      logError('backup.automatic_failed', error, undefined, {
        operation: 'automatic_backup',
        backup_state: 'failed',
      });
    });
    return getAutomaticBackupStatus(directory, { ...options, now });
  }
}

type SchedulerRegistry = Map<string, ReturnType<typeof setInterval>>;

export function startAutomaticBackupScheduler(
  db: Database.Database,
  backupDirectory: string
): AutomaticBackupStatus {
  const intervalHours = getAutomaticBackupIntervalHours();
  const initialStatus = ensureAutomaticDatabaseBackup(db, backupDirectory, { intervalHours });
  if (intervalHours === 0) return initialStatus;

  const globalKey = '__bondsAutomaticBackupSchedulers';
  const globalState = globalThis as typeof globalThis & {
    __bondsAutomaticBackupSchedulers?: SchedulerRegistry;
  };
  const schedulers = globalState[globalKey] || new Map<string, ReturnType<typeof setInterval>>();
  globalState[globalKey] = schedulers;
  const directory = resolve(backupDirectory);
  if (schedulers.has(directory)) return initialStatus;

  const pollMilliseconds = Math.min(
    60 * 60 * 1000,
    Math.max(60 * 1000, Math.floor(intervalHours * 60 * 60 * 1000 / 4))
  );
  const timer = setInterval(() => {
    const status = ensureAutomaticDatabaseBackup(db, directory, { intervalHours });
    if (status.state === 'failed') {
      logWarning('backup.scheduler_unhealthy', {
        operation: 'automatic_backup',
        backup_state: status.state,
      });
    }
  }, pollMilliseconds);
  timer.unref();
  schedulers.set(directory, timer);
  return initialStatus;
}
