import { contactMethodIdentity, mergeContactMethods, readContactMethods } from '../packages/domain/src/contact-methods.ts';
import type Database from 'better-sqlite3';
import type { Contact } from './db.ts';

export type DuplicateSignalKind = 'email' | 'phone' | 'name_birthday';

export type DuplicateSignal = {
  key: string;
  kind: DuplicateSignalKind;
  value: string;
};

export type DuplicateIdentity = Pick<Contact, 'id' | 'name' | 'email' | 'phone' | 'birthday' | 'custom_fields' | 'created_at' | 'contact_methods'>
  & Partial<Pick<Contact, 'nickname' | 'photo_url' | 'how_we_met' | 'notes' | 'gift_ideas' | 'last_contacted'>>
  & {
  interaction_count?: number;
  reminder_count?: number;
  fact_count?: number;
  plan_count?: number;
  group_count?: number;
  completeness_count?: number;
  quality_score?: number;
};

export type DuplicateContact = Contact & DuplicateIdentity;

export type DuplicateContactGroup<T extends DuplicateIdentity = DuplicateContact> = {
  id: string;
  contacts: T[];
  reasons: Array<{ kind: DuplicateSignalKind; value: string }>;
  recommendedPrimaryId: number;
  totalContacts?: number;
  hasMoreContacts?: boolean;
};

export type ContactMergeResult = {
  contact: Contact;
  mergedContactIds: number[];
  moved: {
    interactions: number;
    reminders: number;
    facts: number;
    plans: number;
    groups: number;
    relationships: number;
    children: number;
  };
};

export class ContactMergeError extends Error {
  code: 'invalid' | 'not_found' | 'not_duplicates' | 'stale';

  constructor(message: string, code: ContactMergeError['code'] = 'invalid') {
    super(message);
    this.name = 'ContactMergeError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseStringList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function getCustomStringList(contact: Pick<Contact, 'custom_fields'>, key: 'additional_emails' | 'additional_phones'): string[] {
  const customFields = parseObject(contact.custom_fields);
  const vcard = isRecord(customFields.vcard) ? customFields.vcard : null;
  const values = vcard?.[key];
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
}

export function normalizeEmailIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

export function normalizePhoneIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
}

function normalizeNameIdentity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function uniqueStrings(values: string[], normalize: (value: string) => string | null): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawValue of values) {
    const value = rawValue.trim();
    const identity = normalize(value);
    if (!value || !identity || seen.has(identity)) continue;
    seen.add(identity);
    result.push(value);
  }
  return result;
}

function getAllEmails(contact: Pick<Contact, 'email' | 'custom_fields' | 'contact_methods'>): string[] {
  return uniqueStrings(
    [contact.email || '', ...(contact.contact_methods === undefined ? getCustomStringList(contact, 'additional_emails') : []), ...readContactMethods(contact.contact_methods).filter((item) => item.kind === 'email').map((item) => item.value)],
    normalizeEmailIdentity
  );
}

function getAllPhones(contact: Pick<Contact, 'phone' | 'custom_fields' | 'contact_methods'>): string[] {
  return uniqueStrings(
    [contact.phone || '', ...(contact.contact_methods === undefined ? getCustomStringList(contact, 'additional_phones') : []), ...readContactMethods(contact.contact_methods).filter((item) => item.kind === 'phone').map((item) => item.value)],
    normalizePhoneIdentity
  );
}

