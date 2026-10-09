import { isSyncUuid } from './sync.ts';

export type ContextEntity = 'family' | 'plan' | 'relationship';
export function contextDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}
function text(value: unknown, label: string, limit: number, required = false, connection = false): string | null {
  if (value == null || value === '') { if (required) throw new Error(`${label} is required.`); return null; }
  if (typeof value !== 'string') throw new Error(`${label} is invalid.`);
  const normalized = connection ? value.trim().replace(/\s+/gu, ' ') : value.trim();
  if (!normalized) { if (required) throw new Error(`${label} is required.`); return null; }
  if (normalized.length > limit || connection && /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error(`${label} is invalid or too long.`);
  return normalized;
}
export function normalizeContextFields(entity: ContextEntity, input: Record<string, unknown>): Record<string, string | null> {
  if (entity === 'plan') {
    if (!['call', 'message', 'meetup', 'email'].includes(String(input.type))) throw new Error('Choose a plan type.');
    const date = contextDate(input.planned_date); if (!date) throw new Error('Choose a valid planned date (YYYY-MM-DD).');
    return { type: String(input.type), planned_date: date, summary: text(input.summary, 'Summary', 500), notes: text(input.notes, 'Notes', 10_000) };
  }
  if (entity === 'family') {
    const birthday = input.birthday == null || input.birthday === '' ? null : contextDate(input.birthday);
    if (input.birthday != null && input.birthday !== '' && birthday === null) throw new Error('Choose a valid birthday (YYYY-MM-DD).');
    const linked = input.linked_contact_id == null || input.linked_contact_id === '' ? null : input.linked_contact_id;
    if (linked !== null && !isSyncUuid(linked)) throw new Error('Choose an available linked profile.');
    return { name: text(input.name, 'Child name', 200, true, true), birthday, linked_contact_id: linked as string | null };
  }
  if (!isSyncUuid(input.related_contact_id)) throw new Error('Choose a related person.');
  return { related_contact_id: input.related_contact_id,
    relationship_label: text(input.relationship_label, 'Relationship label', 80, true, true),
    reciprocal_label: text(input.reciprocal_label, 'Reciprocal label', 80, true, true) };
}
