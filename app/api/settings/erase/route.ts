import { NextResponse } from 'next/server';
import db, { backupDirectory, databasePath } from '@/lib/db';
import { DatabaseMaintenanceBusyError } from '@/lib/database-maintenance-lock';
import { getRequestId, logInfo, logRouteError } from '@/lib/observability';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { eraseWorkspaceData } from '@/lib/workspace-erasure';
import { WORKSPACE_ERASURE_CONFIRMATION } from '@/lib/workspace-erasure-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{ confirmation?: unknown }>(request, {
      maximumBytes: 1024,
      sizeLimitMessage: 'Erasure confirmation exceeds the 1 KB limit.',
    });
    if (body.confirmation !== WORKSPACE_ERASURE_CONFIRMATION) {
      return NextResponse.json(
        { error: `Type ${WORKSPACE_ERASURE_CONFIRMATION} to confirm permanent erasure.` },
        { status: 400 }
      );
    }

    const result = eraseWorkspaceData(db, { backupDirectory, databasePath });
    logInfo('workspace.erase_succeeded', {
      request_id: getRequestId(request.headers) || undefined,
      operation: 'workspace_erase',
      status_code: 200,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('workspace.erase_failed', error, request, '/api/settings/erase');
    return NextResponse.json({ error: 'Failed to erase Everclose CRM data.' }, { status: 500 });
  }
}
