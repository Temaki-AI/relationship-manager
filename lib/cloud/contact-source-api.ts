import { getCloudflareContext } from '@opennextjs/cloudflare';
import { sourceCreateInput, sourceChangeFields, sourceExpectedRevision, SOURCE_STALE_MESSAGE } from '@/lib/contact-source-input';
import { sourceProjection, type StoredContactSource } from '@/lib/contact-source-storage';
import { ContactSourceError, observeSourceFacts, readSourceFacts } from '@/packages/domain/src/contact-sources';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { fingerprintIdempotencyInput, IdempotencyError, requireIdempotencyKey } from '@/lib/idempotency';
import { getContactEditRevision, getExpectedContactRevision, EDITABLE_CONTACT_FIELDS, ContactRevisionError } from '@/lib/contact-revision';
import type { Contact } from '@/lib/db';
import { parsePositiveInteger } from '@/lib/relationship-validation';
import { RequestBodyError } from '@/lib/request-body';
import { readCloudObject } from '@/lib/cloud/request';
import { maintenanceGuard, removeGuard } from '@/lib/cloud/recovery-storage';
import { recoveryErrorResponse } from '@/lib/cloud/recovery-contract';
import { handleCloudLinkedInImport } from './linkedin-import';
import { ContactMethodError } from '@/packages/domain/src/contact-methods';

