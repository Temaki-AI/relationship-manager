import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMutationLock,
} from '@/lib/database-maintenance-lock';
import { logRouteError } from '@/lib/observability';
import { parsePositiveInteger } from '@/lib/relationship-validation';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; relationshipId: string }> }
) {
  try {
    const { id, relationshipId } = await params;
    const contactId = parsePositiveInteger(id);
    const connectionId = parsePositiveInteger(relationshipId);
    if (!contactId || !connectionId) {
      return NextResponse.json({ error: 'Relationship not found' }, { status: 404 });
    }
    const result = withDatabaseMutationLock(
      backupDirectory,
      () => db.prepare(`
        DELETE FROM contact_relationships
        WHERE id = ? AND (contact_id = ? OR related_contact_id = ?)
      `).run(connectionId, contactId, contactId)
    );
    return NextResponse.json({ success: true, alreadyDeleted: result.changes === 0 });
  } catch (error) {
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logRouteError('contact_relationships.delete_failed', error, request, '/api/contacts/[id]/relationships/[relationshipId]');
    return NextResponse.json({ error: 'Failed to remove relationship' }, { status: 500 });
  }
}
