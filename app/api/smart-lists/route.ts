import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { buildSmartListsFromActivity } from '@/lib/intelligence';
import { loadSmartListData } from '@/lib/intelligence-directory';
import { logRouteError } from '@/lib/observability';
import { dateInTimeZone, normalizeTimeZone } from '@/lib/civil-date';

export async function GET(request: Request) {
  try {
    const now = new Date();
    const timeZone = normalizeTimeZone(new URL(request.url).searchParams.get('timeZone'));
    const { contacts, activity, snoozes } = loadSmartListData(db, dateInTimeZone(now, timeZone)!);

    return NextResponse.json({
      smartLists: buildSmartListsFromActivity(contacts, activity, now, timeZone, snoozes),
    });
  } catch (error) {
    logRouteError('smart_lists.load_failed', error, request, '/api/smart-lists');
    return NextResponse.json({ error: 'Failed to fetch smart lists' }, { status: 500 });
  }
}
