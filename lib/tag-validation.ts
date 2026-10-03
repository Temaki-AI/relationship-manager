export const MAX_TAGS_PER_CONTACT = 100;
export const MAX_TAG_LENGTH = 100;

export class TagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TagValidationError';
  }
}

export function normalizeTag(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TagValidationError('Tags must contain only text.');
  }
  if (/[,\u0000-\u001f\u007f]/u.test(value)) {
    throw new TagValidationError('Tags cannot contain commas or control characters.');
  }

  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > MAX_TAG_LENGTH) {
    throw new TagValidationError(`Tags must be 1-${MAX_TAG_LENGTH} characters.`);
  }
  return normalized;
}

export function normalizeTagList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TagValidationError('Tags must be a list.');
  if (value.length > MAX_TAGS_PER_CONTACT) {
    throw new TagValidationError(`Tags can contain at most ${MAX_TAGS_PER_CONTACT} items.`);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const tag = normalizeTag(item);
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }
  return normalized;
}

export function parseStoredTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      try {
        const tag = normalizeTag(item);
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(tag);
        if (normalized.length === MAX_TAGS_PER_CONTACT) break;
      } catch {
        // Invalid legacy entries are ignored and removed on the next tag mutation.
      }
    }
    return normalized;
  } catch {
    return [];
  }
}

export function serializeTagList(tags: string[]): string | null {
  return tags.length > 0 ? JSON.stringify(tags) : null;
}
