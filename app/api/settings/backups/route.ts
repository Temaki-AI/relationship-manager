import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { ensureAutomaticDatabaseBackup } from '@/lib/automatic-backup';
import { createDatabaseBackup, listDatabaseBackups } from '@/lib/database-maintenance';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMaintenanceLock,
} from '@/lib/database-maintenance-lock';
import {
  getBackupRetentionCount,
  getMaxRestoreMegabytes,
} from '@/lib/database-maintenance-config';
import { getRequestId, logInfo, logRouteError } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getBackupResponse() {
  const automaticBackup = ensureAutomaticDatabaseBackup(db, backupDirectory);
  return {
    backups: listDatabaseBackups(backupDirectory),
    automaticBackup,
    retentionCount: getBackupRetentionCount(),
    maxRestoreMegabytes: getMaxRestoreMegabytes(),
  };
}

export function GET(request: Request) {
  try {
    return NextResponse.json(getBackupResponse());
  } catch (error) {
    logRouteError('backups.list_failed', error, request, '/api/settings/backups');
    return NextResponse.json({ error: 'Failed to load database backups' }, { status: 500 });
  }
}

export function POST(request: Request) {
  try {
    const backup = withDatabaseMaintenanceLock(backupDirectory, () =>
      createDatabaseBackup(db, {
        backupDirectory,
        reason: 'manual',
        retentionCount: getBackupRetentionCount(),
      }));
    logInfo('backup.manual_created', {
      request_id: getRequestId(request.headers) || undefined,
      operation: 'manual_backup',
      backup_state: 'current',
      status_code: 201,
    });

    return NextResponse.json({ backup, ...getBackupResponse() }, { status: 201 });
  } catch (error) {
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('backups.create_failed', error, request, '/api/settings/backups');
    return NextResponse.json({ error: 'Failed to create a database backup' }, { status: 500 });
  }
}
