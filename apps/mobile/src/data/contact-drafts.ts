import type { SQLiteDatabase } from 'expo-sqlite';
import type { ContactFieldEditBase } from './contacts';

export type ContactFormFields = { name: string; email: string; phone: string; notes: string; frequency: string };
export type ContactFormDraft = { version: 1; fields: ContactFormFields; base: ContactFieldEditBase | null };
const PREFIX = 'contact-form:v1:';

export function contactDraftKey(id?: string) {
  if (id !== undefined && (!id || id.length > 200 || /[\u0000-\u001f]/.test(id))) throw new Error('This person is not available.');
  return id === undefined ? PREFIX + 'new' : PREFIX + 'edit:' + id;
}

function checkKey(key: string) {
  if (key !== contactDraftKey() && (!key.startsWith(PREFIX + 'edit:') || key !== contactDraftKey(key.slice((PREFIX + 'edit:').length)))) {
    throw new Error('Choose an available contact draft.');
  }
}

export function contactForm(base: ContactFieldEditBase | null = null): ContactFormDraft {
  return { version: 1, base: base ? { id: base.id, name: base.name, email: base.email, phone: base.phone,
    notes: base.notes, contact_frequency: base.contact_frequency, remote_revision: base.remote_revision } : null,
    fields: { name: base?.name ?? '', email: base?.email ?? '', phone: base?.phone ?? '',
    notes: base?.notes ?? '', frequency: String(base?.contact_frequency ?? 14) } };
}

function parseDraft(value: string, key: string): ContactFormDraft {
  if (value.length > 750_000) throw new Error('The saved form is too large to open.');
  const draft = JSON.parse(value) as ContactFormDraft;
  const limits: Record<keyof ContactFormFields, number> = { name: 200, email: 320, phone: 100, notes: 50_000, frequency: 4 };
  if (!draft || draft.version !== 1 || !draft.fields || Object.entries(limits).some(([field, limit]) => {
    const value = draft.fields[field as keyof ContactFormFields];
    return typeof value !== 'string' || value.length > limit;
  })) throw new Error('The saved form cannot be opened. It has been kept on this phone.');
  const base = draft.base;
  if (key === contactDraftKey() ? base !== null : !base || contactDraftKey(base.id) !== key
    || typeof base.name !== 'string' || base.name.length > 200
    || !Number.isInteger(base.contact_frequency) || base.contact_frequency < 1 || base.contact_frequency > 3650
    || base.remote_revision !== null && (!Number.isSafeInteger(base.remote_revision) || base.remote_revision < 0)
    || (['email', 'phone', 'notes'] as const).some((field) => base[field] !== null
      && (typeof base[field] !== 'string' || base[field]!.length > limits[field]))) {
    throw new Error('The saved form belongs to a different person or cannot be opened. It has been kept on this phone.');
  }
  // Store only the form and the original edit base, never arbitrary properties.
  return { version: 1, fields: { name: draft.fields.name, email: draft.fields.email, phone: draft.fields.phone,
    notes: draft.fields.notes, frequency: draft.fields.frequency }, base: base ? { id: base.id, name: base.name,
    email: base.email, phone: base.phone, notes: base.notes, contact_frequency: base.contact_frequency,
    remote_revision: base.remote_revision } : null };
}

export async function readContactDraft(db: SQLiteDatabase, key: string): Promise<ContactFormDraft | null> {
  checkKey(key);
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_metadata WHERE key = ?', key);
  return row ? parseDraft(row.value, key) : null;
}

export async function writeContactDraft(db: SQLiteDatabase, key: string, draft: ContactFormDraft) {
  checkKey(key);
  const value = JSON.stringify(parseDraft(JSON.stringify(draft), key));
  await db.runAsync('INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    key, value, new Date().toISOString());
}

export async function clearContactDraft(db: SQLiteDatabase, key: string) {
  checkKey(key);
  await db.runAsync('DELETE FROM app_metadata WHERE key = ?', key);
}

/** Serialize keystrokes and close the writer before committing or discarding a form. */
export function contactDraftSession(db: SQLiteDatabase, key: string) {
  checkKey(key);
  let pending: Promise<void> = Promise.resolve(), closed = false;
  return {
    write(draft: ContactFormDraft) {
      if (closed) return Promise.reject(new Error('This form is being saved.'));
      let snapshot: ContactFormDraft;
      try { snapshot = parseDraft(JSON.stringify(draft), key); }
      catch (error) { return Promise.reject(error); }
      const task = pending.catch(() => {}).then(() => writeContactDraft(db, key, snapshot));
      pending = task;
      void task.catch(() => {});
      return task;
    },
    async finish<T>(action: () => Promise<T>, discard = false): Promise<T> {
      if (closed) throw new Error('This form is already being saved.');
      closed = true;
      try { if (discard) await pending.catch(() => {}); else await pending; return await action(); }
      catch (error) { closed = false; throw error; }
    },
  };
}
