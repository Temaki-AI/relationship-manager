import { parseDateOnly } from './relationship-validation.ts';
import { isEmbeddedContactPhoto } from './contact-photo.ts';
import {
  normalizeTagList,
  serializeTagList,
  TagValidationError,
} from './tag-validation.ts';

export class ContactInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContactInputError';
  }
}

export type ContactFieldValue = string | number | null;

export type NormalizedContactInput = {
  name: string;
  nickname: string | null;
  email: string | null;
  phone: string | null;
  photo_url: string | null;
  birthday: string | null;
  birthday_reminder_days: number;
  how_we_met: string | null;
  tags: string | null;
  notes: string | null;
  gift_ideas: string | null;
  custom_fields: string | null;
  contact_frequency: number;
};

const FIELD_LIMITS = {
  name: 200,
  nickname: 200,
  email: 320,
  phone: 100,
  how_we_met: 5_000,
  notes: 50_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeOptionalString(value: unknown, field: string, maximumLength: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ContactInputError(`${field} must be text.`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximumLength) {
    throw new ContactInputError(`${field} must be ${maximumLength.toLocaleString()} characters or fewer.`);
  }
  return normalized;
}

function normalizeRequiredName(value: unknown): string {
  const name = normalizeOptionalString(value, 'Name', FIELD_LIMITS.name);
  if (!name) throw new ContactInputError('Name is required.');
  return name;
}

function normalizeEmail(value: unknown): string | null {
  const email = normalizeOptionalString(value, 'Email', FIELD_LIMITS.email);
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new ContactInputError('Email must be a valid address.');
  }
  return email;
}

export function normalizeWebUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function normalizePhotoField(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ContactInputError('Photo must be an image or URL.');
  const normalized = value.trim();
  if (normalized.startsWith('data:')) {
    if (!isEmbeddedContactPhoto(normalized)) {
      throw new ContactInputError('Photo must be a valid JPEG, PNG, or WebP local image under 135 KB.');
    }
    return normalized;
  }
  if (normalized.length > 2_048) throw new ContactInputError('Photo URL must be 2,048 characters or fewer.');
  const url = normalizeWebUrl(normalized);
  if (!url) throw new ContactInputError('Photo URL must be a valid HTTP or HTTPS URL.');
  return url;
}

export function normalizeDateField(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = parseDateOnly(value);
  if (!date) throw new ContactInputError(`${field} must be a valid date.`);
  return date;
}

function normalizeContactFrequency(value: unknown, useDefault: boolean): number {
  if ((value === undefined || value === null || value === '') && useDefault) return 14;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3_650) {
    throw new ContactInputError('Contact frequency must be between 1 and 3,650 days.');
  }
  return parsed;
}

function normalizeBirthdayReminderDays(value: unknown, useDefault: boolean): number {
  if ((value === undefined || value === null || value === '') && useDefault) return 7;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 365) {
    throw new ContactInputError('Birthday alert must be between 0 and 365 days in advance.');
  }
  return parsed;
}

function normalizeStringList(value: unknown, field: string, itemMaximumLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new ContactInputError(`${field} must be a list.`);
  if (value.length > 100) throw new ContactInputError(`${field} can contain at most 100 items.`);

  const normalized = value.map((item) => {
    if (typeof item !== 'string') throw new ContactInputError(`${field} must contain only text.`);
    const text = item.trim();
    if (text.length > itemMaximumLength) {
      throw new ContactInputError(`${field} items must be ${itemMaximumLength} characters or fewer.`);
    }
    return text;
  }).filter(Boolean);

  const unique = Array.from(new Set(normalized));
  return unique.length > 0 ? JSON.stringify(unique) : null;
}

function normalizeContactTags(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return serializeTagList(normalizeTagList(value));
  } catch (error) {
    if (error instanceof TagValidationError) throw new ContactInputError(error.message);
    throw error;
  }
}

