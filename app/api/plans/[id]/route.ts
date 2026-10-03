import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { completePlanRecord } from '@/lib/relationship-mutations';
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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const planId = parsePositiveInteger(id);
    if (!planId) return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    const body = await readJsonBody<Record<string, unknown>>(request);

    if (body.completed === true) {
      const completion = withDatabaseMutationLock(
        backupDirectory,
        () => completePlanRecord(db, planId)
      );
      if (completion.status === 'not-found') {
        return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
      }
      return NextResponse.json({
        plan: completion.plan,
        interactionCreated: completion.status === 'completed',
      });
    }

    // Regular update
    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.type !== undefined) {
      const type = parseRelationshipActivityType(body.type);
      if (!type) return NextResponse.json({ error: 'Valid plan type is required' }, { status: 400 });
      updates.push('type = ?');
      values.push(type);
    }
    if (body.planned_date !== undefined) {
      const plannedDate = parseDateOnly(body.planned_date);
      if (!plannedDate) return NextResponse.json({ error: 'Valid planned_date is required' }, { status: 400 });
      updates.push('planned_date = ?');
      values.push(plannedDate);
    }
    if (body.summary !== undefined) {
      const summary = parseOptionalText(body.summary, 500);
      if (summary === undefined) return NextResponse.json({ error: 'Plan summary is invalid or too long' }, { status: 400 });
      updates.push('summary = ?');
      values.push(summary);
    }
    if (body.notes !== undefined) {
      const notes = parseOptionalText(body.notes, 10_000);
      if (notes === undefined) return NextResponse.json({ error: 'Plan notes are invalid or too long' }, { status: 400 });
      updates.push('notes = ?');
      values.push(notes);
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    values.push(planId);
    const updated = withDatabaseMutationLock(backupDirectory, () => {
      const result = db.prepare(`UPDATE plans SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      return result.changes === 0
        ? null
        : db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
    });

    if (!updated) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }
    return NextResponse.json({ plan: updated });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('plans.update_failed', error, request, '/api/plans/[id]');
    return NextResponse.json({ error: 'Failed to update plan' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const planId = parsePositiveInteger(id);
    if (!planId) return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    const result = withDatabaseMutationLock(
      backupDirectory,
      () => db.prepare('DELETE FROM plans WHERE id = ?').run(planId)
    );

    return NextResponse.json({ success: true, alreadyDeleted: result.changes === 0 });
  } catch (error) {
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('plans.delete_failed', error, request, '/api/plans/[id]');
    return NextResponse.json({ error: 'Failed to delete plan' }, { status: 500 });
  }
}
