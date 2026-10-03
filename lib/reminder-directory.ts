import type Database from 'better-sqlite3';
import type { Pagination } from './contact-directory.ts';
import { dateInTimeZone, nextBirthdayOccurrence } from './civil-date.ts';
import type {
  BirthdayNotificationCandidate,
  ReminderNotificationCandidate,
} from './reminder-notifications.ts';

export const DEFAULT_REMINDER_PAGE_SIZE = 50;
export const MAX_REMINDER_PAGE_SIZE = 100;
export const MAX_NOTIFICATION_CANDIDATES = 2_000;

export type ReminderDirectoryItem = {
  id: number;
  contact_id: number;
  contact_name: string;
  title: string;
  notes: string | null;
  remind_at: string;
};

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function buildPagination(total: number, requestedPage: unknown, requestedPageSize: unknown): Pagination {
  const pageSize = boundedInteger(
    requestedPageSize,
    DEFAULT_REMINDER_PAGE_SIZE,
    MAX_REMINDER_PAGE_SIZE
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(boundedInteger(requestedPage, 1, Number.MAX_SAFE_INTEGER), totalPages);
  return { page, pageSize, total, totalPages };
}

export function listReminderPage(
  db: Database.Database,
  options: { page?: unknown; pageSize?: unknown } = {}
): { reminders: ReminderDirectoryItem[]; pagination: Pagination } {
  const total = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM reminders
    WHERE completed_at IS NULL
  `).get() as { count: number }).count;
  const pagination = buildPagination(total, options.page, options.pageSize);
  const reminders = db.prepare(`
    SELECT
      reminders.id,
      reminders.contact_id,
      contacts.name AS contact_name,
      reminders.title,
      reminders.notes,
      reminders.remind_at
    FROM reminders
    JOIN contacts ON contacts.id = reminders.contact_id
    WHERE reminders.completed_at IS NULL
    ORDER BY julianday(reminders.remind_at) ASC, reminders.id ASC
    LIMIT ? OFFSET ?
  `).all(
    pagination.pageSize,
    (pagination.page - 1) * pagination.pageSize
  ) as ReminderDirectoryItem[];

  return { reminders, pagination };
}

export function listNotificationCandidates(
  db: Database.Database,
  now = new Date()
): ReminderNotificationCandidate[] {
  return db.prepare(`
    SELECT id, remind_at
    FROM reminders
    WHERE completed_at IS NULL AND julianday(remind_at) <= julianday(?)
    ORDER BY julianday(remind_at) DESC, id DESC
    LIMIT ?
  `).all(now.toISOString(), MAX_NOTIFICATION_CANDIDATES) as ReminderNotificationCandidate[];
}

export function listBirthdayNotificationCandidates(
  db: Database.Database,
  now = new Date(),
  timeZone = 'UTC'
): BirthdayNotificationCandidate[] {
  const rows = db.prepare(`
    SELECT id, birthday, birthday_reminder_days
    FROM contacts
    WHERE birthday IS NOT NULL
    ORDER BY id
  `).iterate() as IterableIterator<{
    id: number;
    birthday: string;
    birthday_reminder_days: number;
  }>;
  const candidates: BirthdayNotificationCandidate[] = [];
  const today = dateInTimeZone(now, timeZone)!;

  for (const row of rows) {
    const next = nextBirthdayOccurrence(row.birthday, today);
    if (!next || next.daysUntil > row.birthday_reminder_days) continue;
    candidates.push({ id: row.id, occurrence: next.occurrence });
    if (candidates.length === MAX_NOTIFICATION_CANDIDATES) break;
  }

  return candidates;
}
