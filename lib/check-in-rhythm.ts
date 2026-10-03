import type { Contact } from './db.ts';
import { civilDaysBetween, dateInTimeZone } from './civil-date.ts';

type RhythmContact = Pick<Contact, 'last_contacted' | 'contact_frequency'>;

export type CheckInRhythm = {
  kind: 'untracked' | 'on-track' | 'due-soon' | 'ready';
  label: string;
  detail: string;
};

function validCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function days(value: number): string {
  return `${value} ${value === 1 ? 'day' : 'days'}`;
}

export function describeCheckInRhythm(contact: RhythmContact, today = dateInTimeZone(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone)!): CheckInRhythm {
  const lastContacted = contact.last_contacted?.slice(0, 10);
  if (!lastContacted || !validCivilDate(lastContacted) || !validCivilDate(today)) {
    return { kind: 'untracked', label: 'Not tracking yet', detail: 'No conversation logged yet.' };
  }

  const cadence = Number.isInteger(contact.contact_frequency) && contact.contact_frequency > 0
    ? contact.contact_frequency : 14;
  const elapsed = Math.max(0, civilDaysBetween(lastContacted, today));
  const remaining = cadence - elapsed;
  const last = elapsed === 0 ? 'Last in touch today' : `Last in touch ${days(elapsed)} ago`;

  if (remaining > 2) return { kind: 'on-track', label: 'On your rhythm', detail: `${last}; next check-in in ${days(remaining)}.` };
  if (remaining > 0) return { kind: 'due-soon', label: 'Due soon', detail: `${last}; next check-in in ${days(remaining)}.` };
  if (remaining === 0) return { kind: 'ready', label: 'Check-in day', detail: `${last}; your ${cadence}-day preference is due today.` };
  return { kind: 'ready', label: 'Ready to reconnect', detail: `${last}; ${days(-remaining)} past your ${cadence}-day preference.` };
}
