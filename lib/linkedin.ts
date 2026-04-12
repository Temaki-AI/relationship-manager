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

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function pickFirstString(...values: unknown[]): string | null {
  for (const value of values) {
    const stringValue = asTrimmedString(value);
    if (stringValue) {
      return stringValue;
    }
  }
  return null;
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((tag) => asTrimmedString(tag))
      .filter((tag): tag is string => Boolean(tag));
  }

  const stringValue = asTrimmedString(value);
  if (!stringValue) return [];

  return stringValue
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function normalizeLinkedInUrl(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    // Keep only the pathname, strip query/hash, normalize to https, remove trailing slash
    const path = parsed.pathname.replace(/\/+$/, '');
    return `https://www.linkedin.com${path}`;
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

export function normalizeLinkedInImport(payload: LinkedInImportPayload): NormalizedLinkedInContact {
  const fallbackName = [asTrimmedString(payload.firstName), asTrimmedString(payload.lastName)]
    .filter(Boolean)
    .join(' ')
    .trim();

  const name = pickFirstString(payload.name, payload.fullName, fallbackName);
  if (!name) {
    throw new Error('LinkedIn import requires a name or fullName');
  }

  const rawProfileUrl = pickFirstString(
    payload.profileUrl,
    payload.profile_url,
    payload.linkedinUrl,
    payload.url
  );
  const profileUrl = rawProfileUrl ? normalizeLinkedInUrl(rawProfileUrl) : null;

  const company = pickFirstString(payload.company, payload.companyName, payload.currentCompany);
  const headline = pickFirstString(payload.headline);
  const location = pickFirstString(payload.location);
  const about = pickFirstString(payload.about);
  const rawNotes = pickFirstString(payload.notes);
  const connectionDegree = pickFirstString(payload.connectionDegree);

  const noteLines = [about, rawNotes].filter((line): line is string => Boolean(line));

  const tagSet = new Set(['linkedin', ...normalizeTags(payload.tags)]);

  return {
    name,
    email: pickFirstString(payload.email),
    phone: pickFirstString(payload.phone),
    photo_url: pickFirstString(
      payload.photo_url,
      payload.photoUrl,
      payload.avatarUrl,
      payload.profilePictureUrl
    ),
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