type DB = CloudflareEnv['DB'];
async function create(request: Request, db: DB, workspaceId: string) {
  const input = sourceCreateInput(await readCloudObject(request)), key = requireIdempotencyKey(request.headers);
  if (!input.expected_epoch) throw new ContactSourceError('Refresh the connection form before saving.');
  const state = await db.prepare('SELECT epoch, paused FROM workspace_sync_state WHERE workspace_id = ?').bind(workspaceId).first<{ epoch: string; paused: number }>();
  if (!state || state.paused || state.epoch !== input.expected_epoch) throw new ContactSourceError('This dataset changed. Refresh before creating or linking a person.', 409);
  const fingerprint = fingerprintIdempotencyInput(input), owner = crypto.randomUUID(), now = new Date().toISOString();
  const guardToken = crypto.randomUUID();
  const facts = readSourceFacts(observeSourceFacts('{}', input.observations));
  if (input.contact_id === null) facts.name!.applied_value = input.observations.name!;
  const results = await db.batch([
    maintenanceGuard(db, guardToken, 'EXISTS (SELECT 1 FROM workspace_sync_state WHERE workspace_id = ? AND epoch = ? AND paused = 0)', [workspaceId, input.expected_epoch]),
    db.prepare(`INSERT INTO mutation_receipts (workspace_id, scope, request_key, fingerprint, owner_token)
      VALUES (?, 'contact-source', ?, ?, ?) ON CONFLICT(workspace_id, scope, request_key) DO NOTHING`).bind(workspaceId, key, fingerprint, owner),
    db.prepare(`INSERT INTO contacts (workspace_id, public_id, name, contact_frequency)
      SELECT ?, ?, ?, 14 WHERE ? IS NULL AND EXISTS (SELECT 1 FROM mutation_receipts WHERE workspace_id = ? AND scope = 'contact-source' AND request_key = ? AND owner_token = ?)`)
      .bind(workspaceId, key, input.observations.name ?? '', input.contact_id, workspaceId, key, owner),
    db.prepare(`INSERT INTO contact_source_links (workspace_id, public_id, contact_id, provider, account_key, external_id, profile_url, origin, fields, revision, observed_at, created_at, updated_at)
      SELECT ?, ?, c.id, 'linkedin', 'user_provided', ?, ?, 'user_provided', ?, 1, ?, ?, ? FROM contacts c
      WHERE c.workspace_id = ? AND (c.id = ? OR ? IS NULL AND c.public_id = ?)
        AND EXISTS (SELECT 1 FROM mutation_receipts WHERE workspace_id = ? AND scope = 'contact-source' AND request_key = ? AND owner_token = ?)`)
      .bind(workspaceId, key, input.profile_url, input.profile_url, JSON.stringify(facts), now, now, now, workspaceId, input.contact_id, input.contact_id, key, workspaceId, key, owner),
    db.prepare(`UPDATE mutation_receipts SET resource_id = (SELECT id FROM contact_source_links WHERE workspace_id = ? AND public_id = ?)
      WHERE workspace_id = ? AND scope = 'contact-source' AND request_key = ? AND owner_token = ?`).bind(workspaceId, key, workspaceId, key, owner),
    db.prepare(`SELECT fingerprint, owner_token FROM mutation_receipts WHERE workspace_id = ? AND scope = 'contact-source' AND request_key = ?`).bind(workspaceId, key),
    db.prepare(`SELECT link.* FROM contact_source_links link JOIN mutation_receipts receipt ON receipt.workspace_id = link.workspace_id AND receipt.resource_id = link.id
      WHERE receipt.workspace_id = ? AND receipt.scope = 'contact-source' AND receipt.request_key = ?`).bind(workspaceId, key),
    removeGuard(db, guardToken),
  ]);
  const receipt = results[5].results[0] as { fingerprint: string; owner_token: string };
  if (receipt.fingerprint !== fingerprint) throw new IdempotencyError('This request key was already used for different source details.', 409);
  const source = results[6].results[0] as StoredContactSource | undefined;
  if (!source) throw new ContactSourceError('The person or original source is no longer available. Refresh before making a new request.', 409);
  return Response.json({ contact_id: source.contact_id, source: sourceProjection(source), replayed: receipt.owner_token !== owner }, { status: receipt.owner_token === owner ? 201 : 200 });
}
async function personSources(request: Request, db: DB, workspaceId: string, contactId: number, publicId?: string) {
  const contact = await db.prepare('SELECT * FROM contacts WHERE workspace_id = ? AND id = ?').bind(workspaceId, contactId).first<Contact>();
  if (!contact) throw new ContactSourceError('Person not found.', 404);
  if (!publicId && request.method === 'GET') {
    const rows = (await db.prepare('SELECT * FROM contact_source_links WHERE workspace_id = ? AND contact_id = ? ORDER BY id').bind(workspaceId, contactId).all<StoredContactSource>()).results;
    return Response.json({ contact: { id: contactId, name: contact.name, edit_revision: getContactEditRevision(contact) }, sources: rows.map(sourceProjection) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!publicId || !isSyncUuid(publicId) || !['PATCH', 'DELETE'].includes(request.method)) return Response.json({ error: 'Unsupported source request.' }, { status: 405 });
  const body = await readCloudObject(request), expected = sourceExpectedRevision(body);
  const source = await db.prepare('SELECT * FROM contact_source_links WHERE workspace_id = ? AND contact_id = ? AND public_id = ?').bind(workspaceId, contactId, publicId).first<StoredContactSource>();
  if (!source) { if (request.method === 'DELETE') return Response.json({ success: true }); throw new ContactSourceError('Source not found.', 404); }
  if (source.revision !== expected) throw new ContactSourceError(SOURCE_STALE_MESSAGE, 409);
  const change = request.method === 'DELETE' ? null : sourceChangeFields(source.fields, body);
  if (change?.name !== null && change?.name !== undefined && getExpectedContactRevision(body) !== getContactEditRevision(contact)) throw new ContactSourceError(SOURCE_STALE_MESSAGE, 409);
  const token = crypto.randomUUID(), now = new Date().toISOString();
  const guardValues = [workspaceId, contactId, publicId, expected, source.fields];
  const namePredicate = change?.name ? ` AND EXISTS (SELECT 1 FROM contacts WHERE workspace_id = ? AND id = ? AND ${EDITABLE_CONTACT_FIELDS.map((field) => `${field} IS ?`).join(' AND ')})` : '';
  const results = await db.batch([
    maintenanceGuard(db, token, `EXISTS (SELECT 1 FROM contact_source_links WHERE workspace_id = ? AND contact_id = ? AND public_id = ? AND revision = ? AND fields IS ?)${namePredicate}`,
      [...guardValues, ...(change?.name ? [workspaceId, contactId, ...EDITABLE_CONTACT_FIELDS.map((field) => contact[field] ?? null)] : [])]),
    ...(change?.name ? [db.prepare('UPDATE contacts SET name = ?, updated_at = ? WHERE workspace_id = ? AND id = ?').bind(change.name, now, workspaceId, contactId)] : []),
    change ? db.prepare(`UPDATE contact_source_links SET fields = ?, revision = revision + 1, updated_at = ?, observed_at = CASE WHEN ? = 'observe' THEN ? ELSE observed_at END
      WHERE workspace_id = ? AND public_id = ? RETURNING *`).bind(change.fields, now, body.action, now, workspaceId, publicId)
      : db.prepare('DELETE FROM contact_source_links WHERE workspace_id = ? AND public_id = ? RETURNING id').bind(workspaceId, publicId),
    removeGuard(db, token),
  ]);
  return Response.json(change ? { source: sourceProjection(results.at(-2)!.results[0] as StoredContactSource) } : { success: true });
}
export async function handleCloudContactSources(request: Request, workspaceId: string, path: string[]) {
  try {
    const db = getCloudflareContext().env.DB;
    if (request.method === 'POST' && ['sources/linkedin/import', 'sources/linkedin/import/preview'].includes(path.join('/'))) return await handleCloudLinkedInImport(request, db, workspaceId, path.at(-1) === 'preview');
    if (path.join('/') === 'sources/context' && request.method === 'GET') {
      const state = await db.prepare('SELECT epoch, paused FROM workspace_sync_state WHERE workspace_id = ?').bind(workspaceId).first<{ epoch: string; paused: number }>();
      if (!state || state.paused) throw new ContactSourceError('This dataset is under maintenance. Try again when recovery completes.', 409);
      return Response.json({ mode: 'cloud', epoch: state.epoch }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (path.join('/') === 'sources/linkedin' && request.method === 'POST') return await create(request, db, workspaceId);
    const contactId = parsePositiveInteger(path[1]);
    if (path[0] === 'contacts' && contactId && path[2] === 'sources' && path.length <= 4) return await personSources(request, db, workspaceId, contactId, path[3]);
    return Response.json({ error: 'Source route not found.' }, { status: 404 });
  } catch (error) {
    if (error instanceof ContactSourceError || error instanceof IdempotencyError || error instanceof RequestBodyError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof ContactRevisionError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof ContactMethodError) return Response.json({ error: error.message }, { status: 400 });
    const message = error instanceof Error ? error.message : '';
    if (message.includes('CONTACT_SYNC_LIMIT')) return Response.json({ error: 'This person has reached the device-sync size limit. Shorten the profile or unlink an unused source.', code: 'contact_capacity' }, { status: 413 });
    if (message.includes('UNIQUE constraint failed: contact_source_links') || message.includes('SOURCE_LINK_LIMIT')) return Response.json({ error: 'This profile is already linked, or the person has reached the 32-source limit. Refresh the connections before adding it.' }, { status: 409 });
    const recovery = recoveryErrorResponse(error); if (recovery) return recovery;
    throw error;
  }
}
