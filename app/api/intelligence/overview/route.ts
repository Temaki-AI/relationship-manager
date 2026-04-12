import { NextResponse } from 'next/server';
import db, { type Contact, type IntegrationConnection, type Interaction, type Reminder, type SyncJob, type Workspace } from '@/lib/db';
import { buildIntelligenceOverview } from '@/lib/intelligence';

export async function GET() {
  try {
    const workspace = db.prepare('SELECT * FROM workspaces ORDER BY id LIMIT 1').get() as Workspace | undefined;
    const contacts = db.prepare('SELECT * FROM contacts ORDER BY updated_at DESC').all() as Contact[];
    const interactions = db.prepare('SELECT * FROM interactions ORDER BY date DESC').all() as Interaction[];
    const reminders = db.prepare('SELECT * FROM reminders ORDER BY remind_at ASC').all() as Reminder[];
    const integrations = db.prepare('SELECT * FROM integration_connections ORDER BY provider').all() as IntegrationConnection[];
    const syncJobs = db.prepare('SELECT * FROM sync_jobs ORDER BY started_at DESC').all() as SyncJob[];

    return NextResponse.json({
      workspace,
      ...buildIntelligenceOverview(contacts, interactions, reminders, integrations, syncJobs),
    });
  } catch (error) {
    console.error('GET /api/intelligence/overview error:', error);
    return NextResponse.json({ error: 'Failed to build intelligence overview' }, { status: 500 });
  }
}
