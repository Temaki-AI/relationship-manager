import db, { backupDirectory } from '@/lib/db';
import { importLocalLinkedInRow, previewLocalLinkedInImport } from './linkedin-import';
import { ContactSourceError } from '@/packages/domain/src/contact-sources';
import { ContactMethodError } from '@/packages/domain/src/contact-methods';
import { IdempotencyError, requireIdempotencyKey } from './idempotency';
import { readJsonBody, RequestBodyError } from './request-body';
import { DatabaseMaintenanceBusyError, withDatabaseMutationLock } from './database-maintenance-lock';
export async function handleLocalLinkedInImport(request: Request, preview = false) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, { maximumBytes: 16384 });
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ContactSourceError('Review a Connections.csv row.');
    const key = preview ? null : requireIdempotencyKey(request.headers);
    const result = withDatabaseMutationLock(backupDirectory, () => preview ? previewLocalLinkedInImport(db, body) : importLocalLinkedInRow(db, body, key!));
    return Response.json(result, { status: !preview && 'replayed' in result && !result.replayed ? 201 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ContactSourceError || error instanceof IdempotencyError || error instanceof RequestBodyError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof ContactMethodError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof DatabaseMaintenanceBusyError) return Response.json({ error: error.message }, { status: 409 });
    const message = error instanceof Error ? error.message : '';
    if (message.includes('SOURCE_LINK_LIMIT') || message.includes('UNIQUE constraint failed')) return Response.json({ error: 'This source changed or reached its limit. Refresh while keeping your row choices.' }, { status: 409 });
    console.error('linkedin.import.failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    return Response.json({ error: 'The row was not confirmed. Retry the same choices.' }, { status: 500 });
  }
}
