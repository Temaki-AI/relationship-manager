import { NextResponse } from 'next/server';
import db from '@/lib/db';
import type { Contact } from '@/lib/db';
import {
  CONTACT_CSV_HEADERS,
  createTextExportStream,
  serializeContactToCSVRow,
} from '@/lib/contact-export';
import { logRouteError } from '@/lib/observability';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const contacts = db
      .prepare('SELECT * FROM contacts ORDER BY name, id')
      .iterate() as Iterator<Contact>;
    const csvStream = createTextExportStream(contacts, {
      prefix: CONTACT_CSV_HEADERS.join(','),
      separator: '\n',
      serialize: serializeContactToCSVRow,
      onError: (error) => logRouteError(
        'csv.export_failed',
        error,
        request,
        '/api/export/csv'
      ),
    });

    return new NextResponse(csvStream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="everclose-contacts-${new Date().toISOString().split('T')[0]}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    logRouteError('csv.export_failed', error, request, '/api/export/csv');
    return NextResponse.json({ error: 'Failed to export CSV' }, { status: 500 });
  }
}
