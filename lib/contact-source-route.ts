import db, { backupDirectory } from '@/lib/db';
import { createLinkedInSource, changeContactSource, listContactSources, contactSourceWriteEpoch } from '@/lib/contact-source-storage';
import { ContactSourceError } from '@/packages/domain/src/contact-sources';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { IdempotencyError, requireIdempotencyKey } from '@/lib/idempotency';
import { ContactRevisionError } from '@/lib/contact-revision';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { DatabaseMaintenanceBusyError, withDatabaseMutationLock } from '@/lib/database-maintenance-lock';
import { parsePositiveInteger } from '@/lib/relationship-validation';

export async function handleLocalSourceRequest(request: Request, person?: string, source?: string) {
  try {
    const contactId = person === undefined ? null : parsePositiveInteger(person);
    if (person !== undefined && !contactId) throw new ContactSourceError('Person not found.', 404);
    if (source !== undefined && !isSyncUuid(source)) throw new ContactSourceError('Source not found.', 404);
    if (request.method === 'GET' && contactId === null) return Response.json({ mode: 'local', epoch: withDatabaseMutationLock(backupDirectory, () => contactSourceWriteEpoch(db)) }, { headers: { 'Cache-Control': 'no-store' } });
    if (request.method === 'GET' && contactId) return Response.json(listContactSources(db, contactId), { headers: { 'Cache-Control': 'no-store' } });
    const body = await readJsonBody<Record<string, unknown>>(request, { maximumBytes: 16384 });
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ContactSourceError('Source details are required.');
    if (contactId === null && request.method === 'POST') {
      if (!isSyncUuid(body.expected_epoch)) throw new ContactSourceError('Refresh the connection form before saving.');
      const key = requireIdempotencyKey(request.headers);
      const result = withDatabaseMutationLock(backupDirectory, () => createLinkedInSource(db, body, key));
      return Response.json(result, { status: result.replayed ? 200 : 201 });
    }
    if (contactId && source && ['PATCH', 'DELETE'].includes(request.method)) {
      return Response.json(withDatabaseMutationLock(backupDirectory, () => changeContactSource(db, contactId, source, body, request.method === 'DELETE')));
    }
    return Response.json({ error: 'Unsupported source request.' }, { status: 405 });
  } catch (error) {
    if (error instanceof ContactSourceError || error instanceof IdempotencyError || error instanceof RequestBodyError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof ContactRevisionError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof DatabaseMaintenanceBusyError) return Response.json({ error: error.message }, { status: 409 });
    const message = error instanceof Error ? error.message : '';
    if (message.includes('SOURCE_LINK_LIMIT')) return Response.json({ error: 'This person has reached the 32-source limit.' }, { status: 409 });
    console.error('contact.source.failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    return Response.json({ error: 'Unable to save source details. Your draft is still here.' }, { status: 500 });
  }
}
