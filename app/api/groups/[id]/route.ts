import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { parseGroupColor, parseGroupName } from '@/lib/group-input';
import { parsePositiveInteger } from '@/lib/relationship-validation';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { logRouteError } from '@/lib/observability';
import { listNumericGroupMemberPage } from '@/lib/numeric-group-directory';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMutationLock,
} from '@/lib/database-maintenance-lock';

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const groupId = parsePositiveInteger(id);
    if (!groupId) return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    
    const group = db.prepare('SELECT * FROM contact_groups WHERE id = ?').get(groupId);

    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }
    
    const { searchParams } = new URL(request.url);
    const { members, pagination } = listNumericGroupMemberPage(db, groupId, {
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
    });

    return NextResponse.json({ group, members, pagination });
  } catch (error) {
    logRouteError('groups.detail_failed', error, request, '/api/groups/[id]');
    return NextResponse.json({ error: 'Failed to fetch group' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const groupId = parsePositiveInteger(id);
    if (!groupId) return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    const body = await readJsonBody<Record<string, unknown>>(request);
    const name = parseGroupName(body.name);
    const color = parseGroupColor(body.color);

    if (!name) {
      return NextResponse.json({ error: 'Group name must be 1-100 characters' }, { status: 400 });
    }
    if (color === undefined) {
      return NextResponse.json({ error: 'Group color must be a six-digit hex color' }, { status: 400 });
    }

    const group = withDatabaseMutationLock(backupDirectory, () => {
      const result = db.prepare(
        'UPDATE contact_groups SET name = ?, color = ? WHERE id = ?'
      ).run(name, color, groupId);
      return result.changes === 0
        ? null
        : db.prepare('SELECT * FROM contact_groups WHERE id = ?').get(groupId);
    });
    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }
    return NextResponse.json({ group });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('groups.update_failed', error, request, '/api/groups/[id]');
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: 'A group with that name already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to update group' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const groupId = parsePositiveInteger(id);
    if (!groupId) return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    const result = withDatabaseMutationLock(
      backupDirectory,
      () => db.prepare('DELETE FROM contact_groups WHERE id = ?').run(groupId)
    );

    if (result.changes === 0) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('groups.delete_failed', error, request, '/api/groups/[id]');
    return NextResponse.json({ error: 'Failed to delete group' }, { status: 500 });
  }
}
