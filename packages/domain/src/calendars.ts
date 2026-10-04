export type CalendarFacts = { id: string; summary: string; time_zone: string; access_role: 'owner' | 'writer' | 'writerWithoutPrivateAccess' | 'reader' | 'freeBusyReader'; primary: boolean; hidden: boolean };
export function calendarIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error('Invalid calendar identity.');
  return value;
}
export function readCalendarFacts(value: unknown): CalendarFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid calendar details.');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 6 || typeof item.summary !== 'string' || !item.summary || item.summary.length > 500 || /[\u0000-\u001f\u007f]/u.test(item.summary)
    || typeof item.time_zone !== 'string' || item.time_zone.length > 100 || typeof item.primary !== 'boolean' || typeof item.hidden !== 'boolean'
    || !['owner', 'writer', 'writerWithoutPrivateAccess', 'reader', 'freeBusyReader'].includes(String(item.access_role))) throw new Error('Invalid calendar details.');
  try { new Intl.DateTimeFormat('en', { timeZone: item.time_zone }); } catch { throw new Error('Invalid calendar timezone.'); }
  calendarIdentifier(item.id);
  return item as CalendarFacts;
}
export type CalendarChoice = { facts: CalendarFacts; availability: 'available' | 'unavailable'; selected: boolean; observed_at: string };
export type CalendarDiscoveryRun = { id: string; status: string; processed: number; pages: number; issue: string | null; retry_at: number };
export type CalendarReview = { epoch: string; authorization_revision: number; generation: string | null; selection_revision: number;
  selected_ids: string[]; calendars: CalendarChoice[]; selected_calendars: CalendarChoice[]; more: boolean; next: string | null; run: CalendarDiscoveryRun | null; last_discovered_at: string | null };
