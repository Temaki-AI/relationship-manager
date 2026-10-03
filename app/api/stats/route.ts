import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { logRouteError } from '@/lib/observability';
import { birthdayStatsSQL, checkInStatsSQL, statsResponse, statsToday } from '@/lib/stats-directory';

export async function GET(request: Request) {
  try {
    const today = statsToday(request);
    const { total } = db.prepare(
      'SELECT COUNT(*) as total FROM contacts'
    ).get() as { total: number };

    const { thisWeek } = db.prepare(
      "SELECT COUNT(*) as thisWeek FROM interactions WHERE date >= date(?, '-7 days') AND date <= ?"
    ).get(today, today) as { thisWeek: number };
    const rhythms = db.prepare(checkInStatsSQL(false, false)).get(today) as { ready: number; neglected: number };
    const actionItems = db.prepare(checkInStatsSQL(false, true)).all(today) as Array<{ id: number }>;
    const birthdays = db.prepare(birthdayStatsSQL(false)).all(today) as Array<{
      id: number; name: string; birthday: string; daysUntil: number; total: number;
    }>;

    return NextResponse.json(statsResponse(total, thisWeek, rhythms, actionItems, birthdays));
  } catch (error) {
    logRouteError('stats.load_failed', error, request, '/api/stats');
    return NextResponse.json(
      { error: 'Failed to fetch stats' },
      { status: 500 }
    );
  }
}
