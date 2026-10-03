import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { importVCardContacts } from '@/lib/contact-import';
import {
  getMaxContactImportBytes,
  getMaxContactImportMegabytes,
  MAX_CONTACT_IMPORT_RECORDS,
} from '@/lib/contact-import-config';
import { parseVCards, VCardValidationError } from '@/lib/vcard';
import { MULTIPART_OVERHEAD_BYTES, readFormDataBody, RequestBodyError } from '@/lib/request-body';
import { logRouteError } from '@/lib/observability';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMutationLock,
} from '@/lib/database-maintenance-lock';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const maximumBytes = getMaxContactImportBytes();
    const formData = await readFormDataBody(request, {
      maximumBytes: maximumBytes + MULTIPART_OVERHEAD_BYTES,
      sizeLimitMessage: `Contact imports are limited to ${getMaxContactImportMegabytes()} MB`,
    });
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No vCard file provided' }, { status: 400 });
    }
    if (file.size > maximumBytes) {
      return NextResponse.json(
        { error: `Contact imports are limited to ${getMaxContactImportMegabytes()} MB` },
        { status: 413 }
      );
    }

    const contacts = parseVCards(await file.text());
    if (contacts.length > MAX_CONTACT_IMPORT_RECORDS) {
      return NextResponse.json(
        { error: `Contact imports are limited to ${MAX_CONTACT_IMPORT_RECORDS.toLocaleString()} contacts at a time` },
        { status: 413 }
      );
    }

    const result = withDatabaseMutationLock(
      backupDirectory,
      () => importVCardContacts(db, contacts)
    );
    return NextResponse.json(
      { ...result, total: contacts.length },
      { status: result.imported > 0 ? 201 : 200 }
    );
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof VCardValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logRouteError('vcard.import_failed', error, request, '/api/import/vcard');
    return NextResponse.json({ error: 'Failed to import vCard contacts' }, { status: 500 });
  }
}
