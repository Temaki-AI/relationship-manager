import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { parsePositiveInteger } from '@/lib/relationship-validation';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { logRouteError } from '@/lib/observability';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMutationLock,
} from '@/lib/database-maintenance-lock';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await readJsonBody<Record<string, unknown>>(request);
    const groupId = parsePositiveInteger(id);
    const contactId = parsePositiveInteger(body.contact_id);
    if (!groupId || !contactId) {
      return NextResponse.json({ error: 'Valid group and contact IDs are required' }, { status: 400 });
    }

    const result = withDatabaseMutationLock(backupDirectory, () => {
      const group = db.prepare('SELECT id FROM contact_groups WHERE id = ?').get(groupId);
      if (!group) return { status: 'group-not-found' as const };
      const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(contactId);
      if (!contact) return { status: 'contact-not-found' as const };
      const insert = db.prepare(
        'INSERT OR IGNORE INTO contact_group_members (contact_id, group_id) VALUES (?, ?)'
      ).run(contactId, groupId);
      return { status: 'updated' as const, added: insert.changes > 0 };
    });
    if (result.status === 'group-not-found') {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }
    if (result.status === 'contact-not-found') {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, added: result.added });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('group_members.add_failed', error, request, '/api/groups/[id]/members');
    return NextResponse.json({ error: 'Failed to add member' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const groupId = parsePositiveInteger(id);
    const contactId = parsePositiveInteger(searchParams.get('contact_id'));

    if (!groupId || !contactId) {
      return NextResponse.json({ error: 'Valid group and contact IDs are required' }, { status: 400 });
    }

    const result = withDatabaseMutationLock(
      backupDirectory,
      () => db.prepare(
        'DELETE FROM contact_group_members WHERE contact_id = ? AND group_id = ?'
      ).run(contactId, groupId)
    );

    return NextResponse.json({ success: true, removed: result.changes > 0 });
  } catch (error) {
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('group_members.remove_failed', error, request, '/api/groups/[id]/members');
    return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 });
  }
}