export function getDuplicateSignals(contact: Pick<Contact, 'email' | 'phone' | 'birthday' | 'name' | 'custom_fields' | 'contact_methods'>): DuplicateSignal[] {
  const signals: DuplicateSignal[] = [];
  for (const email of getAllEmails(contact)) {
    const identity = normalizeEmailIdentity(email);
    if (identity) signals.push({ key: `email:${identity}`, kind: 'email', value: email });
  }
  const phoneMethods = readContactMethods(contact.contact_methods).filter((item) => item.kind === 'phone');
  const legacyPhones = [contact.phone || '', ...(contact.contact_methods === undefined ? getCustomStringList(contact, 'additional_phones') : [])];
  const comparable = (value: string) => contactMethodIdentity({ kind: 'phone', value, country: null });
  const candidates = [...phoneMethods, ...legacyPhones.filter((value) => value && !phoneMethods.some((item) => comparable(item.value) === comparable(value)))
    .map((value) => ({ kind: 'phone' as const, value, country: null }))];
  const seen = new Set<string>();
  for (const method of candidates) {
    if (!normalizePhoneIdentity(method.value)) continue;
    const key = contactMethodIdentity(method);
    if (!seen.has(key)) signals.push({ key, kind: 'phone', value: method.value });
    seen.add(key);
  }
  if (contact.birthday) {
    const name = normalizeNameIdentity(contact.name);
    if (name) {
      signals.push({
        key: `name-birthday:${name}|${contact.birthday}`,
        kind: 'name_birthday',
        value: `${contact.name} · ${contact.birthday}`,
      });
    }
  }
  return signals;
}

function contactQualityScore(contact: DuplicateIdentity): number {
  if (contact.quality_score !== undefined) return contact.quality_score;
  const activity = (contact.interaction_count || 0)
    + (contact.reminder_count || 0)
    + (contact.fact_count || 0)
    + (contact.plan_count || 0)
    + (contact.group_count || 0);
  const completeness = contact.completeness_count ?? [
    contact.nickname,
    contact.email,
    contact.phone,
    contact.photo_url,
    contact.birthday,
    contact.how_we_met,
    contact.notes,
    contact.gift_ideas,
    contact.custom_fields,
    contact.last_contacted,
  ].filter(Boolean).length;
  return activity * 100 + completeness;
}

export function findDuplicateContactGroups<T extends DuplicateIdentity>(contacts: T[]): DuplicateContactGroup<T>[] {
  const parent = new Map(contacts.map((contact) => [contact.id, contact.id]));
  const signalOwner = new Map<string, number>();

  function find(id: number): number {
    const current = parent.get(id) ?? id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  }

  function union(left: number, right: number) {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
  }

  for (const contact of contacts) {
    for (const signal of getDuplicateSignals(contact)) {
      const owner = signalOwner.get(signal.key);
      if (owner === undefined) signalOwner.set(signal.key, contact.id);
      else union(contact.id, owner);
    }
  }

  const groups = new Map<number, T[]>();
  for (const contact of contacts) {
    const root = find(contact.id);
    const group = groups.get(root) || [];
    group.push(contact);
    groups.set(root, group);
  }

  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group) => {
      const contactIds = new Set(group.map((contact) => contact.id));
      const sharedSignals = new Map<string, DuplicateSignal & { count: number }>();
      for (const contact of group) {
        for (const signal of getDuplicateSignals(contact)) {
          const owner = signalOwner.get(signal.key);
          if (owner === undefined || !contactIds.has(owner)) continue;
          const existing = sharedSignals.get(signal.key);
          sharedSignals.set(signal.key, { ...signal, count: (existing?.count || 0) + 1 });
        }
      }

      const ranked = [...group].sort((left, right) => {
        const scoreDifference = contactQualityScore(right) - contactQualityScore(left);
        if (scoreDifference !== 0) return scoreDifference;
        const dateDifference = left.created_at.localeCompare(right.created_at);
        return dateDifference !== 0 ? dateDifference : left.id - right.id;
      });
      const sorted = [...group].sort((left, right) => left.id - right.id);
      return {
        id: sorted.length <= 21
          ? `duplicates-${sorted.map((contact) => contact.id).join('-')}`
          : `duplicates-${sorted[0].id}-${sorted.at(-1)?.id}-${sorted.length}`,
        contacts: sorted,
        reasons: Array.from(sharedSignals.values())
          .filter((signal) => signal.count > 1)
          .map(({ kind, value }) => ({ kind, value })),
        recommendedPrimaryId: ranked[0].id,
      };
    })
    .sort((left, right) => left.contacts[0].id - right.contacts[0].id);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeJsonRecords(
  primary: Record<string, unknown>,
  secondary: Record<string, unknown>,
  conflicts: Array<{ field: string; value: unknown }>,
  path = '',
  depth = 0
): Record<string, unknown> {
  const result = cloneJson(primary);
  for (const [key, secondaryValue] of Object.entries(secondary)) {
    const field = path ? `${path}.${key}` : key;
    if (!(key in result)) {
      result[key] = cloneJson(secondaryValue);
      continue;
    }
    const primaryValue = result[key];
    if (JSON.stringify(primaryValue) === JSON.stringify(secondaryValue)) continue;
    if (depth < 20 && isRecord(primaryValue) && isRecord(secondaryValue)) {
      result[key] = mergeJsonRecords(primaryValue, secondaryValue, conflicts, field, depth + 1);
      continue;
    }
    if (Array.isArray(primaryValue) && Array.isArray(secondaryValue)) {
      const values = new Map<string, unknown>();
      for (const value of [...primaryValue, ...secondaryValue]) values.set(JSON.stringify(value), cloneJson(value));
      result[key] = Array.from(values.values());
      continue;
    }
    conflicts.push({ field, value: cloneJson(secondaryValue) });
  }
  return result;
}

