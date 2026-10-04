import type Database from 'better-sqlite3';
import type { Contact } from './db.ts';
import { ContactSourceError, observeSourceFacts, readContactSources, readSourceFacts, SOURCE_PROJECTION_COLUMNS, type ContactSource } from '../packages/domain/src/contact-sources.ts';
import { sourceCreateInput, sourceChangeFields, sourceExpectedRevision, SOURCE_STALE_MESSAGE } from './contact-source-input.ts';
import { fingerprintIdempotencyInput, runIdempotentCreate } from './idempotency.ts';
import { getContactEditRevision, getExpectedContactRevision } from './contact-revision.ts';

export type StoredContactSource = ContactSource & { id: number; contact_id: number; workspace_id: number | string };
export function contactSourceWriteEpoch(db: Database.Database) {
  const row = db.prepare("SELECT value FROM app_metadata WHERE key = 'source-write-epoch'").get() as { value: string } | undefined;
  if (row) return row.value;
  const epoch = crypto.randomUUID();
  db.prepare("INSERT INTO app_metadata (key, value, updated_at) VALUES ('source-write-epoch', ?, CURRENT_TIMESTAMP)").run(epoch);
  return epoch;
}
export function sourceProjection(row: StoredContactSource) {
  const value = Object.fromEntries(SOURCE_PROJECTION_COLUMNS.map((key) => [key, row[key]]));
  return readContactSources(JSON.stringify([value]))[0];
}
export function listContactSources(db: Database.Database, contactId: number) {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) as Contact | undefined;
  if (!contact) throw new ContactSourceError('Person not found.', 404);
  const rows = db.prepare('SELECT * FROM contact_source_links WHERE contact_id = ? ORDER BY id').all(contactId) as StoredContactSource[];
  return { contact: { id: contactId, name: contact.name, edit_revision: getContactEditRevision(contact) }, sources: rows.map(sourceProjection) };
}
export function createLinkedInSource(db: Database.Database, body: Record<string, unknown>, key: string) {
  const input = sourceCreateInput(body);
  if (input.expected_epoch !== null && input.expected_epoch !== contactSourceWriteEpoch(db)) throw new ContactSourceError('This dataset changed. Refresh before creating or linking a person.', 409);
  const result = runIdempotentCreate<StoredContactSource>(db, { scope: 'source-link', idempotencyKey: key, fingerprint: fingerprintIdempotencyInput(input),
    load: (id) => db.prepare('SELECT * FROM contact_source_links WHERE id = ?').get(id) as StoredContactSource | undefined,
    create: () => {
      const workspace = db.prepare('SELECT id FROM workspaces ORDER BY id LIMIT 1').get() as { id: number } | undefined;
      if (!workspace) throw new ContactSourceError('Workspace not found.', 404);
      const existing = db.prepare('SELECT contact_id FROM contact_source_links WHERE workspace_id = ? AND provider = ? AND account_key = ? AND external_id = ?')
        .get(workspace.id, 'linkedin', 'user_provided', input.profile_url) as { contact_id: number } | undefined;
      if (existing) throw new ContactSourceError('This LinkedIn profile is already linked. Open its person or unlink it there first.', 409);
      let contactId = input.contact_id;
      if (contactId !== null && !db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(contactId)) throw new ContactSourceError('Person not found.', 404);
      if (contactId === null) contactId = Number(db.prepare('INSERT INTO contacts (name, contact_frequency) VALUES (?, 14)').run(input.observations.name).lastInsertRowid);
      const facts = readSourceFacts(observeSourceFacts('{}', input.observations));
      if (input.contact_id === null) facts.name!.applied_value = input.observations.name!;
      const now = new Date().toISOString();
      const id = db.prepare(`INSERT INTO contact_source_links (public_id, workspace_id, contact_id, provider, account_key, external_id, profile_url, origin, fields, revision, observed_at, created_at, updated_at)
        VALUES (?, ?, ?, 'linkedin', 'user_provided', ?, ?, 'user_provided', ?, 1, ?, ?, ?)`)
        .run(key, workspace.id, contactId, input.profile_url, input.profile_url, JSON.stringify(facts), now, now, now).lastInsertRowid;
      return db.prepare('SELECT * FROM contact_source_links WHERE id = ?').get(id) as StoredContactSource;
    } });
  return { contact_id: result.resource!.contact_id, source: sourceProjection(result.resource!), replayed: result.replayed };
}
export function changeContactSource(db: Database.Database, contactId: number, publicId: string, body: Record<string, unknown>, remove = false) {
  return db.transaction(() => {
    const source = db.prepare('SELECT * FROM contact_source_links WHERE contact_id = ? AND public_id = ?').get(contactId, publicId) as StoredContactSource | undefined;
    if (!source) { if (remove) return { success: true }; throw new ContactSourceError('Source not found.', 404); }
    if (source.revision !== sourceExpectedRevision(body)) throw new ContactSourceError(SOURCE_STALE_MESSAGE, 409);
    if (remove) { db.prepare('DELETE FROM contact_source_links WHERE id = ?').run(source.id); return { success: true }; }
    const change = sourceChangeFields(source.fields, body);
    if (change.name !== null) {
      const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) as Contact;
      if (getContactEditRevision(contact) !== getExpectedContactRevision(body)) throw new ContactSourceError(SOURCE_STALE_MESSAGE, 409);
      db.prepare('UPDATE contacts SET name = ?, updated_at = ? WHERE id = ?').run(change.name, new Date().toISOString(), contactId);
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE contact_source_links SET fields = ?, revision = revision + 1, observed_at = CASE WHEN ? = 1 THEN ? ELSE observed_at END, updated_at = ? WHERE id = ?')
      .run(change.fields, body.action === 'observe' ? 1 : 0, now, now, source.id);
    return { source: sourceProjection(db.prepare('SELECT * FROM contact_source_links WHERE id = ?').get(source.id) as StoredContactSource) };
  }).immediate();
}
