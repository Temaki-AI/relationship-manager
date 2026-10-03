import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import {
  ContactConnectionInputError,
  listContactRelationshipsPage,
  normalizeRelationshipLabels,
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

class DuplicateRelationshipError extends Error {}

type RelationshipRow = {
  id: number;
  contact_id: number;
  related_contact_id: number;
  relationship_label: string;
  reciprocal_label: string;
  created_at: string;
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
    return NextResponse.json(listContactRelationshipsPage(db, contactId, {
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
    }));
  } catch (error) {
    logRouteError('contact_relationships.load_failed', error, request, '/api/contacts/[id]/relationships');
    return NextResponse.json({ error: 'Failed to load contact relationships' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const contactId = parsePositiveInteger(id);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const relatedContactId = parsePositiveInteger(body.related_contact_id);
    if (!contactId || !relatedContactId) {
      return NextResponse.json({ error: 'Choose a valid contact to connect.' }, { status: 400 });
    }
    if (contactId === relatedContactId) {
      return NextResponse.json({ error: 'A contact cannot be connected to themselves.' }, { status: 400 });
    }
    const labels = normalizeRelationshipLabels(body);
    const idempotencyKey = requireIdempotencyKey(request.headers);
    const input = { contactId, relatedContactId, ...labels };

    const result = withDatabaseMutationLock(backupDirectory, () => runIdempotentCreate(db, {
      scope: `contact-relationships-create:${contactId}`,
      idempotencyKey,
      fingerprint: fingerprintIdempotencyInput(input),
      create: () => {
        const contacts = Number(db.prepare(`
          SELECT COUNT(*) FROM contacts WHERE id IN (?, ?)
        `).pluck().get(contactId, relatedContactId));
        if (contacts !== 2) return null;
        const existing = db.prepare(`
          SELECT id FROM contact_relationships
          WHERE (contact_id = ? AND related_contact_id = ?)
             OR (contact_id = ? AND related_contact_id = ?)
        `).get(contactId, relatedContactId, relatedContactId, contactId);
        if (existing) throw new DuplicateRelationshipError();

        const insert = db.prepare(`
          INSERT INTO contact_relationships (
            contact_id, related_contact_id, relationship_label, reciprocal_label
          ) VALUES (?, ?, ?, ?)
        `).run(contactId, relatedContactId, labels.relationshipLabel, labels.reciprocalLabel);
        return db.prepare('SELECT * FROM contact_relationships WHERE id = ?')
          .get(insert.lastInsertRowid) as RelationshipRow;
      },
      load: (resourceId) => db.prepare('SELECT * FROM contact_relationships WHERE id = ?')
        .get(resourceId) as RelationshipRow | undefined,
    }));
    if (!result.resource) {
      return NextResponse.json({ error: 'One of these contacts no longer exists.' }, { status: 404 });
    }
    return NextResponse.json(
      { relationship: result.resource },
      { status: 201, headers: { 'Idempotency-Replayed': String(result.replayed) } }
    );
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ContactConnectionInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DuplicateRelationshipError) {
      return NextResponse.json({ error: 'These contacts are already connected.' }, { status: 409 });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof IdempotencyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logRouteError('contact_relationships.create_failed', error, request, '/api/contacts/[id]/relationships');
    return NextResponse.json({ error: 'Failed to connect contacts' }, { status: 500 });
  }
}
