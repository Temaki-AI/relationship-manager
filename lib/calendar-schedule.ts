import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseDateOnly, parseDateTime } from './relationship-validation.ts';
import { contactSourceWriteEpoch } from './contact-source-storage.ts';

export type CalendarScheduleKind = 'plan' | 'reminder';
export type CalendarScheduleRecord = Record<string, string | number | null>;
export type CalendarScheduleInput = { expected_revision: string; original_at: string; at: string };
export class CalendarScheduleError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'CalendarScheduleError'; this.status = status; }
}
const fields = {
  plan: ['id', 'workspace_id', 'public_id', 'created_at', 'contact_id', 'type', 'planned_date', 'summary', 'notes', 'completed_at'],
  reminder: ['id', 'workspace_id', 'public_id', 'created_at', 'contact_id', 'title', 'remind_at', 'notes', 'completed_at'],
} as const;
export const calendarScheduleField = (kind: CalendarScheduleKind) => kind === 'plan' ? 'planned_date' : 'remind_at';
function normalizedAt(kind: CalendarScheduleKind, value: unknown) {
  return kind === 'plan' ? parseDateOnly(value) : parseDateTime(value);
}
export function calendarScheduleRevision(kind: CalendarScheduleKind, record: CalendarScheduleRecord) {
  return createHash('sha256').update(JSON.stringify([kind, record.schedule_epoch ?? null, ...fields[kind].map((key) => [key,
    key === calendarScheduleField(kind) ? normalizedAt(kind, record[key]) : record[key] ?? null,
  ])])).digest('hex');
}
export function withCalendarScheduleRevision(kind: CalendarScheduleKind, record: CalendarScheduleRecord) {
  return { ...record, schedule_revision: calendarScheduleRevision(kind, record) };
}
export function readCalendarScheduleInput(kind: CalendarScheduleKind, body: unknown): CalendarScheduleInput {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('calendar_schedule' in body)) {
    throw new CalendarScheduleError('A date-only Calendar review is required.');
  }
  const raw = body.calendar_schedule;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 3
    || Object.keys(raw).some((key) => !['expected_revision', 'original_at', 'at'].includes(key)) || !('expected_revision' in raw)
    || typeof raw.expected_revision !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.expected_revision) || !('original_at' in raw) || !('at' in raw)) {
    throw new CalendarScheduleError('Refresh this event before reviewing its date.');
  }
  const original = normalizedAt(kind, raw.original_at), at = normalizedAt(kind, raw.at);
  if (!original || !at) throw new CalendarScheduleError(kind === 'plan' ? 'Choose a valid plan date.' : 'Choose a valid reminder date and time.');
  return { expected_revision: raw.expected_revision, original_at: original, at };
}
export function calendarScheduleState(kind: CalendarScheduleKind, record: CalendarScheduleRecord, input: CalendarScheduleInput) {
  if (record.completed_at !== null) throw new CalendarScheduleError('This event is completed. Its saved history and date are retained.', 409);
  const current = normalizedAt(kind, record[calendarScheduleField(kind)]);
  // An unchanged retry confirms the same date without another write or completion.
  if (current === input.at && calendarScheduleRevision(kind, { ...record, [calendarScheduleField(kind)]: input.original_at }) === input.expected_revision) return 'confirmed';
  if (current !== input.original_at || calendarScheduleRevision(kind, record) !== input.expected_revision) {
    throw new CalendarScheduleError('This event changed after you opened it. Review its current date before saving again.', 409);
  }
  return 'update';
}
export function calendarScheduleStatement(kind: CalendarScheduleKind, record: CalendarScheduleRecord, at: string) {
  const keys = fields[kind].filter((key) => Object.hasOwn(record, key));
  const cloud = typeof record.workspace_id === 'string' && typeof record.schedule_epoch === 'string';
  const guard = cloud ? " AND EXISTS (SELECT 1 FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id WHERE s.workspace_id = ? AND s.epoch = ? AND s.paused = 0 AND w.lifecycle = 'active')" : '';
  return { sql: `UPDATE ${kind === 'plan' ? 'plans' : 'reminders'} SET ${calendarScheduleField(kind)} = ? WHERE ${keys.map((key) => `${key} IS ?`).join(' AND ')}${guard} RETURNING *`,
    values: [at, ...keys.map((key) => record[key]), ...(cloud ? [record.workspace_id, record.schedule_epoch] : [])] };
}
export function localCalendarScheduleRecord(db: Database.Database, kind: CalendarScheduleKind, id: number) {
  const record = db.prepare(`SELECT * FROM ${kind === 'plan' ? 'plans' : 'reminders'} WHERE id = ?`).get(id) as CalendarScheduleRecord | undefined;
  return record ? { ...record, schedule_epoch: contactSourceWriteEpoch(db) } : undefined;
}
export function rescheduleLocalCalendarEvent(db: Database.Database, kind: CalendarScheduleKind, id: number, input: CalendarScheduleInput) {
  return db.transaction(() => {
    const current = localCalendarScheduleRecord(db, kind, id);
    if (!current) throw new CalendarScheduleError('This event is no longer available.', 404);
    if (calendarScheduleState(kind, current, input) === 'confirmed') return { record: withCalendarScheduleRevision(kind, current), dateChanged: false };
    const statement = calendarScheduleStatement(kind, current, input.at);
    const updated = db.prepare(statement.sql).get(...statement.values) as CalendarScheduleRecord;
    if (!updated) throw new CalendarScheduleError('This event changed after you opened it. Review it again.', 409);
    return { record: withCalendarScheduleRevision(kind, { ...updated, schedule_epoch: current.schedule_epoch }), dateChanged: true };
  }).immediate();
}