function mergeText(values: Array<string | null>): string | null {
  const unique = uniqueStrings(values.filter((value): value is string => Boolean(value)), (value) => value);
  return unique.length > 0 ? unique.join('\n\n---\n\n') : null;
}

function serializeUniqueList(values: string[]): string | null {
  const unique = uniqueStrings(values, (value) => value.toLowerCase());
  return unique.length > 0 ? JSON.stringify(unique) : null;
}

export function buildMergedContact(primary: Contact, duplicates: Contact[], mergedAt: string): Contact {
  const contacts = [primary, ...duplicates];
  let customFields = parseObject(primary.custom_fields);
  const newHistory: unknown[] = [];

  for (const duplicate of duplicates) {
    const conflicts: Array<{ field: string; value: unknown }> = [];
    customFields = mergeJsonRecords(customFields, parseObject(duplicate.custom_fields), conflicts);
    newHistory.push({
      merged_at: mergedAt,
      source_contact_id: duplicate.id,
      source_name: duplicate.name,
      source_created_at: duplicate.created_at,
      values: {
        nickname: duplicate.nickname,
        email: duplicate.email,
        phone: duplicate.phone,
        photo_url: duplicate.photo_url,
        birthday: duplicate.birthday,
        birthday_reminder_days: duplicate.birthday_reminder_days,
        last_contacted: duplicate.last_contacted,
        contact_frequency: duplicate.contact_frequency,
      },
      custom_field_conflicts: conflicts,
    });
  }

  const selectedEmail = contacts.find((contact) => contact.email)?.email || null;
  const selectedPhone = contacts.find((contact) => contact.phone)?.phone || null;
  const allEmails = uniqueStrings(contacts.flatMap(getAllEmails), normalizeEmailIdentity);
  const allPhones = uniqueStrings(contacts.flatMap(getAllPhones), normalizePhoneIdentity);
  const vcard = isRecord(customFields.vcard) ? cloneJson(customFields.vcard) : {};
  const additionalEmails = allEmails.filter((email) => normalizeEmailIdentity(email) !== normalizeEmailIdentity(selectedEmail));
  const additionalPhones = allPhones.filter((phone) => normalizePhoneIdentity(phone) !== normalizePhoneIdentity(selectedPhone));
  if (additionalEmails.length > 0) vcard.additional_emails = additionalEmails;
  else delete vcard.additional_emails;
  if (additionalPhones.length > 0) vcard.additional_phones = additionalPhones;
  else delete vcard.additional_phones;
  if (Object.keys(vcard).length > 0) customFields.vcard = vcard;
  else delete customFields.vcard;

  const bondsMetadata = isRecord(customFields._bonds) ? customFields._bonds : {};
  const existingHistory = Array.isArray(bondsMetadata.merge_history)
    ? cloneJson(bondsMetadata.merge_history)
    : [];
  customFields._bonds = {
    ...bondsMetadata,
    merge_history: [...existingHistory, ...newHistory],
  };

  return {
    ...primary,
    contact_methods: mergeContactMethods(contacts.map((contact) => contact.contact_methods)),
    nickname: contacts.find((contact) => contact.nickname)?.nickname || null,
    email: selectedEmail,
    phone: selectedPhone,
    photo_url: contacts.find((contact) => contact.photo_url)?.photo_url || null,
    birthday: contacts.find((contact) => contact.birthday)?.birthday || null,
    how_we_met: mergeText(contacts.map((contact) => contact.how_we_met)),
    tags: serializeUniqueList(contacts.flatMap((contact) => parseStringList(contact.tags))),
    notes: mergeText(contacts.map((contact) => contact.notes)),
    gift_ideas: serializeUniqueList(contacts.flatMap((contact) => parseStringList(contact.gift_ideas))),
    custom_fields: JSON.stringify(customFields),
    last_contacted: contacts
      .map((contact) => contact.last_contacted)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) || null,
    updated_at: mergedAt,
  };
}

