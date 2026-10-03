import { createReadStream, existsSync, statSync } from 'fs';
import { Readable } from 'stream';
import { NextResponse } from 'next/server';
import { backupDirectory } from '@/lib/db';
import {
  deleteDatabaseBackup,
  listDatabaseBackups,
  resolveBackupPath,
  verifyDatabaseBackupChecksum,
} from '@/lib/database-maintenance';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMaintenanceLock,
} from '@/lib/database-maintenance-lock';
import { logRouteError } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ filename: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { filename } = await params;
    const backupPath = resolveBackupPath(backupDirectory, filename);
    const backup = listDatabaseBackups(backupDirectory)
      .find((entry) => entry.filename === filename);
    if (!backup || !existsSync(backupPath)) {
      return NextResponse.json({ error: 'Backup not found' }, { status: 404 });
    }
    verifyDatabaseBackupChecksum(backupPath, backup.sha256);

    const stream = Readable.toWeb(createReadStream(backupPath)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Length': String(statSync(backupPath).size),
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to download backup';
    const status = /not found/i.test(message)
      ? 404
      : /invalid backup filename/i.test(message)
        ? 400
        : /checksum/i.test(message)
          ? 409
          : 500;
    if (status >= 409) {
      logRouteError('backups.download_failed', error, request, '/api/settings/backups/[filename]', status);
    }
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    const { filename } = await params;
    withDatabaseMaintenanceLock(backupDirectory, () => {
      deleteDatabaseBackup(backupDirectory, filename);
    });
    return NextResponse.json({ backups: listDatabaseBackups(backupDirectory) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete backup';
    const status = error instanceof DatabaseMaintenanceBusyError
      ? 409
      : /not found/i.test(message)
        ? 404
        : /invalid backup filename/i.test(message)
          ? 400
          : 500;
    if (status === 500) {
      logRouteError('backups.delete_failed', error, request, '/api/settings/backups/[filename]');
    }
    return NextResponse.json({ error: message }, { status });
  }
}
