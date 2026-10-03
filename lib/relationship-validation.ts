export const RELATIONSHIP_ACTIVITY_TYPES = ['call', 'message', 'meetup', 'email'] as const;

export function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseDateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return value;
}

export function parseDateTime(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.length > 50
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !parseDateOnly(value.slice(0, 10))
    || Number.isNaN(Date.parse(value))
  ) return null;
  return new Date(value).toISOString();
}

export function parseRelationshipActivityType(value: unknown): string | null {
  return typeof value === 'string'
    && (RELATIONSHIP_ACTIVITY_TYPES as readonly string[]).includes(value)
    ? value
    : null;
}

export function parseOptionalText(value: unknown, maximumLength: number): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximumLength) return undefined;
  return normalized;
}