export function validateContactMergeIds(
  primaryId: number,
  duplicateIds: number[]
): number[] {
  if (!Number.isInteger(primaryId) || primaryId < 1) {
    throw new ContactMergeError('Choose a valid primary contact.');
  }
  const normalizedDuplicateIds = Array.from(new Set(duplicateIds));
  if (normalizedDuplicateIds.length === 0 || normalizedDuplicateIds.length > 20) {
    throw new ContactMergeError('Choose between 1 and 20 duplicate contacts.');
  }
  if (normalizedDuplicateIds.some((id) => !Number.isInteger(id) || id < 1 || id === primaryId)) {
    throw new ContactMergeError('Duplicate contact IDs are invalid.');
  }

  return normalizedDuplicateIds;
}

export function validateContactMergeSelection(
  primaryId: number,
  duplicateIds: number[],
  contacts: Contact[],
): { primary: Contact; duplicates: Contact[] } {
  const normalizedDuplicateIds = validateContactMergeIds(primaryId, duplicateIds);
  const ids = [primaryId, ...normalizedDuplicateIds];
  if (contacts.length !== ids.length || new Set(contacts.map((contact) => contact.id)).size !== ids.length) {
    throw new ContactMergeError('One or more contacts no longer exists.', 'not_found');
  }
  const groups = findDuplicateContactGroups(contacts);
  if (groups.length !== 1 || groups[0].contacts.length !== contacts.length) {
    throw new ContactMergeError('These contacts do not share a verified email, phone, or name and birthday.', 'not_duplicates');
  }

  const primary = contacts.find((contact) => contact.id === primaryId)!;
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  return {
    primary,
    duplicates: normalizedDuplicateIds.map((id) => byId.get(id)!),
  };
}

export function validateContactMerge(
  db: Database.Database,
  primaryId: number,
  duplicateIds: number[]
): { primary: Contact; duplicates: Contact[] } {
  const normalizedDuplicateIds = validateContactMergeIds(primaryId, duplicateIds);
  const ids = [primaryId, ...normalizedDuplicateIds];
  const placeholders = ids.map(() => '?').join(', ');
  const contacts = db.prepare(`SELECT * FROM contacts WHERE id IN (${placeholders})`).all(...ids) as Contact[];
  return validateContactMergeSelection(primaryId, normalizedDuplicateIds, contacts);
}

export type StoredContactRelationship = {
  id: number;
  contact_id: number;
  related_contact_id: number;
};

export type StoredContactChildLink = {
  id: number;
  contact_id: number;
  linked_contact_id: number | null;
};

