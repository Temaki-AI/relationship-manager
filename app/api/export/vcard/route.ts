import { NextResponse } from 'next/server';
import db, { type Contact } from '@/lib/db';
import { createTextExportStream } from '@/lib/contact-export';
import { serializeContactToVCard } from '@/lib/vcard';
import { logRouteError } from '@/lib/observability';

export const runtime = 'nodejs';

export function GET(request: Request) {
  try {
    const contacts = db
      .prepare('SELECT * FROM contacts ORDER BY name, id')
      .iterate() as Iterator<Contact>;
    const vcardStream = createTextExportStream(contacts, {
      separator: '\r\n',
      suffix: '\r\n',
      serialize: serializeContactToVCard,
      onError: (error) => logRouteError(
        'vcard.export_failed',
        error,
        request,
        '/api/export/vcard'
      ),
    });
    return new NextResponse(vcardStream, {
      headers: {
        'Content-Type': 'text/vcard; charset=utf-8',
        'Content-Disposition': `attachment; filename="everclose-contacts-${new Date().toISOString().slice(0, 10)}.vcf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    logRouteError('vcard.export_failed', error, request, '/api/export/vcard');
    return NextResponse.json({ error: 'Failed to export vCard contacts' }, { status: 500 });
  }
}
