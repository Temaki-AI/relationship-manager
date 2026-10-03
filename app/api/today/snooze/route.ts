import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { dateInTimeZone, normalizeTimeZone } from '@/lib/civil-date';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { DatabaseMaintenanceBusyError, withDatabaseMutationLock } from '@/lib/database-maintenance-lock';
import { deleteLocalTodaySnooze, putLocalTodaySnooze, TodaySnoozeError } from '@/lib/today-snooze-store';
import { parseTodaySnoozeTarget, parseTodaySnoozeUntil } from '@/lib/today-snooze';
import { logRouteError } from '@/lib/observability';

async function handle(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const target = parseTodaySnoozeTarget(body.id);
    if (!target) return NextResponse.json({ error: 'Choose a valid prompt.' }, { status: 400 });
    if (request.method === 'DELETE') {
      withDatabaseMutationLock(backupDirectory, () => deleteLocalTodaySnooze(db, body.id as string));
      return NextResponse.json({ success: true });
    }
    const timeZone = normalizeTimeZone(body.timeZone);
    const now = new Date();
    const until = parseTodaySnoozeUntil(body.until, now, timeZone);
    if (!until) return NextResponse.json({ error: 'Choose a date within the next 30 days.' }, { status: 400 });
    const today = dateInTimeZone(now, timeZone)!;
    const snooze = withDatabaseMutationLock(backupDirectory, () => putLocalTodaySnooze(db, body.id as string, target, until, today));
    return NextResponse.json({ snooze });
  } catch (error) {
    if (error instanceof RequestBodyError || error instanceof DatabaseMaintenanceBusyError || error instanceof TodaySnoozeError) {
      return NextResponse.json({ error: error.message }, { status: error instanceof DatabaseMaintenanceBusyError ? 409 : error.status });
    }
    logRouteError('today.snooze_failed', error, request, '/api/today/snooze');
    return NextResponse.json({ error: 'Could not save the snooze.' }, { status: 500 });
  }
}

export const PUT = handle;
export const DELETE = handle;
