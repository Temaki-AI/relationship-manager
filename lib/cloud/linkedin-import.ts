import type { Contact } from '@/lib/db';
import { ContactSourceError } from '@/packages/domain/src/contact-sources';
import { linkedInObservation, linkedInTarget, linkedInImportInput, linkedInImportPatch, linkedInPersonSummary, validateLinkedInImportTarget } from '@/lib/linkedin-import';
import { sourceProjection, type StoredContactSource } from '@/lib/contact-source-storage';
import { fingerprintIdempotencyInput, IdempotencyError, requireIdempotencyKey } from '@/lib/idempotency';
import { EDITABLE_CONTACT_FIELDS } from '@/lib/contact-revision';
import { maintenanceGuard, removeGuard } from './recovery-storage';
import { readCloudObject } from './request';
type DB = CloudflareEnv['DB'];
async function state(db: DB, workspace: string) {
  const value = await db.prepare('SELECT epoch, paused FROM workspace_sync_state WHERE workspace_id = ?').bind(workspace).first<{ epoch: string; paused: number }>();
  if (!value || value.paused) throw new ContactSourceError('Your data is under maintenance. Try again after recovery completes.', 409); return value;
}
async function sourceFor(db: DB, workspace: string, url: string) {
  return db.prepare("SELECT * FROM contact_source_links WHERE workspace_id = ? AND provider = 'linkedin' AND account_key = 'user_provided' AND external_id = ?").bind(workspace, url).first<StoredContactSource>();
}
async function personFor(db: DB, workspace: string, id: number | null) {
  return id === null ? null : db.prepare('SELECT * FROM contacts WHERE workspace_id = ? AND id = ?').bind(workspace, id).first<Contact>();
}
async function replay(db: DB, workspace: string, key: string, fingerprint: string) {
  const receipt = await db.prepare("SELECT fingerprint, resource_id FROM mutation_receipts WHERE workspace_id = ? AND scope = 'linkedin-export' AND request_key = ?").bind(workspace, key).first<{ fingerprint: string; resource_id: number }>();
  if (!receipt) return null;
  if (receipt.fingerprint !== fingerprint) throw new IdempotencyError('This request key belongs to different LinkedIn row choices.', 409);
  const source = await db.prepare(`SELECT source.* FROM contact_source_links source JOIN contacts person ON person.id = source.contact_id AND person.workspace_id = source.workspace_id
    WHERE source.workspace_id = ? AND source.id = ?`).bind(workspace, receipt.resource_id).first<StoredContactSource>();
  if (!source) throw new ContactSourceError('The saved source or person was removed. An uncertain old request cannot recreate it.', 409);
  return Response.json({ contact_id: source.contact_id, source: sourceProjection(source), replayed: true }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function handleCloudLinkedInImport(request: Request, db: DB, workspace: string, preview: boolean) {
  const body = await readCloudObject(request), current = await state(db, workspace);
  if (preview) {
    const input = linkedInObservation(body), targetId = linkedInTarget(body), source = await sourceFor(db, workspace, input.profile_url), target = await personFor(db, workspace, targetId);
    if (targetId !== null && !target) throw new ContactSourceError('Person not found.', 404);
    const linked = source ? await personFor(db, workspace, source.contact_id) : null;
    const matches = (await db.prepare(`SELECT id, name, email FROM contacts c WHERE workspace_id = ? AND (lower(trim(name)) = lower(?) OR (? IS NOT NULL AND
      (lower(trim(email)) = lower(?) OR EXISTS (SELECT 1 FROM json_each(c.contact_methods) WHERE json_extract(value, '$.kind') = 'email' AND lower(trim(json_extract(value, '$.value'))) = lower(?)))))
      ORDER BY name, id LIMIT 51`).bind(workspace, input.fields.name ?? '', input.fields.email ?? null, input.fields.email ?? null, input.fields.email ?? null).all<{ id: number; name: string; email: string | null }>()).results;
    return Response.json({ epoch: current.epoch, source: source ? sourceProjection(source) : null, linked_person: linked ? linkedInPersonSummary(linked) : null,
      target: target ? linkedInPersonSummary(target) : null, matches: matches.slice(0, 50), more_matches: matches.length > 50 }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const input = linkedInImportInput(body), key = requireIdempotencyKey(request.headers), fingerprint = fingerprintIdempotencyInput(input);
  if (current.epoch !== input.expected_epoch) throw new ContactSourceError('Your data was restored. Refresh before importing this row.', 409);
  const previous = await replay(db, workspace, key, fingerprint); if (previous) return previous;
  const source = await sourceFor(db, workspace, input.profile_url), person = await personFor(db, workspace, input.contact_id);
  validateLinkedInImportTarget(input, source, person);
  const patch = linkedInImportPatch(input, source, person), owner = crypto.randomUUID(), token = crypto.randomUUID(), now = new Date().toISOString();
  const sameReceipt = "EXISTS (SELECT 1 FROM mutation_receipts WHERE workspace_id = ? AND scope = 'linkedin-export' AND request_key = ? AND fingerprint = ?)";
  const ownReceipt = "EXISTS (SELECT 1 FROM mutation_receipts WHERE workspace_id = ? AND scope = 'linkedin-export' AND request_key = ? AND owner_token = ?)";
  const guards: string[] = [], values: Array<string | number | null> = [];
  if (person) { guards.push(`EXISTS (SELECT 1 FROM contacts WHERE workspace_id = ? AND id = ? AND ${EDITABLE_CONTACT_FIELDS.map((field) => `${field} IS ?`).join(' AND ')})`); values.push(workspace, person.id, ...EDITABLE_CONTACT_FIELDS.map((field) => person[field] ?? null)); }
  if (source) { guards.push('EXISTS (SELECT 1 FROM contact_source_links WHERE workspace_id = ? AND id = ? AND revision = ? AND contact_id = ? AND fields IS ?)'); values.push(workspace, source.id, source.revision, source.contact_id, source.fields); }
  else { guards.push("NOT EXISTS (SELECT 1 FROM contact_source_links WHERE workspace_id = ? AND provider = 'linkedin' AND account_key = 'user_provided' AND external_id = ?)"); values.push(workspace, input.profile_url); }
  await db.batch([
    maintenanceGuard(db, token, `EXISTS (SELECT 1 FROM workspace_sync_state WHERE workspace_id = ? AND epoch = ? AND paused = 0) AND (${sameReceipt} OR (${guards.join(' AND ')}))`,
      [workspace, input.expected_epoch, workspace, key, fingerprint, ...values]),
    db.prepare("INSERT INTO mutation_receipts (workspace_id, scope, request_key, fingerprint, owner_token) VALUES (?, 'linkedin-export', ?, ?, ?) ON CONFLICT(workspace_id, scope, request_key) DO NOTHING").bind(workspace, key, fingerprint, owner),
    person ? db.prepare(`UPDATE contacts SET name = ?, email = ?, contact_methods = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND ${ownReceipt}`)
      .bind(patch.name, patch.email, patch.methods, now, workspace, person.id, workspace, key, owner)
      : db.prepare(`INSERT INTO contacts (workspace_id, public_id, name, email, contact_methods, contact_frequency) SELECT ?, ?, ?, ?, ?, 14 WHERE ${ownReceipt}`)
        .bind(workspace, key, patch.name, patch.email, patch.methods, workspace, key, owner),
    source ? db.prepare(`UPDATE contact_source_links SET fields = ?, revision = revision + 1, observed_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND ${ownReceipt}`)
      .bind(patch.fields, now, now, workspace, source.id, workspace, key, owner)
      : db.prepare(`INSERT INTO contact_source_links (workspace_id, public_id, contact_id, provider, account_key, external_id, profile_url, origin, fields, revision, observed_at, created_at, updated_at)
        SELECT ?, ?, c.id, 'linkedin', 'user_provided', ?, ?, 'user_provided', ?, 1, ?, ?, ? FROM contacts c WHERE c.workspace_id = ? AND ${person ? 'c.id' : 'c.public_id'} = ? AND ${ownReceipt}`)
        .bind(workspace, key, input.profile_url, input.profile_url, patch.fields, now, now, now, workspace, person?.id ?? key, workspace, key, owner),
    db.prepare(`UPDATE mutation_receipts SET resource_id = (SELECT id FROM contact_source_links WHERE workspace_id = ? AND public_id = ?)
      WHERE workspace_id = ? AND scope = 'linkedin-export' AND request_key = ? AND owner_token = ?`).bind(workspace, source?.public_id ?? key, workspace, key, owner),
    removeGuard(db, token),
  ]);
  const result = await replay(db, workspace, key, fingerprint); if (!result) throw new ContactSourceError('The row was not confirmed. Retry the same saved choices.', 409);
  const receipt = await db.prepare("SELECT owner_token FROM mutation_receipts WHERE workspace_id = ? AND scope = 'linkedin-export' AND request_key = ?").bind(workspace, key).first<{ owner_token: string }>();
  const data = await result.json() as Record<string, unknown>; data.replayed = receipt?.owner_token !== owner;
  return Response.json(data, { status: source || data.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } });
}
