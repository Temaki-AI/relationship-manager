import { NextResponse } from 'next/server';
import db, { backupDirectory, type Interaction } from '@/lib/db';
import { deleteInteractionRecord } from '@/lib/relationship-mutations';
import {
  getExpectedInteractionRevision,
  InteractionRevisionError,
  updateInteractionIfCurrent,
  withInteractionEditRevision,
} from '@/lib/interaction-revision';
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const interactionId = parsePositiveInteger(id);
    if (!interactionId) return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
    const interaction = db.prepare('SELECT * FROM interactions WHERE id = ?').get(interactionId) as Interaction | undefined;
    if (!interaction) return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
    return NextResponse.json({ interaction: withInteractionEditRevision(interaction) });
  } catch (error) {
    logRouteError('interactions.detail_failed', error, request, '/api/interactions/[id]');
    return NextResponse.json({ error: 'Failed to fetch interaction' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const interactionId = parsePositiveInteger(id);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const date = parseDateOnly(body.date);
    const type = parseRelationshipActivityType(body.type);
    const summary = parseOptionalText(body.summary, 500);
    const notes = parseOptionalText(body.notes, 10_000);
    if (!interactionId || !date || !type || summary === undefined || notes === undefined) {
      return NextResponse.json({ error: 'Valid date, type, and interaction text are required' }, { status: 400 });
    }
    const expectedRevision = getExpectedInteractionRevision(body);

    const result = withDatabaseMutationLock(
      backupDirectory,
      () => updateInteractionIfCurrent(
        db,
        interactionId,
        { date, type, summary, notes },
        expectedRevision
      )
    );
    if (result.status === 'not-found') {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
    }
    if (result.status === 'conflict') {
      return NextResponse.json({
        error: 'This interaction changed after you opened it. Your draft has not been saved.',
        current_edit_revision: result.editRevision,
      }, { status: 409 });
    }
    return NextResponse.json({ interaction: result.interaction });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InteractionRevisionError) {
      return NextResponse.json({ error: error.message }, { status: 428 });
    }
    logRouteError('interactions.update_failed', error, request, '/api/interactions/[id]');
    return NextResponse.json({ error: 'Failed to update interaction' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const interactionId = parsePositiveInteger(id);
    if (!interactionId) return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
    const deleted = withDatabaseMutationLock(
      backupDirectory,
      () => deleteInteractionRecord(db, interactionId)
    );

    return NextResponse.json({ success: true, alreadyDeleted: !deleted });
  } catch (error) {
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('interactions.delete_failed', error, request, '/api/interactions/[id]');
    return NextResponse.json({ error: 'Failed to delete interaction' }, { status: 500 });
  }
}
