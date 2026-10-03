import type Database from 'better-sqlite3';
import { normalizeContactPatchInput } from './contact-input.ts';
import {
  normalizeVCardContact,
  type ParsedVCardContact,
} from './vcard.ts';

export type ContactIdentity = {
  name: string;
  email: string | null;
  phone: string | null;
  birthday: string | null;
  custom_fields?: string | null;
};

export type ContactImportResult = {
  imported: number;
  skippedDuplicates: number;
  skippedInvalid: number;
  errors: string[];
};

function normalizePhoneIdentity(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
}

export function getContactIdentityKeys(contact: ContactIdentity): string[] {
  const keys: string[] = [];
  let additionalEmails: string[] = [];
  let additionalPhones: string[] = [];
  if (contact.custom_fields) {
    try {
      const customFields = JSON.parse(contact.custom_fields) as { vcard?: Record<string, unknown> };
      const vcard = customFields.vcard;
      if (vcard && Array.isArray(vcard.additional_emails)) {
        additionalEmails = vcard.additional_emails.filter((value): value is string => typeof value === 'string');
      }
      if (vcard && Array.isArray(vcard.additional_phones)) {
        additionalPhones = vcard.additional_phones.filter((value): value is string => typeof value === 'string');
      }
    } catch {
      // Invalid legacy metadata should not block an otherwise valid identity.
    }
  }

  const emails = [contact.email, ...additionalEmails]
    .flatMap((value) => value?.trim().toLowerCase() || [])
    .filter((value, index, values) => values.indexOf(value) === index);
  const phones = [contact.phone, ...additionalPhones]
    .flatMap((value) => normalizePhoneIdentity(value) || [])
    .filter((value, index, values) => values.indexOf(value) === index);
  for (const email of emails) keys.push(`email:${email}`);
  for (const phone of phones) keys.push(`phone:${phone}`);
  if (emails.length === 0 && phones.length === 0 && contact.birthday) {
    keys.push(`name-birthday:${contact.name.trim().toLowerCase()}|${contact.birthday}`);
  }
  return keys;
}

export function importVCardContacts(
  db: Database.Database,
  contacts: ParsedVCardContact[],
  importedAt = new Date().toISOString()
): ContactImportResult {
  const result: ContactImportResult = {
    imported: 0,
    skippedDuplicates: 0,
    skippedInvalid: 0,
    errors: [],
  };

  const insert = db.prepare(`
    INSERT INTO contacts (
      name, nickname, email, phone, photo_url, birthday, birthday_reminder_days, how_we_met,
      tags, notes, gift_ideas, custom_fields, last_contacted, contact_frequency
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const importBatch = db.transaction(() => {
    const existing = db.prepare('SELECT name, email, phone, birthday, custom_fields FROM contacts')
      .all() as ContactIdentity[];
    const identities = new Set(existing.flatMap(getContactIdentityKeys));

    for (const contact of contacts) {
      try {
        const normalized = normalizeVCardContact(contact, importedAt);
        const lastContacted = normalized.last_contacted
          ? normalizeContactPatchInput({ last_contacted: normalized.last_contacted }).last_contacted
          : null;
        const keys = getContactIdentityKeys(normalized);
        if (keys.some((key) => identities.has(key))) {
          result.skippedDuplicates++;
          continue;
        }

        insert.run(
          normalized.name,
          normalized.nickname,
          normalized.email,
          normalized.phone,
          normalized.photo_url,
          normalized.birthday,
          normalized.birthday_reminder_days,
          normalized.how_we_met,
          normalized.tags,
          normalized.notes,
          normalized.gift_ideas,
          normalized.custom_fields,
          lastContacted,
          normalized.contact_frequency
        );
        keys.forEach((key) => identities.add(key));
        result.imported++;
      } catch (error) {
        result.skippedInvalid++;
        const label = contact.name || contact.emails[0] || 'Unnamed contact';
        const message = error instanceof Error ? error.message : 'Invalid contact';
        if (result.errors.length < 20) result.errors.push(`${label}: ${message}`);
      }
    }
  });
  importBatch.immediate();

  return result;
}
