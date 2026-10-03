const DEFAULT_BACKUP_RETENTION_COUNT = 20;
const DEFAULT_MAX_RESTORE_MEGABYTES = 256;
const DEFAULT_PRODUCTION_BACKUP_INTERVAL_HOURS = 24;

function parseBoundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export function getBackupRetentionCount(): number {
  return parseBoundedPositiveInteger(
    process.env.CRM_BACKUP_RETENTION_COUNT,
    DEFAULT_BACKUP_RETENTION_COUNT,
    100
  );
}

export function getMaxRestoreMegabytes(): number {
  return parseBoundedPositiveInteger(
    process.env.CRM_MAX_RESTORE_MB,
    DEFAULT_MAX_RESTORE_MEGABYTES,
    2048
  );
}

export function getMaxRestoreBytes(): number {
  return getMaxRestoreMegabytes() * 1024 * 1024;
}

export function getAutomaticBackupIntervalHours(): number {
  const value = process.env.CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS;
  if (value === undefined || value === '') {
    return process.env.NODE_ENV === 'production' ? DEFAULT_PRODUCTION_BACKUP_INTERVAL_HOURS : 0;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return process.env.NODE_ENV === 'production' ? DEFAULT_PRODUCTION_BACKUP_INTERVAL_HOURS : 0;
  }
  return Math.min(parsed, 8_760);
}
