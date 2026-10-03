import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { CalendarRangeError, listCalendarEvents } from '@/lib/calendar-directory';
import { logRouteError } from '@/lib/observability';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    return NextResponse.json(listCalendarEvents(db, {
      start: searchParams.get('start'),
      end: searchParams.get('end'),
      timeZone: searchParams.get('timeZone'),
    }));
  } catch (error) {
    if (error instanceof CalendarRangeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logRouteError('calendar.load_failed', error, request, '/api/calendar');
    return NextResponse.json({ error: 'Failed to load calendar events' }, { status: 500 });
  }
}
