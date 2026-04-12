import { NextResponse } from 'next/server';
import db, { type IntegrationConnection, type SyncJob, type Workspace } from '@/lib/db';
import { buildIntegrationSnapshots } from '@/lib/intelligence';

export async function GET() {
  try {
    const workspace = db.prepare('SELECT * FROM workspaces ORDER BY id LIMIT 1').get() as Workspace | undefined;
    const integrations = db.prepare('SELECT * FROM integration_connections ORDER BY provider').all() as IntegrationConnection[];
    const syncJobs = db.prepare('SELECT * FROM sync_jobs ORDER BY started_at DESC').all() as SyncJob[];

    return NextResponse.json({
      workspace,
      integrations: buildIntegrationSnapshots(integrations, syncJobs),
    });
  } catch (error) {
    console.error('GET /api/integrations error:', error);
    return NextResponse.json({ error: 'Failed to fetch integrations' }, { status: 500 });
  }
}
