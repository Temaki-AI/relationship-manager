import { civilDaysBetween, dateInTimeZone, normalizeTimeZone } from './civil-date.ts';
import { parseDateOnly } from './relationship-validation.ts';

export const MAX_ACTIVE_TODAY_SNOOZES = 500;

export type TodaySnooze = {
  id: string;
  contact_id: number;
  reminder_id: number | null;
  until_date: string;
  contact_name?: string;
  reminder_title?: string | null;
};

export type TodaySnoozeTarget =
  | { kind: 'reminder'; id: number }
  | { kind: 'birthday' | 'overdue'; id: number };

export function parseTodaySnoozeTarget(value: unknown): TodaySnoozeTarget | null {
  if (typeof value !== 'string') return null;
  const match = /^(reminder|birthday|overdue)-([1-9]\d*)$/u.exec(value);
  if (!match) return null;
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id)) return null;
  return { kind: match[1] as TodaySnoozeTarget['kind'], id };
}

export function parseTodaySnoozeUntil(value: unknown, now: Date, timeZone: string): string | null {
  const until = parseDateOnly(value);
  if (!until) return null;
  const today = dateInTimeZone(now, normalizeTimeZone(timeZone));
  if (!today) return null;
  const days = civilDaysBetween(today, until);
  return days >= 1 && days <= 30 ? until : null;
}

export function activeTodaySnoozeIds(snoozes: readonly TodaySnooze[], now: Date, timeZone: string): Set<string> {
  const today = dateInTimeZone(now, normalizeTimeZone(timeZone));
  return new Set(snoozes.filter((item) => today && item.until_date > today).map((item) => item.id));
}
