import { NextResponse } from 'next/server';
import db, { type Workspace } from '@/lib/db';
import { AUTOMATIC_ACCOUNT_SYNC, DATA_CAPABILITIES } from '@/lib/data-capabilities';
import { logRouteError } from '@/lib/observability';

export async function GET(request: Request) {
  try {
    const workspace = db.prepare('SELECT * FROM workspaces ORDER BY id LIMIT 1').get() as Workspace | undefined;

    return NextResponse.json({
      workspace: workspace ? { name: workspace.name, mode: 'local' as const } : undefined,
      capabilities: DATA_CAPABILITIES,
      automaticAccountSync: AUTOMATIC_ACCOUNT_SYNC,
    });
  } catch (error) {
    logRouteError('integrations.load_failed', error, request, '/api/integrations');
    return NextResponse.json({ error: 'Failed to fetch data connections' }, { status: 500 });
  }
}