export function planContactConnectionMerge(
  primaryId: number,
  duplicateIds: number[],
  relationships: StoredContactRelationship[],
  children: StoredContactChildLink[],
) {
  const duplicateSet = new Set(validateContactMergeIds(primaryId, duplicateIds));
  const target = (id: number) => duplicateSet.has(id) ? primaryId : id;
  const relationshipDeletes: number[] = [];
  const relationshipUpdates: Array<StoredContactRelationship> = [];
  const keptRelationships = new Map<string, { row: StoredContactRelationship; changed: boolean }>();
  for (const row of [...relationships].sort((left, right) => left.id - right.id)) {
    const next = { ...row, contact_id: target(row.contact_id), related_contact_id: target(row.related_contact_id) };
    if (next.contact_id === next.related_contact_id) {
      relationshipDeletes.push(row.id);
      continue;
    }
    const key = `${Math.min(next.contact_id, next.related_contact_id)}:${Math.max(next.contact_id, next.related_contact_id)}`;
    const changed = next.contact_id !== row.contact_id || next.related_contact_id !== row.related_contact_id;
    const kept = keptRelationships.get(key);
    if (!kept) keptRelationships.set(key, { row: next, changed });
    else if (kept.changed && !changed) {
      relationshipDeletes.push(kept.row.id);
      keptRelationships.set(key, { row: next, changed });
    } else relationshipDeletes.push(row.id);
  }
  for (const { row, changed } of keptRelationships.values()) if (changed) relationshipUpdates.push(row);

  const childDeletes: number[] = [];
  const childUpdates: Array<StoredContactChildLink> = [];
  const keptChildren = new Map<string, { row: StoredContactChildLink; changed: boolean }>();
  for (const row of [...children].sort((left, right) => left.id - right.id)) {
    const next = { ...row, contact_id: target(row.contact_id),
      linked_contact_id: row.linked_contact_id === null ? null : target(row.linked_contact_id) };
    if (next.linked_contact_id === next.contact_id) {
      throw new ContactMergeError('This merge would link a contact as their own child. Remove that child link first.');
    }
    const changed = next.contact_id !== row.contact_id || next.linked_contact_id !== row.linked_contact_id;
    if (next.linked_contact_id === null) {
      if (changed) childUpdates.push(next);
      continue;
    }
    const key = `${next.contact_id}:${next.linked_contact_id}`;
    const kept = keptChildren.get(key);
    if (!kept) keptChildren.set(key, { row: next, changed });
    else if (kept.changed && !changed) {
      childDeletes.push(kept.row.id);
      keptChildren.set(key, { row: next, changed });
    } else childDeletes.push(row.id);
  }
  for (const { row, changed } of keptChildren.values()) if (changed) childUpdates.push(row);

  return {
    relationshipDeletes,
    relationshipUpdates,
    childDeletes,
    childUpdates,
    relationshipCount: relationships.filter((row) =>
      duplicateSet.has(row.contact_id) || duplicateSet.has(row.related_contact_id)).length,
    childCount: children.filter((row) =>
      duplicateSet.has(row.contact_id) || row.linked_contact_id !== null && duplicateSet.has(row.linked_contact_id)).length,
  };
}

function moveContactConnections(
  db: Database.Database,
  primaryId: number,
  duplicateIds: number[],
  mergedAt: string,
): { relationships: number; children: number } {
  const ids = [primaryId, ...duplicateIds];
  const placeholders = ids.map(() => '?').join(', ');
  const relationships = db.prepare(`
    SELECT id, contact_id, related_contact_id
    FROM contact_relationships
    WHERE contact_id IN (${placeholders}) OR related_contact_id IN (${placeholders})
    ORDER BY id
  `).all(...ids, ...ids) as StoredContactRelationship[];
  const children = db.prepare(`SELECT id, contact_id, linked_contact_id FROM contact_children
    WHERE contact_id IN (${placeholders}) OR linked_contact_id IN (${placeholders}) ORDER BY id`)
    .all(...ids, ...ids) as StoredContactChildLink[];
  const plan = planContactConnectionMerge(primaryId, duplicateIds, relationships, children);
  const removeRelationship = db.prepare('DELETE FROM contact_relationships WHERE id = ?');
  const updateRelationship = db.prepare('UPDATE contact_relationships SET contact_id = ?, related_contact_id = ? WHERE id = ?');
  const removeChild = db.prepare('DELETE FROM contact_children WHERE id = ?');
  const updateChild = db.prepare('UPDATE contact_children SET contact_id = ?, linked_contact_id = ?, updated_at = ? WHERE id = ?');
  for (const id of plan.relationshipDeletes) removeRelationship.run(id);
  for (const id of plan.childDeletes) removeChild.run(id);
  for (const row of plan.relationshipUpdates) updateRelationship.run(row.contact_id, row.related_contact_id, row.id);
  for (const row of plan.childUpdates) updateChild.run(row.contact_id, row.linked_contact_id, mergedAt, row.id);
  return { relationships: plan.relationshipCount, children: plan.childCount };
}

