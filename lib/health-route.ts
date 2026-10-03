import { NextResponse } from 'next/server';
import { getAuthConfiguration } from './auth.ts';
import db, { backupDirectory } from './db.ts';
import { getReadinessReport } from './health.ts';
import { logRouteError } from './observability.ts';

export function readinessResponse(request: Request, route: string): NextResponse {
  const authentication = getAuthConfiguration();
  try {
    const report = getReadinessReport(db, backupDirectory, authentication);
    return NextResponse.json(report, { status: report.ready ? 200 : 503 });
  } catch (error) {
    logRouteError('health.check_failed', error, request, route, 503);
    return NextResponse.json(
      {
        status: 'unavailable',
        ready: false,
        checks: {
          authentication: authentication.mode,
          database: 'failed',
        },
      },
      { status: 503 }
    );
  }
}
