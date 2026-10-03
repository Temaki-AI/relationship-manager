import { NextResponse } from 'next/server';
import { getAuthConfiguration } from './auth.ts';
import { logRouteError } from './observability.ts';

export async function readinessResponse(request: Request, route: string): Promise<NextResponse> {
  if (process.env.AUTH_MODE === 'google') {
    try {
      const { getCloudflareContext } = await import('@opennextjs/cloudflare');
      const { getCloudReadinessReport } = await import('./cloud/health.ts');
      const report = await getCloudReadinessReport(getCloudflareContext().env.DB, process.env);
      return NextResponse.json(report, { status: report.ready ? 200 : 503 });
    } catch (error) {
      logRouteError('health.check_failed', error, request, route, 503);
      return NextResponse.json(
        { status: 'unavailable', ready: false, checks: { authentication: 'google', database: 'failed' } },
        { status: 503 }
      );
    }
  }

  const authentication = getAuthConfiguration();
  try {
    const [{ default: db, backupDirectory }, { getReadinessReport }] = await Promise.all([
      import('./db.ts'),
      import('./health.ts'),
    ]);
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
