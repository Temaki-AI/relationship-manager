import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import {
  ContactConnectionInputError,
  listContactChildrenPage,
  normalizeChildInput,
  validateChildLink,
} from '@/lib/contact-connections';
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
import { logRouteError } from '@/lib/observability';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { parsePositiveInteger } from '@/lib/relationship-validation';

type ChildRow = {
  id: number;
  contact_id: number;
  linked_contact_id: number | null;
  name: string;
  birthday: string | null;
  created_at: string;
  updated_at: string;
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const contactId = parsePositiveInteger(id);
    if (!contactId || !db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(contactId)) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }
    const { searchParams } = new URL(request.url);
    return NextResponse.json(listContactChildrenPage(db, contactId, {
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
    }));
  } catch (error) {
    logRouteError('contact_children.load_failed', error, request, '/api/contacts/[id]/children');
    return NextResponse.json({ error: 'Failed to load children' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const contactId = parsePositiveInteger(id);
    if (!contactId) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    const childInput = normalizeChildInput(await readJsonBody(request));
    const idempotencyKey = requireIdempotencyKey(request.headers);
    const input = { contactId, ...childInput };

    const result = withDatabaseMutationLock(backupDirectory, () => runIdempotentCreate(db, {
      scope: `contact-children-create:${contactId}`,
      idempotencyKey,
      fingerprint: fingerprintIdempotencyInput(input),
      create: () => {
        if (!db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(contactId)) return null;
        if (childInput.linked_contact_id !== null) {
          const linked = db.prepare('SELECT birthday FROM contacts WHERE id = ?').get(childInput.linked_contact_id) as { birthday: string | null } | undefined;
          if (!linked) throw new ContactConnectionInputError('Linked profile not found.');
          validateChildLink(contactId, childInput.birthday, childInput.linked_contact_id, linked.birthday);
        }
        const insert = db.prepare(`
          INSERT INTO contact_children (contact_id, linked_contact_id, name, birthday)
          VALUES (?, ?, ?, ?)
        `).run(contactId, childInput.linked_contact_id, childInput.name, childInput.birthday);
        return db.prepare('SELECT * FROM contact_children WHERE id = ?')
          .get(insert.lastInsertRowid) as ChildRow;
      },
      load: (resourceId) => db.prepare('SELECT * FROM contact_children WHERE id = ?')
        .get(resourceId) as ChildRow | undefined,
    }));
    if (!result.resource) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    return NextResponse.json(
      { child: result.resource },
      { status: 201, headers: { 'Idempotency-Replayed': String(result.replayed) } }
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: contact_children.contact_id, contact_children.linked_contact_id')) {
      return NextResponse.json({ error: 'This child profile is already linked to this contact.' }, { status: 409 });
    }
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ContactConnectionInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof IdempotencyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logRouteError('contact_children.create_failed', error, request, '/api/contacts/[id]/children');
    return NextResponse.json({ error: 'Failed to add child' }, { status: 500 });
  }
}
