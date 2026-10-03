import { closeSync, existsSync, openSync, rmSync, writeSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { NextResponse } from 'next/server';
import db, { backupDirectory, databasePath } from '@/lib/db';
import {
  listDatabaseBackups,
  resolveBackupPath,
  restoreDatabaseBackup,
  verifyDatabaseBackupChecksum,
} from '@/lib/database-maintenance';
import {
  getBackupRetentionCount,
  getMaxRestoreBytes,
} from '@/lib/database-maintenance-config';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { getRequestId, logInfo, logRouteError } from '@/lib/observability';
import {
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from '@/lib/filesystem-security';
import { initializeWorkspaceFoundation } from '@/lib/database-foundation';
import { RESTORABLE_TABLES } from '@/lib/database-schema';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMaintenanceLock,
} from '@/lib/database-maintenance-lock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESTORE_CONFIRMATION = 'RESTORE';
const CLIENT_ERROR_PATTERNS = [
  /type restore/i,
  /no database file/i,
  /file is empty/i,
  /size limit/i,
  /backup filename/i,
  /backup checksum/i,
  /backup schema/i,
  /backup table schema/i,
  /sqlite integrity/i,
  /foreign key check/i,
  /file is not a database/i,
];

function assertRestoreConfirmation(value: unknown) {
  if (value !== RESTORE_CONFIRMATION) {
    throw new Error(`Type ${RESTORE_CONFIRMATION} to confirm database restoration.`);
  }
}

async function writeUploadToDisk(request: Request, targetPath: string): Promise<number> {
  if (!request.body) throw new Error('No database file was provided.');

  const maximumBytes = getMaxRestoreBytes();
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('The database file exceeds the configured restore size limit.');
  }

  const reader = request.body.getReader();
  const descriptor = openSync(targetPath, 'wx', PRIVATE_FILE_MODE);
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        throw new Error('The database file exceeds the configured restore size limit.');
      }

      const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      let offset = 0;
      while (offset < buffer.length) {
        offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
      }
    }
  } finally {
    closeSync(descriptor);
  }

  if (totalBytes === 0) throw new Error('The database file is empty.');
  return totalBytes;
}

function performRestore(candidatePath: string) {
  return withDatabaseMaintenanceLock(backupDirectory, () => {
    const result = restoreDatabaseBackup(db, candidatePath, {
      backupDirectory,
      retentionCount: getBackupRetentionCount(),
    });
    initializeWorkspaceFoundation(db);
    const restoredRowCounts = Object.fromEntries(RESTORABLE_TABLES.map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]));

    return {
      restored: true,
      preRestoreBackup: result.preRestoreBackup,
      restoredRowCounts,
      backups: listDatabaseBackups(backupDirectory),
    };
  });
}

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') || '';

  try {
    if (contentType.includes('application/json')) {
      const body = await readJsonBody<{ confirmation?: unknown; filename?: unknown }>(request);
      assertRestoreConfirmation(body.confirmation);
      if (typeof body.filename !== 'string') throw new Error('Backup filename is required.');

      const backup = listDatabaseBackups(backupDirectory)
        .find((entry) => entry.filename === body.filename);
      if (!backup) throw new Error('Backup not found.');

      const candidatePath = resolveBackupPath(backupDirectory, backup.filename);
      if (!existsSync(candidatePath)) throw new Error('Backup not found.');
      verifyDatabaseBackupChecksum(candidatePath, backup.sha256);
      const result = performRestore(candidatePath);
      logInfo('database.restore_succeeded', {
        request_id: getRequestId(request.headers) || undefined,
        operation: 'managed_restore',
        status_code: 200,
      });
      return NextResponse.json(result);
    }

    assertRestoreConfirmation(request.headers.get('x-bonds-restore-confirmation'));
    const stagingDirectory = join(dirname(databasePath), 'restore-staging');
    const stagingPath = join(stagingDirectory, `${randomUUID()}.db`);
    ensurePrivateDirectory(stagingDirectory);

    try {
      await writeUploadToDisk(request, stagingPath);
      const result = performRestore(stagingPath);
      logInfo('database.restore_succeeded', {
        request_id: getRequestId(request.headers) || undefined,
        operation: 'uploaded_restore',
        status_code: 200,
      });
      return NextResponse.json(result);
    } finally {
      rmSync(stagingPath, { force: true });
    }
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Database restoration failed.';
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (/not found/i.test(message)) {
      return NextResponse.json({ error: 'Backup not found.' }, { status: 404 });
    }
    if (CLIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    logRouteError('database.restore_failed', error, request, '/api/settings/restore');
    return NextResponse.json({ error: 'Database restoration failed.' }, { status: 500 });
  }
}
