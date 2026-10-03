import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMutationLock,
} from '@/lib/database-maintenance-lock';
import { logRouteError } from '@/lib/observability';
import { ContactConnectionInputError, normalizeChildInput, validateChildLink } from '@/lib/contact-connections';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { parsePositiveInteger } from '@/lib/relationship-validation';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; childId: string }> }
) {
  try {
    const { id, childId } = await params;
    const contactId = parsePositiveInteger(id);
    const childRecordId = parsePositiveInteger(childId);
    if (!contactId || !childRecordId) return NextResponse.json({ error: 'Child not found' }, { status: 404 });
    const body = await readJsonBody<Record<string, unknown>>(request);
    const input = normalizeChildInput(body);
    if (typeof body.expected_updated_at !== 'string' || !body.expected_updated_at) {
      return NextResponse.json({ error: 'Refresh this child entry before editing.' }, { status: 400 });
    }
    const result = withDatabaseMutationLock(backupDirectory, () => db.transaction(() => {
      const current = db.prepare('SELECT name, birthday, linked_contact_id, updated_at FROM contact_children WHERE id = ? AND contact_id = ?')
        .get(childRecordId, contactId) as { name: string; birthday: string | null; linked_contact_id: number | null; updated_at: string } | undefined;
      if (!current) return { status: 404 as const };
      if (current.updated_at !== body.expected_updated_at) return { status: 409 as const };
      if (input.linked_contact_id !== null) {
        const linked = db.prepare('SELECT birthday FROM contacts WHERE id = ?').get(input.linked_contact_id) as { birthday: string | null } | undefined;
        if (!linked) throw new ContactConnectionInputError('Linked profile not found.');
        if (current.linked_contact_id !== input.linked_contact_id) {
          validateChildLink(contactId, input.birthday, input.linked_contact_id, linked.birthday);
        }
      }
      const child = db.prepare(`UPDATE contact_children SET name = ?, birthday = ?, linked_contact_id = ?, updated_at = ?
        WHERE id = ? AND contact_id = ? AND updated_at = ? AND name = ? AND birthday IS ? AND linked_contact_id IS ?
        RETURNING *`).get(input.name, input.birthday, input.linked_contact_id, new Date().toISOString(),
        childRecordId, contactId, current.updated_at, current.name, current.birthday, current.linked_contact_id);
      return child ? { status: 200 as const, child } : { status: 409 as const };
    }).immediate());
    if (result.status === 404) return NextResponse.json({ error: 'Child not found' }, { status: 404 });
    if (result.status === 409) return NextResponse.json({ error: 'This child entry changed after you opened it. Your draft was not saved.' }, { status: 409 });
    return NextResponse.json({ child: result.child });
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: contact_children.contact_id, contact_children.linked_contact_id')) {
      return NextResponse.json({ error: 'This child profile is already linked to this contact.' }, { status: 409 });
    }
    if (error instanceof RequestBodyError || error instanceof ContactConnectionInputError) {
      return NextResponse.json({ error: error.message }, { status: error instanceof RequestBodyError ? error.status : 400 });
    }
    if (error instanceof DatabaseMaintenanceBusyError) return NextResponse.json({ error: error.message }, { status: 409 });
    logRouteError('contact_children.update_failed', error, request, '/api/contacts/[id]/children/[childId]');
    return NextResponse.json({ error: 'Failed to update child' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; childId: string }> }
) {
  try {
    const { id, childId } = await params;
    const contactId = parsePositiveInteger(id);
    const childRecordId = parsePositiveInteger(childId);
    if (!contactId || !childRecordId) {
      return NextResponse.json({ error: 'Child not found' }, { status: 404 });
    }
    const result = withDatabaseMutationLock(
      backupDirectory,
      () => db.prepare('DELETE FROM contact_children WHERE id = ? AND contact_id = ?')
        .run(childRecordId, contactId)
    );
    return NextResponse.json({ success: true, alreadyDeleted: result.changes === 0 });
  } catch (error) {
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('contact_children.delete_failed', error, request, '/api/contacts/[id]/children/[childId]');
    return NextResponse.json({ error: 'Failed to remove child' }, { status: 500 });
  }
}
