import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { createInteractionRecord } from '@/lib/relationship-mutations';
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

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const contactId = parsePositiveInteger(body.contact_id);
    const date = parseDateOnly(body.date);
    const type = parseRelationshipActivityType(body.type);
    const summary = parseOptionalText(body.summary, 500);
    const notes = parseOptionalText(body.notes, 10_000);

    if (!contactId || !date || !type) {
      return NextResponse.json(
        { error: 'Valid contact_id, date, and type are required' },
        { status: 400 }
      );
    }
    if (summary === undefined || notes === undefined) {
      return NextResponse.json({ error: 'Interaction text is invalid or too long' }, { status: 400 });
    }
    const idempotencyKey = requireIdempotencyKey(request.headers);
    const input = { contactId, date, type, summary, notes };

    const result = withDatabaseMutationLock(backupDirectory, () => {
      return runIdempotentCreate(db, {
        scope: 'interactions-create',
        idempotencyKey,
        fingerprint: fingerprintIdempotencyInput(input),
        create: () => {
          const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(contactId);
          if (!contact) return null;
          return createInteractionRecord(db, input);
        },
        load: (resourceId) => db.prepare('SELECT * FROM interactions WHERE id = ?')
          .get(resourceId) as ReturnType<typeof createInteractionRecord> | undefined,
      });
    });

    if (!result.resource) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    return NextResponse.json(
      { interaction: result.resource },
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
    logRouteError('interactions.create_failed', error, request, '/api/interactions');
    return NextResponse.json(
      { error: 'Failed to create interaction' },
      { status: 500 }
    );
  }
}
