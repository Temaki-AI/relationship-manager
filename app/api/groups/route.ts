import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { parseGroupColor, parseGroupName } from '@/lib/group-input';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { logRouteError } from '@/lib/observability';
import { listNumericGroupPage } from '@/lib/numeric-group-directory';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMutationLock,
} from '@/lib/database-maintenance-lock';

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    return NextResponse.json(listNumericGroupPage(db, {
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
    }));
  } catch (error) {
    logRouteError('groups.load_failed', error, request, '/api/groups');
    return NextResponse.json({ error: 'Failed to fetch groups' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
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
      const result = db
        .prepare('INSERT INTO contact_groups (name, color) VALUES (?, ?)')
        .run(name, color);
      return db.prepare('SELECT * FROM contact_groups WHERE id = ?')
        .get(result.lastInsertRowid);
    });

    return NextResponse.json({ group }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('groups.create_failed', error, request, '/api/groups');
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: 'A group with that name already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to create group' }, { status: 500 });
  }
}
