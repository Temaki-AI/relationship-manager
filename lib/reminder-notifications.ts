export const REMINDER_NOTIFICATION_PREFERENCE_KEY = 'bonds-reminder-notifications-enabled';
export const REMINDER_NOTIFICATION_LEDGER_KEY = 'bonds-reminder-notification-ledger-v1';
export const BIRTHDAY_NOTIFICATION_LEDGER_KEY = 'bonds-birthday-notification-ledger-v1';
export const REMINDER_NOTIFICATION_POLL_INTERVAL_MS = 60_000;

export function accountNotificationStorageKey(baseKey: string, accountScope: string): string {
  if (!accountScope || accountScope.length > 200) throw new Error('A verified account scope is required.');
  return `${baseKey}:${encodeURIComponent(accountScope)}`;
}

const MAX_LEDGER_ENTRIES = 2_000;

export type ReminderNotificationCandidate = {
  id: number;
  remind_at: string;
};

export type ReminderNotificationCheck = {
  newDueCount: number;
  nextLedger: string[];
};

export type BirthdayNotificationCandidate = {
  id: number;
  occurrence: string;
};

function getReminderKey(reminder: ReminderNotificationCandidate): string | null {
  if (!Number.isInteger(reminder.id) || reminder.id <= 0) return null;
  if (typeof reminder.remind_at !== 'string' || reminder.remind_at.length > 50) return null;
  const timestamp = Date.parse(reminder.remind_at);
  if (Number.isNaN(timestamp)) return null;
  return `${reminder.id}@${reminder.remind_at}`;
}

export function parseReminderNotificationLedger(value: string | null): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.filter((entry): entry is string => (
      typeof entry === 'string'
      && entry.length <= 80
      && /^\d+@\d{4}-\d{2}-\d{2}T/.test(entry)
    )))).slice(-MAX_LEDGER_ENTRIES);
  } catch {
    return [];
  }
}

export function prepareReminderNotificationCheck(
  reminders: ReminderNotificationCandidate[],
  previousLedger: string[],
  now = new Date()
): ReminderNotificationCheck {
  const validReminders = reminders.flatMap((reminder) => {
    const key = getReminderKey(reminder);
    return key ? [{ key, timestamp: Date.parse(reminder.remind_at) }] : [];
  });
  const openKeys = new Set(validReminders.map((reminder) => reminder.key));
  const previousKeys = new Set(previousLedger.filter((key) => openKeys.has(key)));
  const newDueKeys = validReminders
    .filter((reminder) => reminder.timestamp <= now.getTime() && !previousKeys.has(reminder.key))
    .map((reminder) => reminder.key);

  return {
    newDueCount: newDueKeys.length,
    nextLedger: Array.from(new Set([...previousKeys, ...newDueKeys])).slice(-MAX_LEDGER_ENTRIES),
  };
}

export function parseBirthdayNotificationLedger(value: string | null): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.filter((entry): entry is string => (
      typeof entry === 'string'
      && entry.length <= 40
      && /^\d+@\d{4}-\d{2}-\d{2}$/.test(entry)
    )))).slice(-MAX_LEDGER_ENTRIES);
  } catch {
    return [];
  }
}

export function prepareBirthdayNotificationCheck(
  birthdays: BirthdayNotificationCandidate[],
  previousLedger: string[]
): ReminderNotificationCheck {
  const keys = birthdays.flatMap((birthday) => (
    Number.isInteger(birthday.id)
      && birthday.id > 0
      && /^\d{4}-\d{2}-\d{2}$/.test(birthday.occurrence)
      ? [`${birthday.id}@${birthday.occurrence}`]
      : []
  ));
  const activeKeys = new Set(keys);
  const previousKeys = new Set(previousLedger.filter((key) => activeKeys.has(key)));
  const newDueKeys = keys.filter((key) => !previousKeys.has(key));

  return {
    newDueCount: newDueKeys.length,
    nextLedger: Array.from(new Set([...previousKeys, ...newDueKeys])).slice(-MAX_LEDGER_ENTRIES),
  };
}
