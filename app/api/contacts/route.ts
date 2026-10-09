import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { ContactInputError, normalizeContactCreateInput } from '@/lib/contact-input';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { logRouteError } from '@/lib/observability';
import {
  listContactPage,
  listMentionOptions,
  listTagSummaries,
} from '@/lib/contact-directory';
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

type ContactRow = { id: number } & Record<string, unknown>;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const view = searchParams.get('view') || 'page';
    if (view === 'mentions') {
      return NextResponse.json({
        contacts: listMentionOptions(db, {
          search: searchParams.get('search'),
          limit: searchParams.get('limit'),
        }),
      });
    }
    if (view === 'tags') {
      return NextResponse.json(listTagSummaries(db, {
        page: searchParams.get('page'),
        pageSize: searchParams.get('pageSize'),
      }));
    }
    if (view !== 'page') {
      return NextResponse.json({ error: 'Unsupported contacts view.' }, { status: 400 });
    }

    const result = listContactPage(db, {
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
      search: searchParams.get('search'),
      tag: searchParams.get('tag'),
    });
    const overallTotal = Number(db.prepare('SELECT COUNT(*) AS count FROM contacts').pluck().get());
    return NextResponse.json({ ...result, overallTotal });
  } catch (error) {
    logRouteError('contacts.load_failed', error, request, '/api/contacts');
    return NextResponse.json({ error: 'Failed to fetch contacts' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const contactInput = normalizeContactCreateInput(await readJsonBody(request));
    const idempotencyKey = requireIdempotencyKey(request.headers);

    const stmt = db.prepare(`
      INSERT INTO contacts (
        name, nickname, email, phone, photo_url, birthday, birthday_reminder_days, how_we_met,
        tags, notes, gift_ideas, custom_fields, contact_frequency, contact_methods
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = withDatabaseMutationLock(backupDirectory, () => {
      return runIdempotentCreate(db, {
        scope: 'contacts-create',
        idempotencyKey,
        fingerprint: fingerprintIdempotencyInput(contactInput),
        create: () => {
          const insert = stmt.run(
            contactInput.name,
            contactInput.nickname,
            contactInput.email,
            contactInput.phone,
            contactInput.photo_url,
            contactInput.birthday,
            contactInput.birthday_reminder_days,
            contactInput.how_we_met,
            contactInput.tags,
            contactInput.notes,
            contactInput.gift_ideas,
            contactInput.custom_fields,
            contactInput.contact_frequency,
            contactInput.contact_methods ?? '[]'
          );
          return db.prepare('SELECT * FROM contacts WHERE id = ?')
            .get(insert.lastInsertRowid) as ContactRow;
        },
        load: (resourceId) => db.prepare('SELECT * FROM contacts WHERE id = ?')
          .get(resourceId) as ContactRow | undefined,
      });
    });

    return NextResponse.json(
      { contact: result.resource },
      { status: 201, headers: { 'Idempotency-Replayed': String(result.replayed) } }
    );
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof IdempotencyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ContactInputError || error instanceof SyntaxError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logRouteError('contacts.create_failed', error, request, '/api/contacts');
    return NextResponse.json({ error: 'Failed to create contact' }, { status: 500 });
  }
}
