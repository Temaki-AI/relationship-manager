export function normalizeTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100) return 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return value; } catch { return 'UTC'; }
}

export function dateInTimeZone(value: string | Date, timeZone = 'UTC'): string | null {
  return createCivilDateFormatter(timeZone)(value);
}

export function createCivilDateFormatter(timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: normalizeTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit' });
  return (value: string | Date): string | null => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  };
}

export function civilDaysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

export function startOfCivilDayUTC(day: string, timeZone: string): string {
  const center = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(center)) throw new Error('Invalid civil date.');
  let low = center - 36 * 60 * 60 * 1000;
  let high = center + 36 * 60 * 60 * 1000;
  const formatDate = createCivilDateFormatter(timeZone);
  // Find the first instant on this local date, including DST midnight transitions.
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (formatDate(new Date(middle))! < day) low = middle + 1;
    else high = middle;
  }
  return new Date(low).toISOString();
}

export function nextBirthdayOccurrence(birthday: string, today: string): { occurrence: string; daysUntil: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const month = Number(birthday.slice(5, 7));
  const day = Number(birthday.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(2000, month, 0)).getUTCDate()) return null;
  let year = Number(today.slice(0, 4));
  const occurrenceIn = (value: number) => {
    const date = new Date(`${value}-${birthday.slice(5)}T00:00:00Z`);
    return date.toISOString().slice(0, 10);
  };
  let occurrence = occurrenceIn(year);
  if (occurrence < today) occurrence = occurrenceIn(++year);
  // February 29 is observed on March 1 in non-leap years, consistently across views.
  return { occurrence, daysUntil: civilDaysBetween(today, occurrence) };
}

export function birthdayMatchesDaySQL(birthday: string, day: string) {
  if (![birthday, day].every((identifier) => /^[a-z_]+\.[a-z_]+$/.test(identifier))) throw new Error('Invalid internal birthday column.');
  const year = `CAST(strftime('%Y', ${day}) AS INTEGER)`;
  return `(strftime('%m-%d', ${birthday}) = strftime('%m-%d', ${day}) OR (
    strftime('%m-%d', ${birthday}) = '02-29' AND strftime('%m-%d', ${day}) = '03-01'
    AND (${year} % 4 != 0 OR (${year} % 100 = 0 AND ${year} % 400 != 0))))`;
}