export function mergeContacts(
  db: Database.Database,
  primaryId: number,
  duplicateIds: number[],
  mergedAt = new Date().toISOString()
): ContactMergeResult {
  const merge = db.transaction(() => {
    const { primary, duplicates } = validateContactMerge(db, primaryId, duplicateIds);
    const merged = buildMergedContact(primary, duplicates, mergedAt);
    const placeholders = duplicates.map(() => '?').join(', ');
    const ids = duplicates.map((contact) => contact.id);
    const groupIds = db.prepare(`
      SELECT DISTINCT group_id FROM contact_group_members WHERE contact_id IN (${placeholders})
    `).all(...ids) as Array<{ group_id: number }>;
    const addGroup = db.prepare(
      'INSERT OR IGNORE INTO contact_group_members (contact_id, group_id) VALUES (?, ?)'
    );
    for (const group of groupIds) addGroup.run(primaryId, group.group_id);
    db.prepare(`DELETE FROM contact_group_members WHERE contact_id IN (${placeholders})`).run(...ids);

    const movedConnections = moveContactConnections(db, primaryId, ids, mergedAt);
    db.prepare(`UPDATE contact_source_links SET contact_id = ? WHERE contact_id IN (${placeholders})`).run(primaryId, ...ids);

    const moved = {
      interactions: db.prepare(`UPDATE interactions SET contact_id = ? WHERE contact_id IN (${placeholders})`).run(primaryId, ...ids).changes,
      reminders: db.prepare(`UPDATE reminders SET contact_id = ? WHERE contact_id IN (${placeholders})`).run(primaryId, ...ids).changes,
      facts: db.prepare(`UPDATE relationship_facts SET contact_id = ? WHERE contact_id IN (${placeholders})`).run(primaryId, ...ids).changes,
      plans: db.prepare(`UPDATE plans SET contact_id = ? WHERE contact_id IN (${placeholders})`).run(primaryId, ...ids).changes,
      groups: groupIds.length,
      relationships: movedConnections.relationships,
      children: movedConnections.children,
    };

    db.prepare(`
      UPDATE contacts SET
        name = ?, nickname = ?, email = ?, phone = ?, photo_url = ?, birthday = ?, birthday_reminder_days = ?, how_we_met = ?,
        tags = ?, notes = ?, gift_ideas = ?, custom_fields = ?, last_contacted = ?,
        contact_frequency = ?, updated_at = ?, contact_methods = ?
      WHERE id = ?
    `).run(
      merged.name,
      merged.nickname,
      merged.email,
      merged.phone,
      merged.photo_url,
      merged.birthday,
      merged.birthday_reminder_days,
      merged.how_we_met,
      merged.tags,
      merged.notes,
      merged.gift_ideas,
      merged.custom_fields,
      merged.last_contacted,
      merged.contact_frequency,
      mergedAt,
      merged.contact_methods ?? '[]',
      primaryId
    );

    const deleted = db.prepare(`DELETE FROM contacts WHERE id IN (${placeholders})`).run(...ids);
    if (deleted.changes !== ids.length) throw new ContactMergeError('The duplicate contacts changed before the merge completed.');

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(primaryId) as Contact;
    return { contact, mergedContactIds: ids, moved };
  });
  return merge.immediate();
}
