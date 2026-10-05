import { ProviderConnectionError } from './provider-vault';
import type { ProviderFetch } from './google-provider';

export const GOOGLE_GMAIL_METADATA_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
const ORIGIN = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const HEADERS = ['From', 'To', 'Cc', 'Bcc', 'Message-ID', 'In-Reply-To', 'List-ID', 'Precedence', 'Auto-Submitted'] as const;
type Header = Lowercase<typeof HEADERS[number]> | 'subject';
export type GmailMetadata = {
  id: string; threadId: string; historyId: string; receivedAt: number;
  labelIds: string[]; headers: Partial<Record<Header, string[]>>;
};
export type GmailHistoryChange = {
  historyId: string; messageId: string; threadId: string;
  kind: 'message_added' | 'message_deleted' | 'labels_added' | 'labels_removed';
};
export class GoogleGmailError extends ProviderConnectionError {
  readonly reason: 'permission' | 'retry' | 'invalid' | 'history_expired' | 'missing';
  readonly retryAfter: number;
  constructor(reason: GoogleGmailError['reason'], retryAfter = 30) {
    super(reason === 'permission' ? 'Gmail metadata access is unavailable. Review this connection.'
      : reason === 'retry' ? 'Gmail could not be reached or is limiting requests. Try again shortly.'
        : reason === 'history_expired' ? 'Gmail history expired. A bounded reconciliation is required.'
          : reason === 'missing' ? 'This Gmail message is no longer available.'
            : 'Google returned unsupported Gmail metadata. The previous context was kept.',
    reason === 'retry' ? 503 : reason === 'invalid' ? 502 : reason === 'missing' ? 404 : 409);
    this.name = 'GoogleGmailError'; this.reason = reason; this.retryAfter = retryAfter;
  }
}
function invalid(): never { throw new GoogleGmailError('invalid'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(value)) return invalid();
  return value;
}
function historyId(value: unknown): string {
  // Never round Gmail's uint64 checkpoint through a JavaScript number.
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value)
    || BigInt(value) > BigInt('18446744073709551615')) return invalid();
  return value;
}
function pageToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value)) return invalid();
  return value;
}
function array(value: unknown, maximum: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value;
}
function messageReference(raw: unknown) {
  const value = object(raw); return { id: identifier(value.id), threadId: identifier(value.threadId) };
}
function nextPage(value: unknown, previous: string | null) {
  const next = pageToken(value); if (next !== null && next === previous) return invalid(); return next;
}
async function json(response: Response, maximumBytes: number) {
  if (!response.body) return invalid();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximumBytes || chunks.length >= 2048) { await reader.cancel(); return invalid(); }
      chunks.push(part.value);
    }
    const result = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result)));
  } catch { return invalid(); } finally { reader.releaseLock(); }
}
async function request(accessToken: string, url: URL, fetcher: ProviderFetch, missing?: 'missing' | 'history_expired', maximumBytes = 512 * 1024) {
  if (typeof accessToken !== 'string' || !/^[\u0021-\u007e]{1,8192}$/u.test(accessToken)) return invalid();
  let response: Response;
  try { response = await fetcher(url.href, { method: 'GET', headers: { Authorization: 'Bearer ' + accessToken },
    redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new GoogleGmailError('retry'); }
  const retry = Number(response.headers.get('Retry-After'));
  const delay = Number.isFinite(retry) && retry > 0 ? Math.max(2, Math.min(900, Math.ceil(retry))) : 30;
  const early = response.status === 401 ? 'permission' : response.status === 404 && missing ? missing
    : response.status === 429 || response.status >= 500 ? 'retry' : null;
  if (early) {
    await response.body?.cancel().catch(() => {});
    throw new GoogleGmailError(early, delay);
  }
  const value = await json(response, response.ok ? maximumBytes : 32 * 1024);
  if (!response.ok) {
    const error = value.error === undefined ? {} : object(value.error);
    const reasons = array(error.errors, 32).map((item) => object(item).reason);
    if (reasons.some((reason) => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(String(reason)))) throw new GoogleGmailError('retry', delay);
    if (response.status === 403) throw new GoogleGmailError('permission');
    return invalid();
  }
  return value;
}
export async function googleGmailProfile(accessToken: string, fetcher: ProviderFetch = fetch) {
  const url = new URL(ORIGIN + 'profile'); url.searchParams.set('fields', 'emailAddress,historyId');
  const value = await request(accessToken, url, fetcher, undefined, 32 * 1024);
  if (typeof value.emailAddress !== 'string' || value.emailAddress.length > 320
    || !/^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+$/u.test(value.emailAddress)) return invalid();
  return { email: value.emailAddress.normalize('NFC').toLowerCase(), historyId: historyId(value.historyId) };
}
export async function googleGmailLabels(accessToken: string, fetcher: ProviderFetch = fetch) {
  const url = new URL(ORIGIN + 'labels'); url.searchParams.set('fields', 'labels(id,name,type)');
  const value = await request(accessToken, url, fetcher);
  const labels = array(value.labels, 1000).map((raw) => {
    const label = object(raw);
    if (typeof label.name !== 'string' || !label.name || label.name.length > 256 || /[\u0000-\u001f\u007f]/u.test(label.name)
      || !['system', 'user'].includes(String(label.type))) return invalid();
    return { id: identifier(label.id), name: label.name, type: label.type as 'system' | 'user' };
  });
  if (new Set(labels.map((label) => label.id)).size !== labels.length) return invalid();
  return labels;
}
/** Each label is scanned separately: Gmail combines multiple labelIds with AND, not OR.
 * The metadata grant forbids q, so time-window filtering belongs after metadata reads.
 */
export async function googleGmailMessagesPage(accessToken: string, labelId: string | null, previousPage: string | null, fetcher: ProviderFetch = fetch) {
  const url = new URL(ORIGIN + 'messages'), previous = pageToken(previousPage);
  url.searchParams.set('maxResults', '100'); url.searchParams.set('includeSpamTrash', 'false');
  url.searchParams.set('fields', 'messages(id,threadId),nextPageToken');
  if (labelId !== null) url.searchParams.append('labelIds', identifier(labelId));
  if (previous) url.searchParams.set('pageToken', previous);
  const value = await request(accessToken, url, fetcher), messages = array(value.messages, 100).map(messageReference);
  if (new Set(messages.map((message) => message.id)).size !== messages.length) return invalid();
  return { messages, next: nextPage(value.nextPageToken, previous) };
}
export async function googleGmailMessageMetadata(accessToken: string, id: string, retainSubject = false, fetcher: ProviderFetch = fetch): Promise<GmailMetadata> {
  if (typeof retainSubject !== 'boolean') return invalid();
  const url = new URL(ORIGIN + 'messages/' + identifier(id)); url.searchParams.set('format', 'metadata');
  url.searchParams.set('fields', 'id,threadId,historyId,internalDate,labelIds,payload(headers)');
  const allowed = [...HEADERS, ...(retainSubject ? ['Subject'] : [])].map((name) => name.toLowerCase());
  for (const name of [...HEADERS, ...(retainSubject ? ['Subject'] : [])]) url.searchParams.append('metadataHeaders', name);
  const value = await request(accessToken, url, fetcher, 'missing', 256 * 1024), reference = messageReference(value);
  if (reference.id !== id || typeof value.internalDate !== 'string' || !/^[0-9]{1,16}$/u.test(value.internalDate)) return invalid();
  const receivedAt = Number(value.internalDate);
  if (!Number.isSafeInteger(receivedAt) || receivedAt > 8640000000000000) return invalid();
  const labelIds = array(value.labelIds, 100).map(identifier);
  if (new Set(labelIds).size !== labelIds.length) return invalid();
  const headers: GmailMetadata['headers'] = {}; let headerBytes = 0;
  for (const raw of array(object(value.payload).headers, 64)) {
    const header = object(raw);
    if (typeof header.name !== 'string' || header.name.length > 80) return invalid();
    const name = header.name.toLowerCase() as Header;
    if (!allowed.includes(name)) continue; // Never retain unrequested Subject/body-related fields.
    if (typeof header.value !== 'string' || header.value.length > 8192) return invalid();
    const text = header.value.replace(/\r?\n[ \t]+/gu, ' ').replace(/\t/gu, ' ');
    headerBytes += new TextEncoder().encode(text).byteLength;
    if (headerBytes > 32 * 1024 || /[\u0000-\u001f\u007f]/u.test(text) || (headers[name]?.length ?? 0) >= 8) return invalid();
    (headers[name] ??= []).push(text);
  }
  return { ...reference, historyId: historyId(value.historyId), receivedAt, labelIds, headers };
}
/** Publish the returned mailbox checkpoint only after all pages are committed.
 * Label changes require fetching current metadata; a history hint is not current state.
 */
export async function googleGmailHistoryPage(accessToken: string, start: string, previousPage: string | null, fetcher: ProviderFetch = fetch) {
  const initial = historyId(start), previous = pageToken(previousPage), url = new URL(ORIGIN + 'history');
  url.searchParams.set('startHistoryId', initial); url.searchParams.set('maxResults', '100');
  url.searchParams.set('fields', 'history(id,messagesAdded(message(id,threadId)),messagesDeleted(message(id,threadId)),labelsAdded(message(id,threadId)),labelsRemoved(message(id,threadId))),nextPageToken,historyId');
  if (previous) url.searchParams.set('pageToken', previous);
  const value = await request(accessToken, url, fetcher, 'history_expired'), current = historyId(value.historyId);
  let last = BigInt(initial); const changes: GmailHistoryChange[] = [];
  const kinds = { messagesAdded: 'message_added', messagesDeleted: 'message_deleted', labelsAdded: 'labels_added', labelsRemoved: 'labels_removed' } as const;
  for (const raw of array(value.history, 100)) {
    const entry = object(raw), checkpoint = historyId(entry.id);
    if (BigInt(checkpoint) <= last) return invalid(); last = BigInt(checkpoint);
    for (const [key, kind] of Object.entries(kinds)) {
      const seen = new Set<string>();
      for (const item of array(entry[key], 500)) {
        const message = messageReference(object(item).message);
        if (seen.has(message.id) || changes.length >= 2000) return invalid(); seen.add(message.id);
        changes.push({ historyId: checkpoint, messageId: message.id, threadId: message.threadId, kind });
      }
    }
  }
  if (BigInt(current) < last) return invalid();
  return { changes, historyId: current, next: nextPage(value.nextPageToken, previous) };
}
