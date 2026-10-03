import db from '@/lib/db';
import { embeddedContactPhotoResponse } from '@/lib/contact-photo-response';
import { parsePositiveInteger } from '@/lib/relationship-validation';
import { logRouteError } from '@/lib/observability';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const id = parsePositiveInteger((await params).id);
  if (!id) return new Response(null, { status: 404 });
  try {
    const row = db.prepare('SELECT photo_url FROM contacts WHERE id = ?')
      .get(id) as { photo_url: string | null } | undefined;
    return embeddedContactPhotoResponse(row?.photo_url) || new Response(null, { status: 404 });
  } catch (error) {
    logRouteError('contacts.photo_failed', error, request, '/api/contacts/[id]/photo');
    return new Response(null, { status: 500 });
  }
}
