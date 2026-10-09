import type { SQLiteDatabase } from 'expo-sqlite';
import type { ContextRecord } from './context';
import { normalizeContextFields, type ContextEntity } from '../../../../packages/domain/src/relationship-context';
import { isSyncUuid } from '../../../../packages/domain/src/sync';
import { getReminderPresetDate, REMINDER_PRESETS, type ReminderPresetId } from '../domain/reminder';

export type ContextFormDraft = { version: 1; kind: ContextEntity; contactId: string; base: ContextRecord | null; fields: Record<string, string | null> };
export type ReminderFormDraft = { version: 1; kind: 'reminder'; contactId: string; title: string; notes: string;
  preset: ReminderPresetId; remindAt: string; timeZone: string };
export type JournalDraft = ContextFormDraft | ReminderFormDraft;
type Kind = JournalDraft['kind'];
const PREFIX = 'journal-form:v1:';
const LIMITS: Record<ContextEntity, Record<string, number>> = {
  plan: { type: 10, planned_date: 10, summary: 500, notes: 10_000 },
  family: { name: 200, birthday: 10, linked_contact_id: 36 },
  relationship: { related_contact_id: 36, relationship_label: 80, reciprocal_label: 80 },
};

export function journalDraftKey(kind: Kind, contactId = '', id = '') {
  if (!['plan', 'family', 'relationship', 'reminder'].includes(kind) || contactId && !isSyncUuid(contactId)
    || id && (!isSyncUuid(id) || kind === 'reminder')) throw new Error('Choose an available form.');
  return PREFIX + kind + (id ? ':edit:' + id : ':new:' + (contactId || 'any'));
}

function keyParts(key: string): { kind: Kind; id: string; contactId: string } {
  const match = /^journal-form:v1:(plan|family|relationship|reminder):(new|edit):([a-z0-9-]+)$/i.exec(key);
  if (!match) throw new Error('Choose an available saved form.');
  const kind = match[1] as Kind, id = match[2] === 'edit' ? match[3] : '', contactId = !id && match[3] !== 'any' ? match[3] : '';
  if (journalDraftKey(kind, contactId, id) !== key) throw new Error('Choose an available saved form.');
  return { kind, id, contactId };
}

export function contextForm(kind: ContextEntity, contactId: string, base: ContextRecord | null = null, now = new Date()): ContextFormDraft {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const fields: Record<string, string | null> = kind === 'plan' ? { type: 'meetup', planned_date: today, summary: '', notes: '' }
    : kind === 'family' ? { name: '', birthday: '', linked_contact_id: null }
      : { related_contact_id: null, relationship_label: '', reciprocal_label: '' };
  const original = base ? { id: base.id, contact_id: base.contact_id, remote_revision: base.remote_revision,
    ...Object.fromEntries(Object.keys(LIMITS[kind]).map((field) => [field, base[field]])) } : null;
  return { version: 1, kind, contactId: base?.contact_id ?? contactId, base: original,
    fields: base ? Object.fromEntries(Object.keys(LIMITS[kind]).map((field) => [field, base[field] as string | null])) : fields };
}

export function reminderForm(contactId = '', now = new Date()): ReminderFormDraft {
  return { version: 1, kind: 'reminder', contactId, title: '', notes: '', preset: 'tomorrow',
    remindAt: getReminderPresetDate('tomorrow', now).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

function parse(value: string, key: string): JournalDraft {
  const parts = keyParts(key);
  if (value.length > 150_000) throw new Error('The saved form is too large to open. It is still on this phone.');
  const draft = JSON.parse(value) as JournalDraft;
  if (!draft || draft.version !== 1 || draft.kind !== parts.kind || typeof draft.contactId !== 'string'
    || draft.contactId && !isSyncUuid(draft.contactId) || draft.kind !== 'reminder' && parts.contactId && parts.contactId !== draft.contactId) {
    throw new Error('This saved form cannot be opened. It is still on this phone.');
  }
  if (draft.kind === 'reminder') {
    if (typeof draft.title !== 'string' || draft.title.length > 200 || typeof draft.notes !== 'string' || draft.notes.length > 10_000
      || !REMINDER_PRESETS.some((preset) => preset.id === draft.preset) || typeof draft.remindAt !== 'string'
      || !Number.isFinite(Date.parse(draft.remindAt)) || new Date(draft.remindAt).toISOString() !== draft.remindAt
      || typeof draft.timeZone !== 'string' || draft.timeZone.length > 100) throw new Error('The reminder draft cannot be opened. It is still on this phone.');
    return { version: 1, kind: 'reminder', contactId: draft.contactId, title: draft.title, notes: draft.notes,
      preset: draft.preset, remindAt: draft.remindAt, timeZone: draft.timeZone };
  }
  const limits = LIMITS[draft.kind];
  if (!draft.fields || Object.entries(limits).some(([field, limit]) => draft.fields[field] !== null
    && (typeof draft.fields[field] !== 'string' || draft.fields[field]!.length > limit))) throw new Error('The saved fields cannot be opened. They are still on this phone.');
  const base = draft.base;
  if (parts.id ? !base || base.id !== parts.id || !isSyncUuid(base.contact_id) || base.contact_id !== draft.contactId
    || base.remote_revision !== null && (!Number.isSafeInteger(base.remote_revision) || base.remote_revision < 0) : base !== null) {
    throw new Error('This saved edit belongs to a different item. It is still on this phone.');
  }
  if (base) {
    normalizeContextFields(draft.kind, base);
    if (Object.entries(limits).some(([field, limit]) => base[field] !== null
      && (typeof base[field] !== 'string' || base[field]!.length > limit))) throw new Error('The original edit version cannot be opened. It is still on this phone.');
  }
  return { version: 1, kind: draft.kind, contactId: draft.contactId,
    base: base ? { id: base.id, contact_id: base.contact_id, remote_revision: base.remote_revision,
      ...Object.fromEntries(Object.keys(limits).map((field) => [field, base[field]])) } : null,
    fields: Object.fromEntries(Object.keys(limits).map((field) => [field, draft.fields[field]])) };
}

export async function readJournalDraft(db: SQLiteDatabase, key: string): Promise<JournalDraft | null> {
  keyParts(key);
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_metadata WHERE key = ?', key);
  return row ? parse(row.value, key) : null;
}

export async function clearJournalDraft(db: SQLiteDatabase, key: string) {
  keyParts(key); await db.runAsync('DELETE FROM app_metadata WHERE key = ?', key);
}

export function journalDraftSession(db: SQLiteDatabase, key: string) {
  keyParts(key);
  let pending: Promise<void> = Promise.resolve(), closed = false;
  return {
    write(draft: JournalDraft): Promise<void> {
      if (closed) return Promise.reject(new Error('This form is being saved.'));
      let value: string;
      try { value = JSON.stringify(parse(JSON.stringify(draft), key)); }
      catch (error) { return Promise.reject(error); }
      const task = pending.catch(() => {}).then(async () => {
        await db.runAsync('INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          key, value, new Date().toISOString());
      });
      pending = task; void task.catch(() => {}); return task;
    },
    async finish<T>(action: () => Promise<T>, discard = false): Promise<T> {
      if (closed) throw new Error('This form is already being saved.');
      closed = true;
      try { if (discard) await pending.catch(() => {}); else await pending; return await action(); }
      catch (error) { closed = false; throw error; }
    },
  };
}
