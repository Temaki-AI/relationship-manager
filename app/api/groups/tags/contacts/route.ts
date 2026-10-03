import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import {
  addTagToContacts,
  ContactDirectoryError,
  listTagContacts,
} from '@/lib/contact-directory';
import { logRouteError } from '@/lib/observability';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMutationLock,
} from '@/lib/database-maintenance-lock';

export function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const membership = searchParams.get('membership');
    return NextResponse.json(listTagContacts(db, {
      tag: searchParams.get('tag'),
      membership: membership === 'available' ? 'available' : 'members',
      search: searchParams.get('search'),
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
    }));
  } catch (error) {
    if (error instanceof ContactDirectoryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logRouteError('tag_group_contacts.load_failed', error, request, '/api/groups/tags/contacts');
    return NextResponse.json({ error: 'Failed to fetch group contacts.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const affected = withDatabaseMutationLock(
      backupDirectory,
      () => addTagToContacts(db, body.tag, body.contactIds)
    );
    return NextResponse.json({ affected });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ContactDirectoryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logRouteError('tag_group_contacts.add_failed', error, request, '/api/groups/tags/contacts');
    return NextResponse.json({ error: 'Failed to add contacts to the group.' }, { status: 500 });
  }
}
