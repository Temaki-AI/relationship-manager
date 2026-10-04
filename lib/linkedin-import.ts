import type Database from 'better-sqlite3';
import type { Contact } from './db.ts';
import { ContactSourceError, linkedinProfileIdentity, normalizeSourceObservations, observeSourceFacts, readSourceFacts } from '../packages/domain/src/contact-sources.ts';
import { contactMethodIdentity, normalizeUserContactMethods, readContactMethods } from '../packages/domain/src/contact-methods.ts';
import { isSyncUuid } from '../packages/domain/src/sync.ts';
import { getContactEditRevision } from './contact-revision.ts';
import { fingerprintIdempotencyInput, runIdempotentCreate } from './idempotency.ts';
import { contactSourceWriteEpoch, sourceProjection, type StoredContactSource } from './contact-source-storage.ts';
import { parsePositiveInteger } from './relationship-validation.ts';
export function linkedInObservation(body: Record<string, unknown>) {
  const fields = normalizeSourceObservations(body.fields);
  return { profile_url: linkedinProfileIdentity(body.profile_url), fields };
}
export function linkedInTarget(body: Record<string, unknown>) {
  if (body.contact_id == null) return null;
  const id = parsePositiveInteger(body.contact_id); if (!id) throw new ContactSourceError('Choose a valid person.'); return id;
}
export function linkedInImportInput(body: Record<string, unknown>) {
  const observation = linkedInObservation(body), contact_id = linkedInTarget(body);
  if (!isSyncUuid(body.expected_epoch) || typeof body.use_name !== 'boolean' || typeof body.use_email !== 'boolean') throw new ContactSourceError('Refresh this row and review its field choices.');
  const create_name = body.create_name === null ? null : normalizeSourceObservations({ name: body.create_name }).name;
  if (contact_id === null ? !create_name : create_name !== null) throw new ContactSourceError('Choose an existing person or a name for a new person.');
  const expected_contact_revision = body.expected_contact_revision;
  if (contact_id === null ? expected_contact_revision !== null : typeof expected_contact_revision !== 'string' || !/^[a-f0-9]{64}$/u.test(expected_contact_revision)) throw new ContactSourceError('Refresh the selected person before saving.');
  const source = body.expected_source;
  if (source !== null && (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).length !== 2
    || !isSyncUuid((source as Record<string, unknown>).public_id) || !Number.isSafeInteger((source as Record<string, unknown>).revision) || Number((source as Record<string, unknown>).revision) < 1)) throw new ContactSourceError('Refresh the saved LinkedIn source before saving.');
  if (body.use_name && !observation.fields.name || body.use_email && !observation.fields.email) throw new ContactSourceError('The selected source field is not provided.');
  return { ...observation, contact_id, create_name: create_name ?? null, use_name: body.use_name, use_email: body.use_email,
    expected_epoch: body.expected_epoch as string, expected_contact_revision: expected_contact_revision as string | null,
    expected_source: source as { public_id: string; revision: number } | null };
}
export type LinkedInImportInput = ReturnType<typeof linkedInImportInput>;
export function linkedInPersonSummary(person: Contact) { return { id: person.id, name: person.name, email: person.email, contact_methods: person.contact_methods ?? '[]', edit_revision: getContactEditRevision(person) }; }
export function validateLinkedInImportTarget(input: LinkedInImportInput, source: StoredContactSource | null, person: Contact | null) {
  if (input.contact_id !== null && (!person || person.id !== input.contact_id)) throw new ContactSourceError('Person not found.', 404);
  if (person && getContactEditRevision(person) !== input.expected_contact_revision) throw new ContactSourceError('This person changed. Refresh while keeping your row choices.', 409);
  if (input.expected_source ? !source || source.public_id !== input.expected_source.public_id || source.revision !== input.expected_source.revision
    : source !== null) throw new ContactSourceError('This LinkedIn link changed. Refresh while keeping your row choices.', 409);
  if (source && source.contact_id !== input.contact_id) throw new ContactSourceError('This profile is linked to another person. Review that person or explicitly unlink it first.', 409);
}
/** Exported facts do not overwrite professional/private fields or an existing preferred method. */
export function linkedInImportPatch(input: LinkedInImportInput, source: StoredContactSource | null, person: Contact | null) {
  const name = person ? input.use_name ? input.fields.name! : person.name : input.create_name!;
  const previous = person?.contact_methods ?? '[]', methods = readContactMethods(previous), facts = readSourceFacts(observeSourceFacts(source?.fields ?? '{}', input.fields));
  if (!person || input.use_name) { facts.name ??= { original_value: input.fields.name ?? null, observed_value: input.fields.name ?? null, applied_value: null }; facts.name.applied_value = name; }
  if (input.use_email) {
    const draft = { id: crypto.randomUUID(), kind: 'email' as const, value: input.fields.email!, label: 'LinkedIn export', country: null, preferred: !methods.some((method) => method.kind === 'email' && method.preferred) };
    const identity = contactMethodIdentity(draft), existing = methods.find((method) => contactMethodIdentity(method) === identity);
    const next = existing ? methods : readContactMethods(normalizeUserContactMethods([...methods, draft], previous));
    facts.email!.applied_value = existing?.value ?? draft.value;
    return { name, methods: JSON.stringify(next), email: next.find((method) => method.kind === 'email' && method.preferred)?.value ?? null, fields: JSON.stringify(facts) };
  }
  return { name, methods: previous, email: person?.email ?? null, fields: JSON.stringify(facts) };
}
export function previewLocalLinkedInImport(db: Database.Database, body: Record<string, unknown>) {
  const input = linkedInObservation(body), contactId = linkedInTarget(body);
  const source = db.prepare("SELECT * FROM contact_source_links WHERE provider = 'linkedin' AND account_key = 'user_provided' AND external_id = ?").get(input.profile_url) as StoredContactSource | undefined;
  const target = contactId === null ? null : db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) as Contact | undefined;
  if (contactId !== null && !target) throw new ContactSourceError('Person not found.', 404);
  const matches = db.prepare(`SELECT id, name, email FROM contacts c WHERE lower(trim(name)) = lower(?) OR (? IS NOT NULL AND (lower(trim(email)) = lower(?)
    OR EXISTS (SELECT 1 FROM json_each(c.contact_methods) WHERE json_extract(value, '$.kind') = 'email' AND lower(trim(json_extract(value, '$.value'))) = lower(?)))) ORDER BY name, id LIMIT 51`)
    .all(input.fields.name ?? '', input.fields.email ?? null, input.fields.email ?? null, input.fields.email ?? null) as Array<{ id: number; name: string; email: string | null }>;
  const linked = source ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(source.contact_id) as Contact : null;
  return { epoch: contactSourceWriteEpoch(db), source: source ? sourceProjection(source) : null, linked_person: linked ? linkedInPersonSummary(linked) : null,
    target: target ? linkedInPersonSummary(target) : null, matches: matches.slice(0, 50), more_matches: matches.length > 50 };
}
export type LinkedInImportPreview = ReturnType<typeof previewLocalLinkedInImport>;
export function importLocalLinkedInRow(db: Database.Database, body: Record<string, unknown>, key: string) {
  const input = linkedInImportInput(body);
  if (contactSourceWriteEpoch(db) !== input.expected_epoch) throw new ContactSourceError('Your data was restored. Refresh before importing this row.', 409);
  const result = runIdempotentCreate<StoredContactSource>(db, { scope: 'linkedin-export', durable: true, idempotencyKey: key, fingerprint: fingerprintIdempotencyInput(input),
    load: (id) => db.prepare('SELECT * FROM contact_source_links WHERE id = ?').get(id) as StoredContactSource | undefined,
    create: () => {
      const source = db.prepare("SELECT * FROM contact_source_links WHERE provider = 'linkedin' AND account_key = 'user_provided' AND external_id = ?").get(input.profile_url) as StoredContactSource | undefined;
      const person = input.contact_id === null ? null : db.prepare('SELECT * FROM contacts WHERE id = ?').get(input.contact_id) as Contact | undefined;
      validateLinkedInImportTarget(input, source ?? null, person ?? null);
      const patch = linkedInImportPatch(input, source ?? null, person ?? null), now = new Date().toISOString();
      const contactId = person ? person.id : Number(db.prepare('INSERT INTO contacts (name, email, contact_methods, contact_frequency) VALUES (?, ?, ?, 14)').run(patch.name, patch.email, patch.methods).lastInsertRowid);
      if (person && (person.name !== patch.name || person.contact_methods !== patch.methods)) db.prepare('UPDATE contacts SET name = ?, email = ?, contact_methods = ?, updated_at = ? WHERE id = ?').run(patch.name, patch.email, patch.methods, now, contactId);
      if (source) {
        db.prepare('UPDATE contact_source_links SET fields = ?, revision = revision + 1, observed_at = ?, updated_at = ? WHERE id = ?').run(patch.fields, now, now, source.id);
        return db.prepare('SELECT * FROM contact_source_links WHERE id = ?').get(source.id) as StoredContactSource;
      }
      const workspace = db.prepare('SELECT id FROM workspaces ORDER BY id LIMIT 1').get() as { id: number };
      const id = db.prepare(`INSERT INTO contact_source_links (public_id, workspace_id, contact_id, provider, account_key, external_id, profile_url, origin, fields, revision, observed_at, created_at, updated_at)
        VALUES (?, ?, ?, 'linkedin', 'user_provided', ?, ?, 'user_provided', ?, 1, ?, ?, ?)`).run(key, workspace.id, contactId, input.profile_url, input.profile_url, patch.fields, now, now, now).lastInsertRowid;
      return db.prepare('SELECT * FROM contact_source_links WHERE id = ?').get(id) as StoredContactSource;
    } });
  return { contact_id: result.resource!.contact_id, source: sourceProjection(result.resource!), replayed: result.replayed };
}