function normalizeCustomFields(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new ContactInputError('Custom fields must be an object.');

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ContactInputError('Custom fields must contain valid JSON values.');
  }
  if (serialized.length > 50_000) {
    throw new ContactInputError('Custom fields must be 50,000 characters or fewer.');
  }

  const normalized = JSON.parse(serialized) as Record<string, unknown>;
  if (normalized.social !== undefined) {
    if (!isRecord(normalized.social)) throw new ContactInputError('Social links must be an object.');
    const social: Record<string, string> = {};
    for (const [network, rawUrl] of Object.entries(normalized.social)) {
      if (rawUrl === null || rawUrl === '') continue;
      const url = normalizeWebUrl(rawUrl);
      if (!url) throw new ContactInputError(`${network} must be a valid HTTP or HTTPS URL.`);
      social[network] = url;
    }
    normalized.social = social;
  }

  for (const field of ['company', 'job_title', 'location']) {
    if (normalized[field] === undefined || normalized[field] === null || normalized[field] === '') continue;
    normalized[field] = normalizeOptionalString(normalized[field], field, 500);
  }

  return JSON.stringify(normalized);
}

function assertContactBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ContactInputError('Contact payload must be an object.');
  return value;
}

export function normalizeContactCreateInput(value: unknown): NormalizedContactInput {
  const body = assertContactBody(value);
  return {
    name: normalizeRequiredName(body.name),
    nickname: normalizeOptionalString(body.nickname, 'Nickname', FIELD_LIMITS.nickname),
    email: normalizeEmail(body.email),
    phone: normalizeOptionalString(body.phone, 'Phone', FIELD_LIMITS.phone),
    photo_url: normalizePhotoField(body.photo_url),
    birthday: normalizeDateField(body.birthday, 'Birthday'),
    birthday_reminder_days: normalizeBirthdayReminderDays(body.birthday_reminder_days, true),
    how_we_met: normalizeOptionalString(body.how_we_met, 'How we met', FIELD_LIMITS.how_we_met),
    tags: normalizeContactTags(body.tags),
    notes: normalizeOptionalString(body.notes, 'Notes', FIELD_LIMITS.notes),
    gift_ideas: normalizeStringList(body.gift_ideas, 'Gift ideas', 500),
    custom_fields: normalizeCustomFields(body.custom_fields),
    contact_frequency: normalizeContactFrequency(body.contact_frequency, true),
  };
}

export function normalizeContactPatchInput(value: unknown): Record<string, ContactFieldValue> {
  const body = assertContactBody(value);
  const updates: Record<string, ContactFieldValue> = {};

  if (hasOwn(body, 'name')) updates.name = normalizeRequiredName(body.name);
  if (hasOwn(body, 'nickname')) {
    updates.nickname = normalizeOptionalString(body.nickname, 'Nickname', FIELD_LIMITS.nickname);
  }
  if (hasOwn(body, 'email')) updates.email = normalizeEmail(body.email);
  if (hasOwn(body, 'phone')) updates.phone = normalizeOptionalString(body.phone, 'Phone', FIELD_LIMITS.phone);
  if (hasOwn(body, 'photo_url')) updates.photo_url = normalizePhotoField(body.photo_url);
  if (hasOwn(body, 'birthday')) updates.birthday = normalizeDateField(body.birthday, 'Birthday');
  if (hasOwn(body, 'birthday_reminder_days')) {
    updates.birthday_reminder_days = normalizeBirthdayReminderDays(body.birthday_reminder_days, false);
  }
  if (hasOwn(body, 'how_we_met')) {
    updates.how_we_met = normalizeOptionalString(body.how_we_met, 'How we met', FIELD_LIMITS.how_we_met);
  }
  if (hasOwn(body, 'tags')) updates.tags = normalizeContactTags(body.tags);
  if (hasOwn(body, 'notes')) updates.notes = normalizeOptionalString(body.notes, 'Notes', FIELD_LIMITS.notes);
  if (hasOwn(body, 'gift_ideas')) updates.gift_ideas = normalizeStringList(body.gift_ideas, 'Gift ideas', 500);
  if (hasOwn(body, 'custom_fields')) updates.custom_fields = normalizeCustomFields(body.custom_fields);
  if (hasOwn(body, 'last_contacted')) updates.last_contacted = normalizeDateField(body.last_contacted, 'Last contacted');
  if (hasOwn(body, 'contact_frequency')) {
    updates.contact_frequency = normalizeContactFrequency(body.contact_frequency, false);
  }

  return updates;
}
