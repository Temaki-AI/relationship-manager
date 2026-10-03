import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { parseDateTime, parseOptionalText, parsePositiveInteger } from '@/lib/relationship-validation';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { logRouteError } from '@/lib/observability';
import { normalizeTimeZone } from '@/lib/civil-date';
import {
  listBirthdayNotificationCandidates,
  listNotificationCandidates,
  listReminderPage,
} from '@/lib/reminder-directory';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMutationLock,
} from '@/lib/database-maintenance-lock';
import {
  fingerprintIdempotencyInput,
  IdempotencyError,
  requireIdempotencyKey,
  runIdempotentCreate,
} from '@/lib/idempotency';

type ReminderRow = {
  id: number;
  contact_id: number;
  title: string;
  notes: string | null;
  remind_at: string;
  completed_at: string | null;
  created_at: string;
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const view = searchParams.get('view') || '';
    if (view === 'notifications') {
      return NextResponse.json({
        reminders: listNotificationCandidates(db),
        birthdays: listBirthdayNotificationCandidates(db, new Date(), normalizeTimeZone(searchParams.get('timeZone'))),
      });
    }
    if (view) {
      return NextResponse.json({ error: 'Unknown reminders view.' }, { status: 400 });
    }

    return NextResponse.json(listReminderPage(db, {
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
    }));
  } catch (error) {
    logRouteError('reminders.load_failed', error, request, '/api/reminders');
    return NextResponse.json({ error: 'Failed to fetch reminders' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const contactId = parsePositiveInteger(body.contact_id);
    if (!contactId) {
      return NextResponse.json({ error: 'Valid contact_id is required' }, { status: 400 });
    }

    const title = parseOptionalText(body.title, 200);
    const notes = parseOptionalText(body.notes, 10_000);
    const remindAt = parseDateTime(body.remind_at);
    if (!title) {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }
    if (notes === undefined) {
      return NextResponse.json({ error: 'Reminder notes are invalid or too long' }, { status: 400 });
    }
    if (!remindAt) {
      return NextResponse.json({ error: 'Valid remind_at is required' }, { status: 400 });
    }
    const idempotencyKey = requireIdempotencyKey(request.headers);
    const input = { contactId, title, notes, remindAt };

    const result = withDatabaseMutationLock(backupDirectory, () => {
      return runIdempotentCreate(db, {
        scope: 'reminders-create',
        idempotencyKey,
        fingerprint: fingerprintIdempotencyInput(input),
        create: () => {
          const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(contactId);
          if (!contact) return null;
          const insert = db
            .prepare(
              'INSERT INTO reminders (contact_id, title, notes, remind_at) VALUES (?, ?, ?, ?)'
            )
            .run(contactId, title, notes, remindAt);
          return db.prepare('SELECT * FROM reminders WHERE id = ?')
            .get(insert.lastInsertRowid) as ReminderRow;
        },
        load: (resourceId) => db.prepare('SELECT * FROM reminders WHERE id = ?')
          .get(resourceId) as ReminderRow | undefined,
      });
    });
    if (!result.resource) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    return NextResponse.json(
      { reminder: result.resource },
      { status: 201, headers: { 'Idempotency-Replayed': String(result.replayed) } }
    );
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof IdempotencyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logRouteError('reminders.create_failed', error, request, '/api/reminders');
    return NextResponse.json({ error: 'Failed to create reminder' }, { status: 500 });
  }
}
