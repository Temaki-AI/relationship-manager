import { NextResponse } from 'next/server';
import db, { backupDirectory, type Contact } from '@/lib/db';
import { ContactDeletionError, deleteContactsWithRecovery } from '@/lib/contact-deletion';
import { ContactInputError, normalizeContactPatchInput } from '@/lib/contact-input';
import {
  ContactRevisionError,
  getContactEditRevision,
  getExpectedContactRevision,
  updateContactIfCurrent,
} from '@/lib/contact-revision';
import { getBackupRetentionCount } from '@/lib/database-maintenance-config';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMutationLock,
} from '@/lib/database-maintenance-lock';
import {
  listContactFactsPage,
  listContactInteractionsPage,
  listContactPlansPage,
  listContactRemindersPage,
  listContactTimelinePage,
  loadContactDetailData,
  parseTimelineKindFilter,
} from '@/lib/contact-history';
import { parsePositiveInteger } from '@/lib/relationship-validation';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { logRouteError } from '@/lib/observability';
import { normalizeTimeZone } from '@/lib/civil-date';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const contactId = parsePositiveInteger(id);
    if (!contactId) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) as Contact | undefined;
    
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const view = searchParams.get('view') || '';
    const options = {
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
    };
    if (view === 'interactions') {
      return NextResponse.json(listContactInteractionsPage(db, contactId, options));
    }
    if (view === 'reminders') {
      return NextResponse.json(listContactRemindersPage(db, contactId, options));
    }
    if (view === 'facts') {
      return NextResponse.json(listContactFactsPage(db, contactId, options));
    }
    if (view === 'plans') {
      return NextResponse.json(listContactPlansPage(db, contactId, options));
    }
    if (view === 'timeline') {
      const rawKind = searchParams.get('kind');
      const kind = parseTimelineKindFilter(rawKind);
      if (rawKind && !kind) return NextResponse.json({ error: 'Unknown activity filter.' }, { status: 400 });
      return NextResponse.json(listContactTimelinePage(db, contact, { ...options, kind: kind || undefined }));
    }
    if (view) {
      return NextResponse.json({ error: 'Unknown contact history view.' }, { status: 400 });
    }

    const detail = loadContactDetailData(db, contact, new Date(), normalizeTimeZone(searchParams.get('timeZone')));
    return NextResponse.json({
      ...detail,
      contact: {
        ...detail.contact,
        edit_revision: getContactEditRevision(contact),
      },
    });
  } catch (error) {
    logRouteError('contacts.detail_failed', error, request, '/api/contacts/[id]');
    return NextResponse.json({ error: 'Failed to fetch contact' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const contactId = parsePositiveInteger(id);
    if (!contactId) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    const body = await readJsonBody(request);
    const original = db.prepare('SELECT contact_methods FROM contacts WHERE id = ?').get(contactId) as { contact_methods: string } | undefined;
    if (!original) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    const fields = normalizeContactPatchInput(body, original.contact_methods);
    const expectedRevision = getExpectedContactRevision(body);

    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ error: 'No supported fields to update' }, { status: 400 });
    }

    const result = withDatabaseMutationLock(
      backupDirectory,
      () => updateContactIfCurrent(db, contactId, fields, expectedRevision)
    );
    if (result.status === 'not-found') {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }
    if (result.status === 'conflict') {
      return NextResponse.json({
        error: 'This contact changed after you opened it. Your draft has not been saved.',
        current_edit_revision: result.editRevision,
      }, { status: 409 });
    }

    return NextResponse.json({
      contact: {
        ...result.contact,
        edit_revision: result.editRevision,
      },
    });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ContactRevisionError) {
      return NextResponse.json({ error: error.message }, { status: 428 });
    }
    if (error instanceof ContactInputError || error instanceof SyntaxError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logRouteError('contacts.update_failed', error, request, '/api/contacts/[id]');
    return NextResponse.json({ error: 'Failed to update contact' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const contactId = parsePositiveInteger(id);
    if (!contactId) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    const result = deleteContactsWithRecovery(db, backupDirectory, [contactId], {
      retentionCount: getBackupRetentionCount(),
    });

    return NextResponse.json({
      success: true,
      affected: result.affected,
      alreadyDeleted: false,
      recoveryPoint: {
        filename: result.recoveryPoint.filename,
        createdAt: result.recoveryPoint.createdAt,
      },
    });
  } catch (error) {
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ContactDeletionError) {
      if (error.code === 'not_found') {
        return NextResponse.json({ success: true, affected: 0, alreadyDeleted: true });
      }
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }
    logRouteError('contacts.delete_failed', error, request, '/api/contacts/[id]');
    return NextResponse.json({ error: 'Failed to delete contact' }, { status: 500 });
  }
}
