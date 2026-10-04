import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import type { Contact } from './db.ts';
import type { ContactFieldValue } from './contact-input.ts';

const CONTACT_EDIT_REVISION_PATTERN = /^[a-f0-9]{64}$/;

export const EDITABLE_CONTACT_FIELDS = [
  'name',
  'nickname',
  'email',
  'phone',
  'photo_url',
  'birthday',
  'birthday_reminder_days',
  'how_we_met',
  'tags',
  'notes',
  'gift_ideas',
  'custom_fields',
  'last_contacted',
  'contact_frequency',
  'contact_methods',
] as const satisfies ReadonlyArray<keyof Contact>;

export class ContactRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContactRevisionError';
  }
}

export type ContactUpdateResult =
  | { status: 'updated'; contact: Contact; editRevision: string }
  | { status: 'conflict'; contact: Contact; editRevision: string }
  | { status: 'not-found' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function getExpectedContactRevision(value: unknown): string {
  if (!isRecord(value)) throw new ContactRevisionError('Contact payload must be an object.');
  if (typeof value.expected_edit_revision !== 'string') {
    throw new ContactRevisionError('Refresh this contact before saving changes.');
  }

  const revision = value.expected_edit_revision.trim().toLowerCase();
  if (!CONTACT_EDIT_REVISION_PATTERN.test(revision)) {
    throw new ContactRevisionError('Refresh this contact before saving changes.');
  }
  return revision;
}

export function getContactEditRevision(contact: Contact): string {
  const editableValues = EDITABLE_CONTACT_FIELDS.map((field) => contact[field]);
  return createHash('sha256').update(JSON.stringify(editableValues)).digest('hex');
}

export function updateContactIfCurrent(
  db: Database.Database,
  contactId: number,
  fields: Record<string, ContactFieldValue>,
  expectedRevision: string
): ContactUpdateResult {
  const update = db.transaction((): ContactUpdateResult => {
    const current = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) as Contact | undefined;
    if (!current) return { status: 'not-found' };

    const currentRevision = getContactEditRevision(current);
    if (currentRevision !== expectedRevision) {
      return { status: 'conflict', contact: current, editRevision: currentRevision };
    }

    const updates = Object.keys(fields).map((key) => `${key} = ?`);
    const values = Object.values(fields);
    db.prepare(`
      UPDATE contacts
      SET ${updates.join(', ')}, updated_at = ?
      WHERE id = ?
    `).run(...values, new Date().toISOString(), contactId);

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) as Contact;
    return {
      status: 'updated',
      contact,
      editRevision: getContactEditRevision(contact),
    };
  });

  return update.immediate();
}
