import { defaultProviderRules } from '@/packages/domain/src/provider-rules';
import { savedProviderRules } from './provider-field-controls';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { applyProviderMethods, providerMethodDraft } from '@/packages/domain/src/provider-import';
import { contactMethodIdentity, normalizeUserContactMethods, readContactMethods } from '@/packages/domain/src/contact-methods';
import { providerSourceProjection, ProviderSourceError, readAppliedProviderFields, readProviderFacts, type ProviderSource } from '@/packages/domain/src/provider-sources';
import { fingerprintIdempotencyInput, IdempotencyError } from '@/lib/idempotency';
import { EDITABLE_CONTACT_FIELDS, getContactEditRevision, getExpectedContactRevision } from '@/lib/contact-revision';
import type { Contact } from '@/lib/db';
import { googleConnectionAccess, providerGrantCondition, requireProviderOwner, type ConnectionActor } from './provider-connections';
import { maintenanceGuard, removeGuard } from './recovery-storage';
import type { ProviderEnvironment, ProviderFetch } from './google-provider';

type DB = CloudflareEnv['DB'];
type LinkRow = ProviderSource & { id: number; workspace_id: string; contact_id: number };
type IndexSource = { facts: string; observed_at: string; account_id: string; email: string; authorization_revision: number; dataset_epoch: string };
function activeSourceCondition() {
  return `EXISTS (SELECT 1 FROM provider_connections c JOIN provider_contact_resources r ON r.connection_id = c.id
    JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN workspaces w ON w.id = c.workspace_id
    JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id AND m.role = 'owner'
    WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.status = 'connected' AND c.purpose = 'contacts' AND c.dataset_epoch = ?
      AND c.authorization_revision = ? AND r.active_generation = ? AND r.authorization_revision = c.authorization_revision
      AND r.dataset_epoch = c.dataset_epoch AND s.epoch = c.dataset_epoch AND s.paused = 0 AND w.lifecycle = 'active')`;
}
async function source(db: DB, actor: ConnectionActor, connectionId: string, generation: unknown, sourceId: unknown) {
  await requireProviderOwner(db, actor);
  if (!isSyncUuid(connectionId) || !isSyncUuid(generation) || typeof sourceId !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(sourceId)) throw new ProviderSourceError('Refresh the downloaded Google contact before reviewing it.', 409);
  const row = await db.prepare(`SELECT i.facts, i.observed_at, c.account_id, c.email, c.authorization_revision, c.dataset_epoch
    FROM provider_contact_index i JOIN provider_connections c ON c.id = i.connection_id
    JOIN provider_contact_resources r ON r.connection_id = c.id JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id
    JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.status = 'connected' AND c.purpose = 'contacts'
      AND i.source_id = ? AND i.generation = ? AND r.active_generation = i.generation AND r.authorization_revision = c.authorization_revision
      AND r.dataset_epoch = c.dataset_epoch AND s.epoch = c.dataset_epoch AND s.paused = 0 AND w.lifecycle = 'active'
      AND (c.refresh_expires_at IS NULL OR c.refresh_expires_at > ?)`)
    .bind(connectionId, actor.workspaceId, actor.userId, sourceId, generation, Date.now()).first<IndexSource>();
  if (!row) throw new ProviderSourceError('The account or downloaded contact changed. Refresh this review before saving.', 409);
  return { ...row, factsRevision: fingerprintIdempotencyInput([generation, row.account_id, sourceId, row.facts]), factsValue: readProviderFacts(row.facts) };
}
function person(contact: Contact) {
  return { id: contact.id, name: contact.name, contact_methods: contact.contact_methods, edit_revision: getContactEditRevision(contact) };
}
export async function googleImportPreview(db: DB, actor: ConnectionActor, connectionId: string, query: URLSearchParams) {
  const generation = query.get('generation'), sourceId = query.get('source_id'), current = await source(db, actor, connectionId, generation, sourceId);
  const search = query.get('q') || '', targetId = query.get('contact_id');
  if (search.length > 200 || /[\u0000-\u001f\u007f]/.test(search) || targetId && !/^[1-9]\d{0,14}$/.test(targetId)) throw new ProviderSourceError('Use a valid person search.', 400);
  const linked = await db.prepare(`SELECT l.contact_id, c.name FROM contact_provider_links l JOIN contacts c ON c.id = l.contact_id AND c.workspace_id = l.workspace_id
    WHERE l.workspace_id = ? AND l.provider = 'google' AND l.account_key = ? AND l.external_id = ?`).bind(actor.workspaceId, current.account_id, sourceId).first<{ contact_id: number; name: string }>();
  const identities = new Set<string>(), emails: string[] = [], phones: string[] = [];
  for (const kind of ['email', 'phone'] as const) for (const [index] of (kind === 'email' ? current.factsValue.emails : current.factsValue.phones).entries()) {
    try {
      const draft = { ...providerMethodDraft(current.factsValue, kind, index, crypto.randomUUID()), label: null };
      const method = readContactMethods(normalizeUserContactMethods([draft]))[0]; identities.add(contactMethodIdentity(method));
      if (kind === 'email') emails.push(method.value.trim().toLowerCase());
      else if (method.value.startsWith('+')) phones.push(method.value.replace(/[ ()\-.]/g, ''));
    } catch { /* An invalid provider method remains visible for review, but is not identity evidence. */ }
  }
  const candidates = (await db.prepare(`SELECT c.* FROM contacts c WHERE c.workspace_id = ? AND EXISTS (SELECT 1 FROM json_each(c.contact_methods) m
    WHERE json_extract(m.value, '$.kind') = 'email' AND lower(trim(json_extract(m.value, '$.value'))) IN (SELECT value FROM json_each(?))
      OR json_extract(m.value, '$.kind') = 'phone' AND replace(replace(replace(replace(replace(json_extract(m.value, '$.value'), ' ', ''), '(', ''), ')', ''), '-', ''), '.', '') IN (SELECT value FROM json_each(?)))
    ORDER BY c.name, c.id LIMIT 51`).bind(actor.workspaceId, JSON.stringify(emails), JSON.stringify(phones)).all<Contact>()).results;
  const matches = candidates.filter((c: Contact) => readContactMethods(c.contact_methods).some((method) => identities.has(contactMethodIdentity(method)))).slice(0, 10).map(person);
  const pattern = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
  const people = search ? (await db.prepare("SELECT * FROM contacts WHERE workspace_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY name, id LIMIT 20").bind(actor.workspaceId, pattern).all<Contact>()).results.map(person) : [];
  const target = targetId ? await db.prepare('SELECT * FROM contacts WHERE workspace_id = ? AND id = ?').bind(actor.workspaceId, Number(targetId)).first<Contact>() : null;
  if (targetId && !target) throw new ProviderSourceError('That person is no longer available.', 404);
  const guard = crypto.randomUUID();
  await db.batch([maintenanceGuard(db, guard, activeSourceCondition(), [connectionId, actor.workspaceId, actor.userId, current.dataset_epoch, current.authorization_revision, generation]), removeGuard(db, guard)]);
  return { epoch: current.dataset_epoch, generation, facts_revision: current.factsRevision, facts: current.factsValue,
    connection: { id: connectionId, email: current.email, authorization_revision: current.authorization_revision },
    linked_contact: linked ? { id: linked.contact_id, name: linked.name } : null, matches, people, target: target ? person(target) : null };
}
function selection(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((index) => !Number.isInteger(index) || index < 0 || index > 99)
    || new Set(value).size !== value.length) throw new ProviderSourceError('Choose each Google contact field only once.');
  return [...value].sort((a, b) => a - b);
}
function input(body: Record<string, unknown>) {
  const keys = ['expected_epoch', 'expected_authorization_revision', 'generation', 'source_id', 'facts_revision', 'contact_id', 'expected_edit_revision', 'create_name', 'use_name', 'emails', 'phones', 'keep_updated'];
  if (Object.keys(body).some((key) => !keys.includes(key)) || !isSyncUuid(body.expected_epoch) || !isSyncUuid(body.generation)
    || !Number.isSafeInteger(body.expected_authorization_revision) || Number(body.expected_authorization_revision) < 1
    || typeof body.source_id !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(body.source_id)
    || typeof body.facts_revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.facts_revision)
    || body.use_name !== undefined && typeof body.use_name !== 'boolean' || body.keep_updated !== undefined && typeof body.keep_updated !== 'boolean') throw new ProviderSourceError('Refresh this Google contact review before saving.');
  const contactId = body.contact_id ?? null;
  if (contactId !== null && (!Number.isSafeInteger(contactId) || Number(contactId) < 1)) throw new ProviderSourceError('Choose an existing person or create one.');
  const name = contactId === null ? typeof body.create_name === 'string' ? body.create_name.trim() : '' : null;
  if (contactId === null && (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name))
    || contactId !== null && body.create_name !== undefined && body.create_name !== null) throw new ProviderSourceError('Enter a name for the new person, up to 200 characters.');
  return { expected_epoch: body.expected_epoch, expected_authorization_revision: Number(body.expected_authorization_revision), generation: body.generation,
    source_id: body.source_id, facts_revision: body.facts_revision, contact_id: contactId as number | null,
    expected_edit_revision: contactId !== null ? getExpectedContactRevision(body) : null, create_name: name, use_name: body.use_name === true,
    emails: selection(body.emails), phones: selection(body.phones), ...(body.keep_updated === true ? { keep_updated: true } : {}) };
}
async function receipt(db: DB, actor: ConnectionActor, key: string, fingerprint: string) {
  const row = await db.prepare("SELECT fingerprint, resource_id FROM mutation_receipts WHERE workspace_id = ? AND scope = 'google-contact-import' AND request_key = ?").bind(actor.workspaceId, key).first<{ fingerprint: string; resource_id: number | null }>();
  if (!row) return null;
  if (row.fingerprint !== fingerprint) throw new IdempotencyError('This import request key was already used for different selections.', 409);
  const link = await db.prepare('SELECT * FROM contact_provider_links WHERE workspace_id = ? AND id = ?').bind(actor.workspaceId, row.resource_id).first<LinkRow>();
  if (!link) throw new ProviderSourceError('The original person or source is no longer available. Use a new review rather than replaying this import.', 409);
  return { contact_id: link.contact_id, source: providerSourceProjection(link), replayed: true };
}
export async function importGoogleContact(db: DB, actor: ConnectionActor, environment: ProviderEnvironment, connectionId: string,
  body: Record<string, unknown>, key: string, fetcher: ProviderFetch = fetch) {
  await requireProviderOwner(db, actor);
  if (!isSyncUuid(key) || !isSyncUuid(connectionId)) throw new ProviderSourceError('Use an import request UUID.');
  const data = input(body), fingerprint = fingerprintIdempotencyInput({ connection_id: connectionId, ...data });
  const epoch = await db.prepare("SELECT s.epoch FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id WHERE s.workspace_id = ? AND s.paused = 0 AND w.lifecycle = 'active'").bind(actor.workspaceId).first<{ epoch: string }>();
  if (epoch?.epoch !== data.expected_epoch) throw new ProviderSourceError('The dataset changed. Refresh this import review.', 409);
  const replayed = await receipt(db, actor, key, fingerprint); if (replayed) return replayed;
  const current = await source(db, actor, connectionId, data.generation, data.source_id);
  if (current.factsRevision !== data.facts_revision || current.authorization_revision !== data.expected_authorization_revision) throw new ProviderSourceError('The Google source changed. Refresh while keeping your selections.', 409);
  const linked = await db.prepare("SELECT id FROM contact_provider_links WHERE workspace_id = ? AND provider = 'google' AND account_key = ? AND external_id = ?").bind(actor.workspaceId, current.account_id, data.source_id).first();
  if (linked) { const raced = await receipt(db, actor, key, fingerprint); if (raced) return raced; throw new ProviderSourceError('This Google contact is already linked. Open its Everclose person or unlink the source there first.', 409); }
  const target = data.contact_id === null ? null : await db.prepare('SELECT * FROM contacts WHERE workspace_id = ? AND id = ?').bind(actor.workspaceId, data.contact_id).first<Contact>();
  if (data.contact_id !== null && (!target || getContactEditRevision(target) !== data.expected_edit_revision)) throw new ProviderSourceError('This person changed. Refresh its details; your import choices are still here.', 409);
  if (data.use_name && target && !current.factsValue.name) throw new ProviderSourceError('Google has no name to apply. Keep the current name.');
  const values = applyProviderMethods(current.factsValue, data, target?.contact_methods ?? '[]', () => crypto.randomUUID());
  const name = target ? data.use_name ? current.factsValue.name! : target.name : data.create_name!;
  const applied = JSON.stringify({ name: target ? data.use_name ? name : null : name === current.factsValue.name ? name : null, methods: values.applied }); readAppliedProviderFields(applied);
  const grant = await googleConnectionAccess(db, actor, environment, connectionId, data.expected_epoch, fetcher);
  if (grant.authorizationRevision !== data.expected_authorization_revision) throw new ProviderSourceError('The Google authorization changed. Refresh this import review.', 409);
  const owner = crypto.randomUUID(), guard = crypto.randomUUID(), now = new Date().toISOString();
  const own = "EXISTS (SELECT 1 FROM mutation_receipts WHERE workspace_id = ? AND scope = 'google-contact-import' AND request_key = ? AND owner_token = ?)";
  const predicate = providerGrantCondition(grant);
  const targetGuard = target ? ` AND EXISTS (SELECT 1 FROM contacts WHERE workspace_id = ? AND id = ? AND ${EDITABLE_CONTACT_FIELDS.map((field) => `${field} IS ?`).join(' AND ')})` : '';
  const targetValues = target ? [actor.workspaceId, target.id, ...EDITABLE_CONTACT_FIELDS.map((field) => target[field] ?? null)] : [];
  const results = await db.batch([
    maintenanceGuard(db, guard, "EXISTS (SELECT 1 FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id JOIN workspace_members m ON m.workspace_id = w.id WHERE s.workspace_id = ? AND s.epoch = ? AND s.paused = 0 AND w.lifecycle = 'active' AND m.user_id = ? AND m.role = 'owner')", [actor.workspaceId, data.expected_epoch, actor.userId]),
    db.prepare("INSERT INTO mutation_receipts (workspace_id, scope, request_key, fingerprint, owner_token) VALUES (?, 'google-contact-import', ?, ?, ?) ON CONFLICT(workspace_id, scope, request_key) DO NOTHING").bind(actor.workspaceId, key, fingerprint, owner),
    maintenanceGuard(db, guard + '-source', `NOT (${own}) OR (${predicate.condition}
      AND EXISTS (SELECT 1 FROM provider_contact_resources WHERE connection_id = ? AND active_generation = ?)
      AND EXISTS (SELECT 1 FROM provider_contact_index WHERE connection_id = ? AND generation = ? AND source_id = ? AND facts = ?)
      AND NOT EXISTS (SELECT 1 FROM contact_provider_links WHERE workspace_id = ? AND provider = 'google' AND account_key = ? AND external_id = ?)${targetGuard})`,
      [actor.workspaceId, key, owner, ...predicate.values, connectionId, data.generation, connectionId, data.generation, data.source_id, current.facts, actor.workspaceId, current.account_id, data.source_id, ...targetValues]),
    db.prepare(`INSERT INTO contacts (workspace_id, public_id, name, contact_frequency, email, phone, contact_methods) SELECT ?, ?, ?, 14, ?, ?, ? WHERE ? IS NULL AND ${own}`)
      .bind(actor.workspaceId, key, name, values.email, values.phone, values.methods, data.contact_id, actor.workspaceId, key, owner),
    ...(target && (target.name !== name || target.contact_methods !== values.methods) ? [db.prepare(`UPDATE contacts SET name = ?, email = ?, phone = ?, contact_methods = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND ${own}`)
      .bind(name, values.email, values.phone, values.methods, now, actor.workspaceId, target.id, actor.workspaceId, key, owner)] : []),
    db.prepare(`INSERT INTO contact_provider_links (public_id, workspace_id, contact_id, provider, account_key, account_email, external_id, resource_name,
      original_facts, observed_facts, applied_fields, status, revision, observed_at, created_at, updated_at)
      SELECT ?, ?, c.id, 'google', ?, ?, ?, ?, ?, ?, ?, 'available', 1, ?, ?, ? FROM contacts c WHERE c.workspace_id = ?
        AND (c.id = ? OR ? IS NULL AND c.public_id = ?) AND ${own}`)
      .bind(key, actor.workspaceId, current.account_id, current.email, data.source_id, current.factsValue.resourceName, current.facts, current.facts, applied, current.observed_at, now, now,
        actor.workspaceId, data.contact_id, data.contact_id, key, actor.workspaceId, key, owner),
    ...(data.keep_updated ? [db.prepare(`INSERT INTO provider_field_rules (workspace_id, source_link_id, fields, updated_at)
      SELECT ?, id, ?, ? FROM contact_provider_links WHERE workspace_id = ? AND public_id = ? AND ${own}`)
      .bind(actor.workspaceId, JSON.stringify((() => {
        const fields = defaultProviderRules({ original_facts: current.facts, applied_fields: applied } as ProviderSource);
        if (fields.name.last_applied !== null) fields.name.mode = 'follow';
        for (const method of fields.methods) method.mode = 'follow'; return fields;
      })()), now, actor.workspaceId, key, actor.workspaceId, key, owner)] : []),
    db.prepare("UPDATE mutation_receipts SET resource_id = (SELECT id FROM contact_provider_links WHERE workspace_id = ? AND public_id = ?) WHERE workspace_id = ? AND scope = 'google-contact-import' AND request_key = ? AND owner_token = ?").bind(actor.workspaceId, key, actor.workspaceId, key, owner),
    db.prepare("SELECT fingerprint, owner_token FROM mutation_receipts WHERE workspace_id = ? AND scope = 'google-contact-import' AND request_key = ?").bind(actor.workspaceId, key),
    db.prepare("SELECT link.* FROM contact_provider_links link JOIN mutation_receipts receipt ON receipt.workspace_id = link.workspace_id AND receipt.resource_id = link.id WHERE receipt.workspace_id = ? AND receipt.scope = 'google-contact-import' AND receipt.request_key = ?").bind(actor.workspaceId, key),
    removeGuard(db, guard), removeGuard(db, guard + '-source'),
  ]);
  const saved = results.at(-4)!.results[0] as { fingerprint: string; owner_token: string };
  if (saved.fingerprint !== fingerprint) throw new IdempotencyError('This import request key was already used for different selections.', 409);
  const link = results.at(-3)!.results[0] as LinkRow | undefined;
  if (!link) throw new ProviderSourceError('The original person or source is no longer available.', 409);
  return { contact_id: link.contact_id, source: providerSourceProjection(link), replayed: saved.owner_token !== owner };
}
export async function savedProviderSources(db: DB, actor: ConnectionActor, contactId: number) {
  await requireProviderOwner(db, actor);
  const contact = await db.prepare('SELECT * FROM contacts WHERE workspace_id = ? AND id = ?').bind(actor.workspaceId, contactId).first<Contact>();
  if (!contact) throw new ProviderSourceError('Person not found.', 404);
  const state = await db.prepare('SELECT epoch FROM workspace_sync_state WHERE workspace_id = ?').bind(actor.workspaceId).first<{ epoch: string }>();
  const rows = (await db.prepare('SELECT * FROM contact_provider_links WHERE workspace_id = ? AND contact_id = ? ORDER BY id').bind(actor.workspaceId, contactId).all<LinkRow>()).results;
  return { epoch: state?.epoch, contact: person(contact), links: rows.map((row: LinkRow) => providerSourceProjection(row)), rules: await savedProviderRules(db, actor.workspaceId, rows) };
}
export async function unlinkProviderSource(db: DB, actor: ConnectionActor, contactId: number, publicId: string, body: Record<string, unknown>) {
  await requireProviderOwner(db, actor);
  if (!isSyncUuid(publicId) || !isSyncUuid(body.expected_epoch) || !Number.isSafeInteger(body.expected_revision)) throw new ProviderSourceError('Refresh this source before unlinking.');
  const guard = crypto.randomUUID();
  await db.batch([maintenanceGuard(db, guard, `EXISTS (SELECT 1 FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id JOIN workspace_members m ON m.workspace_id = w.id
    WHERE s.workspace_id = ? AND s.epoch = ? AND s.paused = 0 AND w.lifecycle = 'active' AND m.user_id = ? AND m.role = 'owner')
    AND NOT EXISTS (SELECT 1 FROM contact_provider_links WHERE workspace_id = ? AND contact_id = ? AND public_id = ? AND revision != ?)`,
    [actor.workspaceId, body.expected_epoch, actor.userId, actor.workspaceId, contactId, publicId, body.expected_revision]),
    db.prepare('DELETE FROM contact_provider_links WHERE workspace_id = ? AND contact_id = ? AND public_id = ?').bind(actor.workspaceId, contactId, publicId), removeGuard(db, guard)]);
  return { success: true };
}
