import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { deviceImportFacts, readDeviceContactFacts, selectedDeviceIndexes, type DeviceContactFacts } from '../../../../packages/domain/src/device-contact-facts';
import { applyProviderMethods } from '../../../../packages/domain/src/provider-import';
import { contactMethodIdentity, readContactMethods } from '../../../../packages/domain/src/contact-methods';
import { readAppliedProviderFields, ProviderSourceError } from '../../../../packages/domain/src/provider-sources';
import { normalizeContactDraft, type ContactRecord } from '@/domain/contact';
import { canonicalContactId } from './contact-aliases';
import { getContact, getContactForEditing } from './contacts';
import { enqueueSyncIntent } from './sync-queue';
import { signalSyncChange } from './sync-signals';
import { isSyncUuid } from '../../../../packages/domain/src/sync';
import { enqueueDeviceSource, installationId, type LocalDeviceSource } from './device-source-sync';
export type DeviceContactLink = LocalDeviceSource;
type Preview = { id: string; facts: string; created_at: string; fingerprint: string | null; source_id: string | null; contact_id: string | null; epoch: string | null; installation_id: string | null };
async function selectedSource(db: SQLiteDatabase, externalId: string, installation: string | null) {
  return db.getFirstAsync<DeviceContactLink>(`SELECT * FROM device_contact_links WHERE device_contact_id = ?
    AND (installation_id = ? OR installation_id IS NULL) ORDER BY installation_id IS NULL, id LIMIT 1`, externalId, installation);
}
async function legacyPerson(db: SQLiteDatabase, externalId: string) {
  return db.getFirstAsync<ContactRecord>(`SELECT * FROM contacts WHERE deleted_at IS NULL AND
    NOT EXISTS (SELECT 1 FROM device_contact_links WHERE device_contact_id = ?) AND (device_contact_id = ? OR id IN
      (SELECT a.canonical_id FROM contact_aliases a JOIN contacts old ON old.id = a.id WHERE old.device_contact_id = ?)) ORDER BY id LIMIT 1`, externalId, externalId, externalId);
}
async function currentEpoch(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v3'");
  return row ? (JSON.parse(row.value) as { epoch: string }).epoch : null;
}
export function deviceImportContactRevision(contact: ContactRecord) {
  return JSON.stringify([contact.id, contact.name, contact.contact_methods, contact.notes, contact.birthday, contact.how_we_met, contact.last_contacted, contact.contact_frequency, contact.updated_at]);
}
export async function stageDeviceContact(db: SQLiteDatabase, value: DeviceContactFacts) {
  const facts = JSON.stringify(readDeviceContactFacts(value)), id = Crypto.randomUUID(), now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync('DELETE FROM device_contact_previews WHERE fingerprint IS NULL AND created_at < ?', new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    const count = await transaction.getFirstAsync<{ n: number }>('SELECT COUNT(*) n FROM device_contact_previews WHERE fingerprint IS NULL');
    if ((count?.n ?? 0) >= 20) throw new ProviderSourceError('Finish or discard an earlier device contact review first.');
    await transaction.runAsync('INSERT INTO device_contact_previews (id, facts, created_at, epoch, installation_id) VALUES (?, ?, ?, ?, ?)', id, facts, now, await currentEpoch(transaction), await installationId(transaction));
  }); return id;
}
export async function listDeviceContactLinks(db: SQLiteDatabase, personId: string) {
  const id = await canonicalContactId(db, personId);
  return db.getAllAsync<DeviceContactLink>('SELECT * FROM device_contact_links WHERE contact_id = ? ORDER BY created_at, id', id);
}
export async function unlinkDeviceContact(db: SQLiteDatabase, source: DeviceContactLink) {
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const current = await transaction.getFirstAsync<DeviceContactLink>('SELECT * FROM device_contact_links WHERE id = ? AND contact_id = ? AND revision = ?', source.id, source.contact_id, source.revision);
    if (!current) throw new ProviderSourceError('This source changed. Refresh before unlinking it.');
    const deleted = await transaction.runAsync('DELETE FROM device_contact_links WHERE id = ? AND contact_id = ? AND revision = ?', source.id, source.contact_id, source.revision);
    if (deleted.changes !== 1) throw new ProviderSourceError('This source changed. Refresh before unlinking it.');
    if (current.shared) await enqueueDeviceSource(transaction, current, 'unlink');
    await transaction.runAsync('UPDATE contacts SET device_contact_id = NULL WHERE id = ? AND device_contact_id = ?', source.contact_id, source.device_contact_id);
  }); signalSyncChange(db);
}
export async function shareDeviceContact(db: SQLiteDatabase, source: DeviceContactLink) {
  await db.withExclusiveTransactionAsync(async (tx) => {
    const current = await tx.getFirstAsync<DeviceContactLink>('SELECT * FROM device_contact_links WHERE id = ? AND contact_id = ? AND revision = ?', source.id, source.contact_id, source.revision);
    if (!current || current.shared || current.installation_id !== await installationId(tx)) throw new ProviderSourceError('Choose this contact again and review its details before sharing.');
    await enqueueDeviceSource(tx, current, 'publish');
    await tx.runAsync('UPDATE device_contact_links SET shared = 1, revision = revision + 1 WHERE id = ?', source.id);
  }); signalSyncChange(db);
}
export async function deviceContactReview(db: SQLiteDatabase, id: string, personId?: string, search = '') {
  const preview = await db.getFirstAsync<Preview>('SELECT * FROM device_contact_previews WHERE id = ?', id);
  if (!preview) throw new ProviderSourceError('Choose the device contact again to start a new review.');
  const facts = readDeviceContactFacts(preview.facts), normalized = deviceImportFacts(facts);
  const link = await selectedSource(db, facts.device_id, preview.installation_id ?? await installationId(db));
  const linked = link ? await getContact(db, link.contact_id) : await legacyPerson(db, facts.device_id);
  const identities = new Set<string>();
  for (const [kind, collection] of [['email', facts.emails], ['phone', facts.phones]] as const) for (const slot of collection) {
    try { const candidate = applyProviderMethods(normalized, { emails: kind === 'email' ? [collection.indexOf(slot)] : [], phones: kind === 'phone' ? [collection.indexOf(slot)] : [] }, '[]', Crypto.randomUUID);
      const method = readContactMethods(candidate.methods)[0]; if (kind === 'email' || method.value.startsWith('+')) identities.add(contactMethodIdentity(method));
    } catch { /* Invalid fields remain visible for review; they are not matching evidence. */ }
  }
  // A local number without a country is never evidence that two people are the same.
  const candidates = await db.getAllAsync<ContactRecord>(`SELECT c.* FROM contacts c WHERE deleted_at IS NULL AND EXISTS
    (SELECT 1 FROM json_each(c.contact_methods) m WHERE
      json_extract(m.value, '$.kind') = 'email' AND lower(trim(json_extract(m.value, '$.value'))) IN (SELECT value FROM json_each(?))
      OR json_extract(m.value, '$.kind') = 'phone' AND replace(replace(replace(replace(replace(json_extract(m.value, '$.value'), ' ', ''), '(', ''), ')', ''), '-', ''), '.', '') IN (SELECT value FROM json_each(?)))
    ORDER BY c.name COLLATE NOCASE, c.id LIMIT 51`, JSON.stringify(facts.emails.map((slot) => slot.value.toLowerCase())), JSON.stringify(facts.phones.filter((slot) => slot.value.trim().startsWith('+')).map((slot) => slot.value.replace(/[ ()\-.]/gu, ''))));
  const matches = candidates.filter((person) => readContactMethods(person.contact_methods).some((method) => identities.has(contactMethodIdentity(method)))).slice(0, 10);
  const pattern = '%' + search.trim().slice(0, 200).replace(/[\\%_]/gu, '\\$&') + '%';
  const people = search.trim() ? await db.getAllAsync<ContactRecord>("SELECT * FROM contacts WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY name COLLATE NOCASE, id LIMIT 20", pattern) : [];
  const target = personId ? await getContactForEditing(db, personId) : null;
  if (personId && !target) throw new ProviderSourceError('This person is no longer available. Choose another person.');
  const savedPerson = preview.fingerprint !== null && preview.contact_id ? await getContact(db, preview.contact_id) : null;
  const savedSource = preview.source_id ? await db.getFirstAsync<DeviceContactLink>('SELECT * FROM device_contact_links WHERE id = ?', preview.source_id) : null;
  const saved = savedPerson && savedSource?.contact_id === savedPerson.id ? savedPerson : null;
  return { id, facts, target, matches, people, link, linked, retired: Boolean(link && !linked), completed: preview.fingerprint !== null, saved };
}
export type DeviceContactSelection = { contact_id: string | null; create_name: string | null; use_name: boolean; emails: number[]; phones: number[]; expected_person: string | null; expected_source_revision: number | null; publish_source?: boolean };
export async function saveDeviceContactReview(db: SQLiteDatabase, previewId: string, input: DeviceContactSelection) {
  const choice = { contact_id: input.contact_id, create_name: input.create_name, use_name: input.use_name, expected_person: input.expected_person, expected_source_revision: input.expected_source_revision, emails: selectedDeviceIndexes(input.emails), phones: selectedDeviceIndexes(input.phones), ...(input.publish_source === true ? { publish_source: true } : {}) };
  if (input.publish_source !== undefined && typeof input.publish_source !== 'boolean' || typeof choice.use_name !== 'boolean' || !isSyncUuid(previewId)
    || choice.contact_id !== null && !isSyncUuid(choice.contact_id)
    || choice.create_name !== null && (typeof choice.create_name !== 'string' || choice.create_name.length > 200)
    || !choice.contact_id && typeof choice.create_name !== 'string'
    || choice.expected_person !== null && (typeof choice.expected_person !== 'string' || choice.expected_person.length > 512 * 1024)
    || choice.expected_source_revision !== null && (!Number.isSafeInteger(choice.expected_source_revision) || choice.expected_source_revision < 1)) throw new ProviderSourceError('Choose a person and the fields to use.');
  const fingerprint = JSON.stringify(choice), now = new Date().toISOString(); let personId = '';
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const preview = await transaction.getFirstAsync<Preview>('SELECT * FROM device_contact_previews WHERE id = ?', previewId);
    if (!preview) throw new ProviderSourceError('This review is no longer available. Choose the device contact again.');
    if (preview.fingerprint !== null) {
      if (preview.fingerprint !== fingerprint) throw new ProviderSourceError('This review was already saved with different choices. Start another review.');
      const saved = preview.contact_id ? await getContact(transaction, preview.contact_id) : null;
      if (!saved || !await transaction.getFirstAsync('SELECT id FROM device_contact_links WHERE id = ? AND contact_id = ?', preview.source_id, saved.id)) throw new ProviderSourceError('The saved person or source is no longer available.'); personId = saved.id; return;
    }
    if (preview.epoch !== null && preview.epoch !== await currentEpoch(transaction)) throw new ProviderSourceError('Your account data was restored. Choose the device contact again before saving.');
    const installation = preview.installation_id ?? await installationId(transaction);
    if (preview.installation_id && preview.installation_id !== await installationId(transaction)) throw new ProviderSourceError('This review belongs to another phone installation. Choose the contact again.');
    const facts = readDeviceContactFacts(preview.facts), link = await selectedSource(transaction, facts.device_id, installation);
    const target = choice.contact_id ? await getContactForEditing(transaction, choice.contact_id) : null;
    if (!target && await legacyPerson(transaction, facts.device_id)) throw new ProviderSourceError('This device contact was already copied. Confirm its existing person before applying fields.');
    if (choice.contact_id && (!target || deviceImportContactRevision(target) !== choice.expected_person || target.id !== choice.contact_id)) throw new ProviderSourceError('This person changed. Refresh the review while keeping your choices.');
    if ((link?.revision ?? null) !== choice.expected_source_revision || link && link.contact_id !== target?.id) throw new ProviderSourceError('This device source is already linked or changed. Review its existing person before saving.');
    if (link?.shared && !choice.publish_source) throw new ProviderSourceError('This source already syncs with your account. Unlink it explicitly to remove shared source details.');
    if (choice.publish_source && !installation) throw new ProviderSourceError('Set up this phone’s Contacts identity before sharing source details.');
    const name = target ? choice.use_name ? facts.name : target.name : normalizeContactDraft({ name: choice.create_name! }).name;
    if (!name) throw new ProviderSourceError('Enter a name, or keep the existing person’s name.');
    const values = applyProviderMethods(deviceImportFacts(facts), choice, target?.contact_methods ?? '[]', Crypto.randomUUID);
    // A source-only review or duplicate value must not enqueue a serialization-only edit.
    if (target && JSON.stringify(readContactMethods(target.contact_methods).sort((a, b) => a.id.localeCompare(b.id))) === values.methods) {
      values.methods = target.contact_methods; values.email = target.email; values.phone = target.phone;
    }
    personId = target?.id ?? previewId;
    if (!target) {
      await transaction.runAsync(`INSERT INTO contacts (id, device_contact_id, name, email, phone, contact_methods, contact_frequency, created_at, updated_at, sync_state)
        VALUES (?, ?, ?, ?, ?, ?, 14, ?, ?, 'pending')`, personId, facts.device_id, name, values.email, values.phone, values.methods, now, now);
      await enqueueSyncIntent(transaction, 'contact', personId, 'create', { name, email: values.email, phone: values.phone, contactFrequency: 14, contact_methods: values.methods }, now);
    } else {
      const patch = { ...(target.name !== name ? { name } : {}), ...(target.contact_methods !== values.methods ? { contact_methods: values.methods } : {}) };
      if (Object.keys(patch).length) {
        const conflict = await transaction.getFirstAsync("SELECT id FROM sync_queue WHERE entity_type = 'contact' AND entity_id = ? AND status = 'conflict' LIMIT 1", personId);
        await transaction.runAsync('UPDATE contacts SET name = ?, email = ?, phone = ?, contact_methods = ?, updated_at = ?, sync_state = ? WHERE id = ?', name, values.email, values.phone, values.methods, now, conflict ? 'conflict' : 'pending', personId);
        await enqueueSyncIntent(transaction, 'contact', personId, 'update', patch, now, { revision: target.remote_revision, values: Object.fromEntries(Object.keys(patch).map((key) => [key, target[key as keyof ContactRecord] ?? null])) });
      }
    }
    const oldAudit = link ? readAppliedProviderFields(link.applied_fields) : { name: null, methods: [] };
    const applied = JSON.stringify({ name: choice.use_name || !target && name === facts.name ? name : oldAudit.name,
      methods: [...oldAudit.methods, ...values.applied.filter((item) => !oldAudit.methods.some((old) => old.method.id === item.method.id))] }); readAppliedProviderFields(applied);
    const sourceId = link?.id ?? Crypto.randomUUID();
    await transaction.runAsync(`INSERT INTO device_contact_links (id, device_contact_id, contact_id, installation_id, shared, original_facts, observed_facts, applied_fields, observed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET observed_facts = excluded.observed_facts, applied_fields = excluded.applied_fields,
      installation_id = COALESCE(device_contact_links.installation_id, excluded.installation_id), shared = excluded.shared,
      revision = device_contact_links.revision + 1, observed_at = excluded.observed_at, updated_at = excluded.updated_at`, sourceId, facts.device_id, personId, installation, choice.publish_source ? 1 : 0, preview.facts, preview.facts, applied, now, now, now);
    const sources = await transaction.getAllAsync<DeviceContactLink>('SELECT * FROM device_contact_links WHERE contact_id = ?', personId);
    if (sources.length > 32 || new TextEncoder().encode(JSON.stringify(sources)).byteLength > 131072) throw new ProviderSourceError('This person has reached the saved device-source limit.');
    if (choice.publish_source) await enqueueDeviceSource(transaction, sources.find((source) => source.id === sourceId)!, 'publish');
    await transaction.runAsync('UPDATE device_contact_previews SET fingerprint = ?, source_id = ?, contact_id = ? WHERE id = ?', fingerprint, sourceId, personId, previewId);
  }); signalSyncChange(db); return { contact_id: personId };
}
