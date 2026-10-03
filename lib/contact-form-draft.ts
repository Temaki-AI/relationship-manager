export type ContactFormDraft = {
  name: string;
  nickname: string;
  email: string;
  phone: string;
  photo_url: string;
  birthday: string;
  birthday_reminder_days: number;
  how_we_met: string;
  tags: string;
  notes: string;
  gift_ideas: string;
  contact_frequency: number;
  company: string;
  job_title: string;
  location: string;
  linkedin: string;
  twitter: string;
  instagram: string;
  facebook: string;
  website: string;
};

export const EMPTY_CONTACT_FORM_DRAFT: ContactFormDraft = {
  name: '',
  nickname: '',
  email: '',
  phone: '',
  photo_url: '',
  birthday: '',
  birthday_reminder_days: 7,
  how_we_met: '',
  tags: '',
  notes: '',
  gift_ideas: '',
  contact_frequency: 14,
  company: '',
  job_title: '',
  location: '',
  linkedin: '',
  twitter: '',
  instagram: '',
  facebook: '',
  website: '',
};

export const CONTACT_DRAFT_STORAGE_PREFIX = 'everclose:new-contact-draft:v2:';
const LEGACY_CONTACT_DRAFT_STORAGE_KEY = 'everclose:new-contact-draft:v1';
export const CONTACT_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STORED_DRAFT_LENGTH = 150_000;

export const OPTIONAL_CONTACT_SECTIONS = [
  'identity', 'photo', 'professional', 'social', 'birthday', 'context', 'rhythm',
] as const;
export type OptionalContactSection = typeof OPTIONAL_CONTACT_SECTIONS[number];

export type SessionContactDraft = {
  form: ContactFormDraft;
  openSections: OptionalContactSection[];
  photoExcluded: boolean;
  savedAt: number;
};

export function contactDraftStorageKey(accountId: string): string {
  return `${CONTACT_DRAFT_STORAGE_PREFIX}${encodeURIComponent(accountId)}`;
}

export function clearLegacyContactSessionDraft(): void {
  try { sessionStorage.removeItem(LEGACY_CONTACT_DRAFT_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
}

export function clearContactSessionDrafts(): void {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key === LEGACY_CONTACT_DRAFT_STORAGE_KEY || key.startsWith(CONTACT_DRAFT_STORAGE_PREFIX)) {
        sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Browser storage may be disabled; there is nothing the app can clear then.
  }
}

const CONTACT_FORM_DRAFT_FIELDS = Object.keys(EMPTY_CONTACT_FORM_DRAFT) as Array<keyof ContactFormDraft>;

export function contactFormDraftHasChanges(
  current: ContactFormDraft,
  initial: ContactFormDraft = EMPTY_CONTACT_FORM_DRAFT
): boolean {
  return CONTACT_FORM_DRAFT_FIELDS.some((field) => current[field] !== initial[field]);
}

export function serializeSessionContactDraft(
  form: ContactFormDraft,
  openSections: OptionalContactSection[],
  now = Date.now()
): string | null {
  const serialized = JSON.stringify({
    version: 1,
    savedAt: now,
    form: { ...form, photo_url: '' },
    openSections,
    photoExcluded: Boolean(form.photo_url),
  });
  return serialized.length <= MAX_STORED_DRAFT_LENGTH ? serialized : null;
}

export function parseSessionContactDraft(raw: string | null, now = Date.now()): SessionContactDraft | null {
  if (!raw || raw.length > MAX_STORED_DRAFT_LENGTH) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1 || typeof parsed.savedAt !== 'number'
      || !Number.isFinite(parsed.savedAt) || parsed.savedAt > now + 5 * 60_000
      || now - parsed.savedAt > CONTACT_DRAFT_TTL_MS
      || !parsed.form || typeof parsed.form !== 'object' || Array.isArray(parsed.form)) return null;

    const source = parsed.form as Record<string, unknown>;
    const fields: Record<string, string | number> = {};
    for (const [field, fallback] of Object.entries(EMPTY_CONTACT_FORM_DRAFT)) {
      const value = source[field];
      if (typeof value !== typeof fallback) return null;
      if (typeof value === 'string' && value.length > MAX_STORED_DRAFT_LENGTH) return null;
      if (typeof value === 'number' && (!Number.isInteger(value) || !Number.isFinite(value))) return null;
      fields[field] = value as string | number;
    }
    if (fields.photo_url !== '' || (fields.birthday_reminder_days as number) < 0
      || (fields.birthday_reminder_days as number) > 365
      || (fields.contact_frequency as number) < 1
      || (fields.contact_frequency as number) > 3650) return null;

    const requested = Array.isArray(parsed.openSections) ? parsed.openSections : [];
    const openSections = OPTIONAL_CONTACT_SECTIONS.filter((section) => requested.includes(section));
    return {
      form: fields as ContactFormDraft,
      openSections,
      photoExcluded: parsed.photoExcluded === true,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}
