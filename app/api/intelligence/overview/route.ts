import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { buildIntelligenceOverviewFromActivity } from '@/lib/intelligence';
import { loadIntelligenceOverviewData } from '@/lib/intelligence-directory';
import { logRouteError } from '@/lib/observability';
import { dateInTimeZone, normalizeTimeZone } from '@/lib/civil-date';

export async function GET(request: Request) {
  try {
    const now = new Date();
    const timeZone = normalizeTimeZone(new URL(request.url).searchParams.get('timeZone'));
    const {
      workspace,
      contacts,
      activity,
      feedReminders,
      openReminderCount,
      snoozes,
    } = loadIntelligenceOverviewData(db, dateInTimeZone(now, timeZone)!);

    return NextResponse.json({
      workspace,
      ...buildIntelligenceOverviewFromActivity(
        contacts,
        activity,
        feedReminders,
        openReminderCount,
        now,
        timeZone,
        snoozes
      ),
    });
  } catch (error) {
    logRouteError('intelligence.load_failed', error, request, '/api/intelligence/overview');
    return NextResponse.json({ error: 'Failed to build intelligence overview' }, { status: 500 });
  }
}
