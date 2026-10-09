import { civilDaysBetween, dateInTimeZone, normalizeTimeZone } from './civil-date.ts';
import { isSyncUuid } from './sync.ts';

export const MAX_ACTIVE_TODAY_SNOOZES = 500;
export type PromptKind = 'birthday' | 'overdue' | 'reminder';
export type PromptSnooze = { kind: PromptKind; targetId: string; contactId: string; untilDate: string };
export type PromptMutation = { version: 1; operationId: string; epoch: string; kind: PromptKind;
  targetId: string; baseUntilDate: string | null; untilDate: string | null; timeZone: string };
export class PromptSnoozeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = 'invalid_prompt') { super(message); this.status = status; this.code = code; }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isPromptKind = (value: unknown): value is PromptKind => ['birthday', 'overdue', 'reminder'].includes(String(value));
export function isPromptDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const instant = new Date(value + 'T12:00:00Z');
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}
export function promptUntil(days: number, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new PromptSnoozeError('Choose a date within the next 30 days.');
  const today = dateInTimeZone(now, normalizeTimeZone(timeZone));
  if (!today) throw new PromptSnoozeError('Could not read today’s date.');
  const day = new Date(today + 'T12:00:00Z'); day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}
export function validatePromptUntil(until: string | null, now: Date, timeZone: string) {
  if (until === null) return;
  const today = dateInTimeZone(now, normalizeTimeZone(timeZone));
  const days = today && isPromptDate(until) ? civilDaysBetween(today, until) : NaN;
  if (!(days >= 1 && days <= 30)) throw new PromptSnoozeError('Choose a date within the next 30 days.', 400, 'invalid_until');
}
export function readPromptMutation(value: unknown): PromptMutation {
  const keys = ['version', 'operationId', 'epoch', 'kind', 'targetId', 'baseUntilDate', 'untilDate', 'timeZone'];
  if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))
    || value.version !== 1 || !isSyncUuid(value.operationId) || !isSyncUuid(value.epoch) || !isSyncUuid(value.targetId)
    || !isPromptKind(value.kind) || !(value.baseUntilDate === null || isPromptDate(value.baseUntilDate))
    || !(value.untilDate === null || isPromptDate(value.untilDate)) || typeof value.timeZone !== 'string'
    || value.timeZone.length > 100 || normalizeTimeZone(value.timeZone) !== value.timeZone) {
    throw new PromptSnoozeError('Choose a valid prompt and its original saved preference.');
  }
  return value as PromptMutation;
}
export function readPromptSnapshot(value: unknown, epoch: string): PromptSnooze[] {
  if (!object(value) || value.version !== 1 || value.epoch !== epoch || !Array.isArray(value.snoozes)
    || value.snoozes.length > MAX_ACTIVE_TODAY_SNOOZES || Object.keys(value).some((key) => !['version', 'epoch', 'snoozes'].includes(key))) {
    throw new PromptSnoozeError('The server did not confirm the current prompt preferences.', 502, 'invalid_snapshot');
  }
  const seen = new Set<string>();
  return value.snoozes.map((row) => {
    if (!object(row) || Object.keys(row).length !== 4 || Object.keys(row).some((key) => !['kind', 'targetId', 'contactId', 'untilDate'].includes(key))
      || !isPromptKind(row.kind) || !isSyncUuid(row.targetId) || !isSyncUuid(row.contactId) || !isPromptDate(row.untilDate)
      || row.kind !== 'reminder' && row.targetId !== row.contactId || seen.has(`${row.kind}:${row.targetId}`)) {
      throw new PromptSnoozeError('The server returned incomplete prompt preferences. Your saved choices are safe.', 502, 'invalid_snapshot');
    }
    seen.add(`${row.kind}:${row.targetId}`); return row as PromptSnooze;
  });
}
export function readPromptAcknowledgement(value: unknown, mutation: PromptMutation) {
  if (!object(value) || Object.keys(value).length !== 6 || Object.keys(value).some((key) => !['version', 'epoch', 'operationId', 'kind', 'targetId', 'untilDate'].includes(key))
    || value.version !== 1 || value.epoch !== mutation.epoch || value.operationId !== mutation.operationId
    || value.kind !== mutation.kind || value.targetId !== mutation.targetId || value.untilDate !== mutation.untilDate) {
    throw new PromptSnoozeError('The server did not confirm this choice. Retry the unchanged operation.', 502, 'invalid_ack');
  }
  return mutation.untilDate;
}
