import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { parseDateTime, parseOptionalText, parsePositiveInteger } from '@/lib/relationship-validation';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { logRouteError } from '@/lib/observability';
import { completeReminderRecord } from '@/lib/relationship-mutations';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMutationLock,
} from '@/lib/database-maintenance-lock';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const reminderId = parsePositiveInteger(id);
    if (!reminderId) return NextResponse.json({ error: 'Reminder not found' }, { status: 404 });
    const body = await readJsonBody<Record<string, unknown>>(request);

    if (body.completed === true) {
      const completion = withDatabaseMutationLock(
        backupDirectory,
        () => completeReminderRecord(db, reminderId)
      );
      if (completion.status === 'not-found') {
        return NextResponse.json({ error: 'Reminder not found' }, { status: 404 });
      }
      return NextResponse.json({
        reminder: completion.reminder,
        completionChanged: completion.status === 'completed',
      });
    } else {
      const title = parseOptionalText(body.title, 200);
      const notes = parseOptionalText(body.notes, 10_000);
      const remindAt = parseDateTime(body.remind_at);
      if (!title || !remindAt) {
        return NextResponse.json({ error: 'Valid title and remind_at are required' }, { status: 400 });
      }
      if (notes === undefined) {
        return NextResponse.json({ error: 'Reminder notes are invalid or too long' }, { status: 400 });
      }
      const reminder = withDatabaseMutationLock(backupDirectory, () => {
        const result = db.prepare(
          'UPDATE reminders SET title = ?, notes = ?, remind_at = ? WHERE id = ?'
        ).run(title, notes, remindAt, reminderId);
        return result.changes === 0
          ? null
          : db.prepare('SELECT * FROM reminders WHERE id = ?').get(reminderId);
      });
      if (!reminder) {
        return NextResponse.json({ error: 'Reminder not found' }, { status: 404 });
      }
      return NextResponse.json({ reminder });
    }
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('reminders.update_failed', error, request, '/api/reminders/[id]');
    return NextResponse.json({ error: 'Failed to update reminder' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const reminderId = parsePositiveInteger(id);
    if (!reminderId) return NextResponse.json({ error: 'Reminder not found' }, { status: 404 });
    const result = withDatabaseMutationLock(
      backupDirectory,
      () => db.prepare('DELETE FROM reminders WHERE id = ?').run(reminderId)
    );
    return NextResponse.json({ success: true, alreadyDeleted: result.changes === 0 });
  } catch (error) {
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('reminders.delete_failed', error, request, '/api/reminders/[id]');
    return NextResponse.json({ error: 'Failed to delete reminder' }, { status: 500 });
  }
}
