export function parseGroupName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= 100 ? name : null;
}

export function parseGroupColor(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^#[a-f0-9]{6}$/i.test(value)) return undefined;
  return value.toLowerCase();
}
