export const REMINDER_PRESETS = [
  { id: 'tomorrow', label: 'Tomorrow', detail: '9:00 AM', days: 1 },
  { id: 'three-days', label: 'In 3 days', detail: '9:00 AM', days: 3 },
  { id: 'next-week', label: 'Next week', detail: '9:00 AM', days: 7 },
] as const;

export type ReminderPresetId = typeof REMINDER_PRESETS[number]['id'];

export type ReminderDraft = {
  contactId: string;
  title: string;
  notes?: string | null;
  remindAt: Date | string;
};

export type NormalizedReminderDraft = {
  contactId: string;
  title: string;
  notes: string | null;
  remindAt: string;
};

export class ReminderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderValidationError';
  }
}

export function getReminderPresetDate(presetId: ReminderPresetId, now = new Date()): Date {
  const preset = REMINDER_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) throw new ReminderValidationError('Choose a valid reminder time.');
  const date = new Date(now);
  date.setDate(date.getDate() + preset.days);
  date.setHours(9, 0, 0, 0);
  return date;
}

export function normalizeReminderDraft(
  draft: ReminderDraft,
  now = new Date()
): NormalizedReminderDraft {
  const contactId = draft.contactId.trim();
  if (!contactId) throw new ReminderValidationError('Choose a person for this reminder.');

  const title = draft.title.trim();
  if (!title) throw new ReminderValidationError('Reminder title is required.');
  if (title.length > 200) {
    throw new ReminderValidationError('Reminder title must be 200 characters or fewer.');
  }

  const notes = draft.notes?.trim() || null;
  if (notes && notes.length > 10_000) {
    throw new ReminderValidationError('Reminder notes must be 10,000 characters or fewer.');
  }

  const remindAt = draft.remindAt instanceof Date ? draft.remindAt : new Date(draft.remindAt);
  if (Number.isNaN(remindAt.getTime())) {
    throw new ReminderValidationError('Choose a valid reminder time.');
  }
  if (remindAt.getTime() <= now.getTime()) {
    throw new ReminderValidationError('Reminder time must be in the future.');
  }

  return { contactId, title, notes, remindAt: remindAt.toISOString() };
}
