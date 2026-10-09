export const CONTACT_FREQUENCY_OPTIONS = [
  { days: 7, label: 'Weekly' },
  { days: 14, label: 'Fortnightly' },
  { days: 30, label: 'Monthly' },
] as const;

export type ContactDraft = {
  name: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  contactFrequency?: number;
  deviceContactId?: string | null;
};

export type ContactRecord = {
  id: string;
  contact_methods: string;
  source_links?: string;
  provider_links?: string;
  device_links?: string;
  remote_id: number | null;
  device_contact_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  birthday: string | null;
  how_we_met: string | null;
  notes: string | null;
  last_contacted: string | null;
  contact_frequency: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  sync_state: 'local' | 'pending' | 'synced' | 'conflict';
};

export type NormalizedContactDraft = {
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  contactFrequency: number;
  deviceContactId: string | null;
};

export type RelationshipState = 'new' | 'steady' | 'due' | 'overdue';

export class ContactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContactValidationError';
  }
}

function optionalText(value: string | null | undefined, label: string, limit: number): string | null {
  const normalized = value?.trim() || '';
  if (!normalized) return null;
  if (normalized.length > limit) {
    throw new ContactValidationError(`${label} must be ${limit.toLocaleString()} characters or fewer.`);
  }
  return normalized;
}

export function normalizeContactDraft(input: ContactDraft): NormalizedContactDraft {
  const name = optionalText(input.name, 'Name', 200);
  if (!name) throw new ContactValidationError('Name is required.');

  const email = optionalText(input.email, 'Email', 320);
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new ContactValidationError('Enter a valid email address.');
  }

  const contactFrequency = input.contactFrequency ?? 14;
  if (!Number.isInteger(contactFrequency) || contactFrequency < 1 || contactFrequency > 3_650) {
    throw new ContactValidationError('Contact frequency must be between 1 and 3,650 days.');
  }

  return {
    name,
    email,
    phone: optionalText(input.phone, 'Phone', 100),
    notes: optionalText(input.notes, 'Notes', 50_000),
    contactFrequency,
    deviceContactId: optionalText(input.deviceContactId, 'Device contact identifier', 500),
  };
}

export function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function getRelationshipState(
  contact: Pick<ContactRecord, 'last_contacted' | 'contact_frequency'>,
  now = new Date()
): RelationshipState {
  if (!contact.last_contacted) return 'new';
  const lastContacted = new Date(contact.last_contacted);
  if (Number.isNaN(lastContacted.getTime())) return 'new';

  const elapsedDays = Math.max(0, (now.getTime() - lastContacted.getTime()) / 86_400_000);
  if (elapsedDays >= contact.contact_frequency * 1.5) return 'overdue';
  if (elapsedDays >= contact.contact_frequency) return 'due';
  return 'steady';
}
