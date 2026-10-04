import type Database from 'better-sqlite3';
import { getDuplicateSignals } from './contact-merge.ts';
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
  contact_methods?: string;
};

export type ContactImportResult = {
  imported: number;
  skippedDuplicates: number;
  skippedInvalid: number;
  errors: string[];
};

export function getContactIdentityKeys(contact: ContactIdentity): string[] {
  const signals = getDuplicateSignals({ ...contact, custom_fields: contact.custom_fields ?? null });
  const addresses = signals.filter((item) => item.kind !== 'name_birthday');
  return [...new Set((addresses.length ? addresses : signals).map((item) => item.key))];
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
      tags, notes, gift_ideas, custom_fields, last_contacted, contact_frequency, contact_methods
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const importBatch = db.transaction(() => {
    const existing = db.prepare('SELECT name, email, phone, birthday, custom_fields, contact_methods FROM contacts')
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
          normalized.contact_frequency,
          normalized.contact_methods ?? 'null'
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
