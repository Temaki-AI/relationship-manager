import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { listPlanPage, type PlanDirectoryStatus } from '@/lib/plan-directory';
import {
  parseDateOnly,
  parseOptionalText,
  parsePositiveInteger,
  parseRelationshipActivityType,
} from '@/lib/relationship-validation';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { logRouteError } from '@/lib/observability';
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

type PlanRow = {
  id: number;
  contact_id: number;
  type: string;
  planned_date: string;
  summary: string | null;
  notes: string | null;
  completed_at: string | null;
  created_at: string;
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const rawContactId = searchParams.get('contact_id');
    const contactId = rawContactId ? parsePositiveInteger(rawContactId) : undefined;
    if (rawContactId && !contactId) {
      return NextResponse.json({ error: 'Valid contact_id is required' }, { status: 400 });
    }
    const rawStatus = searchParams.get('status');
    const defaultStatus: PlanDirectoryStatus = contactId ? 'all' : 'open';
    const status = (rawStatus || defaultStatus) as PlanDirectoryStatus;
    if (!['open', 'completed', 'all'].includes(status)) {
      return NextResponse.json({ error: 'Unknown plan status.' }, { status: 400 });
    }
    return NextResponse.json(listPlanPage(db, {
      contactId: contactId ?? undefined,
      status,
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
    }));
  } catch (error) {
    logRouteError('plans.load_failed', error, request, '/api/plans');
    return NextResponse.json({ error: 'Failed to fetch plans' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const contactId = parsePositiveInteger(body.contact_id);
    const type = parseRelationshipActivityType(body.type);
    const plannedDate = parseDateOnly(body.planned_date);
    const summary = parseOptionalText(body.summary, 500);
    const notes = parseOptionalText(body.notes, 10_000);

    if (!contactId || !type || !plannedDate) {
      return NextResponse.json(
        { error: 'Valid contact_id, type, and planned_date are required' },
        { status: 400 }
      );
    }
    if (summary === undefined || notes === undefined) {
      return NextResponse.json({ error: 'Plan text is invalid or too long' }, { status: 400 });
    }
    const idempotencyKey = requireIdempotencyKey(request.headers);
    const input = { contactId, type, plannedDate, summary, notes };

    const result = withDatabaseMutationLock(backupDirectory, () => {
      return runIdempotentCreate(db, {
        scope: 'plans-create',
        idempotencyKey,
        fingerprint: fingerprintIdempotencyInput(input),
        create: () => {
          const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(contactId);
          if (!contact) return null;
          const insert = db
            .prepare('INSERT INTO plans (contact_id, type, planned_date, summary, notes) VALUES (?, ?, ?, ?, ?)')
            .run(contactId, type, plannedDate, summary, notes);
          return db.prepare('SELECT * FROM plans WHERE id = ?')
            .get(insert.lastInsertRowid) as PlanRow;
        },
        load: (resourceId) => db.prepare('SELECT * FROM plans WHERE id = ?')
          .get(resourceId) as PlanRow | undefined,
      });
    });
    if (!result.resource) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }
    return NextResponse.json(
      { plan: result.resource },
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
    logRouteError('plans.create_failed', error, request, '/api/plans');
    return NextResponse.json({ error: 'Failed to create plan' }, { status: 500 });
  }
}
