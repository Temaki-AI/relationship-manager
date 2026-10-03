import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import {
  ContactMergeError,
  mergeContacts,
  validateContactMerge,
} from '@/lib/contact-merge';
import { loadDuplicateReview } from '@/lib/duplicate-directory';
import { createDatabaseBackup } from '@/lib/database-maintenance';
import { getBackupRetentionCount } from '@/lib/database-maintenance-config';
import { parsePositiveInteger } from '@/lib/relationship-validation';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { getRequestId, logInfo, logRouteError } from '@/lib/observability';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMaintenanceLock,
} from '@/lib/database-maintenance-lock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    return NextResponse.json(loadDuplicateReview(db, {
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
    }));
  } catch (error) {
    logRouteError('duplicates.load_failed', error, request, '/api/contacts/duplicates');
    return NextResponse.json({ error: 'Failed to review duplicate contacts' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ContactMergeError('Merge details must be an object.');
    }

    const value = body as Record<string, unknown>;
    const primaryId = parsePositiveInteger(value.primaryId);
    const rawDuplicateIds = Array.isArray(value.duplicateIds) ? value.duplicateIds : [];
    const duplicateIds = rawDuplicateIds
      .map(parsePositiveInteger)
      .filter((id): id is number => id !== null);
    if (!primaryId || duplicateIds.length !== rawDuplicateIds.length) {
      throw new ContactMergeError('Choose a valid primary contact and duplicate contacts.');
    }

    const { recoveryPoint, result } = withDatabaseMaintenanceLock(backupDirectory, () => {
      validateContactMerge(db, primaryId, duplicateIds);
      const recoveryPoint = createDatabaseBackup(db, {
        backupDirectory,
        reason: 'pre-merge',
        retentionCount: getBackupRetentionCount(),
      });
      return {
        recoveryPoint,
        result: mergeContacts(db, primaryId, duplicateIds),
      };
    });
    logInfo('duplicates.merge_succeeded', {
      request_id: getRequestId(request.headers) || undefined,
      operation: 'duplicate_merge',
      status_code: 200,
    });

    return NextResponse.json({
      ...result,
      recoveryPoint: {
        filename: recoveryPoint.filename,
        createdAt: recoveryPoint.createdAt,
      },
      remaining: loadDuplicateReview(db),
    });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ContactMergeError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.code === 'not_found' ? 404 : 400 }
      );
    }
    logRouteError('duplicates.merge_failed', error, request, '/api/contacts/duplicates');
    return NextResponse.json({ error: 'Failed to merge duplicate contacts' }, { status: 500 });
  }
}
