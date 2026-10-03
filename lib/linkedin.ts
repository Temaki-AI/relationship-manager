export type LinkedInImportPayload = {
  about?: unknown;
  avatarUrl?: unknown;
  company?: unknown;
  companyName?: unknown;
  connectionDegree?: unknown;
  currentCompany?: unknown;
  email?: unknown;
  firstName?: unknown;
  fullName?: unknown;
  headline?: unknown;
  lastName?: unknown;
  linkedinUrl?: unknown;
  location?: unknown;
  name?: unknown;
  notes?: unknown;
  phone?: unknown;
  photo_url?: unknown;
  photoUrl?: unknown;
  profilePictureUrl?: unknown;
  profileUrl?: unknown;
  profile_url?: unknown;
  tags?: unknown;
  url?: unknown;
};

export type NormalizedLinkedInContact = {
  contact_frequency: number;
  custom_fields: string;
  email: string | null;
  how_we_met: string | null;
  name: string;
  notes: string | null;
  phone: string | null;
  photo_url: string | null;
  profile_url: string | null;
  tags: string[];
};

function asTrimmedString(value: unknown, maximumLength = 50_000): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > maximumLength) {
    throw new Error(`LinkedIn import field exceeds ${maximumLength.toLocaleString()} characters`);
  }
  return trimmed ? trimmed : null;
}

function pickFirstString(maximumLength: number, ...values: unknown[]): string | null {
  for (const value of values) {
    const stringValue = asTrimmedString(value, maximumLength);
    if (stringValue) {
      return stringValue;
    }
  }
  return null;
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('LinkedIn import supports at most 100 tags');
    return value
      .map((tag) => asTrimmedString(tag, 100))
      .filter((tag): tag is string => Boolean(tag));
  }

  const stringValue = asTrimmedString(value, 10_000);
  if (!stringValue) return [];

  return stringValue
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 100);
}

export function normalizeLinkedInUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    throw new Error('LinkedIn profile URL must point to a linkedin.com/in/ profile');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  if (hostname !== 'linkedin.com' || !/^\/in\/[^/]+/i.test(parsed.pathname)) {
    throw new Error('LinkedIn profile URL must point to a linkedin.com/in/ profile');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `https://www.linkedin.com${path}`;
}

export function normalizeLinkedInImport(payload: LinkedInImportPayload): NormalizedLinkedInContact {
  const fallbackName = [asTrimmedString(payload.firstName, 100), asTrimmedString(payload.lastName, 100)]
    .filter(Boolean)
    .join(' ')
    .trim();

  const name = pickFirstString(200, payload.name, payload.fullName, fallbackName);
  if (!name) {
    throw new Error('LinkedIn import requires a name or fullName');
  }

  const rawProfileUrl = pickFirstString(
    2_048,
    payload.profileUrl,
    payload.profile_url,
    payload.linkedinUrl,
    payload.url
  );
  const profileUrl = rawProfileUrl ? normalizeLinkedInUrl(rawProfileUrl) : null;

  const company = pickFirstString(500, payload.company, payload.companyName, payload.currentCompany);
  const headline = pickFirstString(500, payload.headline);
  const location = pickFirstString(500, payload.location);
  const about = pickFirstString(25_000, payload.about);
  const rawNotes = pickFirstString(25_000, payload.notes);
  const connectionDegree = pickFirstString(100, payload.connectionDegree);

  const noteLines = [about, rawNotes].filter((line): line is string => Boolean(line));

  const tagSet = new Set(['linkedin', ...normalizeTags(payload.tags)]);
  if (tagSet.size > 100) {
    throw new Error('LinkedIn import supports at most 100 tags including the linkedin tag');
  }

  return {
    name,
    email: pickFirstString(320, payload.email),
    phone: pickFirstString(100, payload.phone),
    photo_url: null,
    how_we_met: null,
    tags: [...tagSet],
    notes: noteLines.length > 0 ? noteLines.join('\n') : null,
    contact_frequency: 30,
    profile_url: profileUrl,
    custom_fields: JSON.stringify({
      social: {
        linkedin: profileUrl,
      },
      linkedin: {
        profile_url: profileUrl,
        headline,
        company,
        location,
        connection_degree: connectionDegree,
        imported_at: new Date().toISOString(),
      },
    }),
  };
}
