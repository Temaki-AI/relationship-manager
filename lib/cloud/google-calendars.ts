import { calendarIdentifier, readCalendarFacts, type CalendarFacts } from '@/packages/domain/src/calendars';
import { ProviderConnectionError } from './provider-vault';
import type { ProviderFetch } from './google-provider';
export class GoogleCalendarError extends ProviderConnectionError {
  constructor(readonly reason: 'permission' | 'retry' | 'invalid', readonly retryAfter = 30) {
    super(reason === 'permission' ? 'Google Calendar authorization is unavailable. Reconnect this calendar account.' : reason === 'retry'
      ? 'Google Calendar could not be reached or is limiting requests. Try again shortly.' : 'Google returned unsupported calendar details. The previous calendar list was kept.', reason === 'retry' ? 503 : reason === 'permission' ? 409 : 502);
  }
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoogleCalendarError('invalid'); return value as Record<string, unknown>; }
export async function googleCalendarResponseJson(response: Response, maximumBytes = 512 * 1024) {
  if (!response.body) throw new GoogleCalendarError('invalid');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); throw new GoogleCalendarError('invalid'); } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch { throw new GoogleCalendarError('invalid'); } finally { reader.releaseLock(); }
}
export async function googleCalendarsPage(accessToken: string, pageToken: string | null, fetcher: ProviderFetch = fetch) {
  const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
  url.searchParams.set('maxResults', '50'); url.searchParams.set('showHidden', 'true'); url.searchParams.set('showDeleted', 'false');
  url.searchParams.set('fields', 'items(id,summary,summaryOverride,timeZone,accessRole,primary,hidden,deleted),nextPageToken');
  if (pageToken) { if (pageToken.length > 8192 || /[\u0000-\u0020\u007f]/u.test(pageToken)) throw new GoogleCalendarError('invalid'); url.searchParams.set('pageToken', pageToken); }
  let response: Response;
  try { response = await fetcher(url.href, { method: 'GET', headers: { Authorization: 'Bearer ' + accessToken }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new GoogleCalendarError('retry'); }
  const value = await googleCalendarResponseJson(response);
  if (!response.ok) {
    const error = value.error ? object(value.error) : {}, reasons = [...(Array.isArray(error.errors) ? error.errors : []), ...(Array.isArray(error.details) ? error.details : [])].map((detail) => object(detail).reason);
    if (response.status === 401 || reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || reasons.includes('insufficientPermissions')) throw new GoogleCalendarError('permission');
    if (response.status >= 500 || response.status === 429 || reasons.some((reason) => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(String(reason)))) {
      const retry = Number(response.headers.get('Retry-After')); throw new GoogleCalendarError('retry', Number.isFinite(retry) && retry > 0 ? Math.max(2, Math.min(900, retry)) : 30);
    }
    throw new GoogleCalendarError('invalid');
  }
  if (value.items !== undefined && (!Array.isArray(value.items) || value.items.length > 50)) throw new GoogleCalendarError('invalid');
  const next = value.nextPageToken ?? null;
  if (next !== null && (typeof next !== 'string' || !next || next.length > 8192 || /[\u0000-\u0020\u007f]/u.test(next))) throw new GoogleCalendarError('invalid');
  let calendars: CalendarFacts[];
  try {
    calendars = ((value.items ?? []) as unknown[]).flatMap((raw) => {
      const item = object(raw); calendarIdentifier(item.id);
      for (const key of ['primary', 'hidden', 'deleted']) if (item[key] !== undefined && typeof item[key] !== 'boolean') throw new GoogleCalendarError('invalid');
      if (item.deleted === true) return [];
      return [readCalendarFacts({ id: item.id, summary: item.summaryOverride ?? item.summary, time_zone: item.timeZone, access_role: item.accessRole, primary: item.primary === true, hidden: item.hidden === true })];
    });
    if (new Set(calendars.map((item) => item.id)).size !== calendars.length) throw new GoogleCalendarError('invalid');
  } catch { throw new GoogleCalendarError('invalid'); }
  return { calendars, next: next as string | null };
}
