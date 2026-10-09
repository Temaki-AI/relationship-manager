import { ProviderConnectionError } from './provider-vault';
import type { ProviderFetch } from './google-provider';
import type { GoogleContactMethod, GoogleContactFacts } from '@/packages/domain/src/provider-sources';
export type { GoogleContactMethod, GoogleContactFacts } from '@/packages/domain/src/provider-sources';

export const GOOGLE_CONTACTS_PAGE_SIZE = 50;
export const GOOGLE_CONTACTS_REQUEST_VERSION = 1;
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,addresses,metadata';
export type GoogleContactChange = { resourceName: string; previousResourceNames: string[]; deleted: boolean; contacts: GoogleContactFacts[] };
export class GoogleContactsError extends ProviderConnectionError {
  readonly reason: 'cursor_expired' | 'permission' | 'retry' | 'invalid';
  readonly retryAfter: number;
  constructor(reason: GoogleContactsError['reason'], retryAfter = 30) {
    const messages = { cursor_expired: 'Google requires a fresh address book download.', permission: 'Google Contacts permission is unavailable. Reconnect this account.',
      retry: 'Google Contacts could not be reached or is limiting requests. Try again shortly.', invalid: 'Google returned an unsupported address book response. The previous download was kept.' };
    super(messages[reason], reason === 'permission' ? 409 : reason === 'retry' ? 503 : 502);
    this.reason = reason; this.retryAfter = Math.max(2, Math.min(900, retryAfter));
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoogleContactsError('invalid');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, required = false): string | null {
  if (value === undefined || value === null || value === '') { if (required) throw new GoogleContactsError('invalid'); return null; }
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new GoogleContactsError('invalid');
  return value;
}
function resource(value: unknown) {
  const result = text(value, 255, true)!;
  if (!/^people\/[A-Za-z0-9_-]+$/.test(result)) throw new GoogleContactsError('invalid');
  return result;
}
function list(value: unknown, maximum = 100): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new GoogleContactsError('invalid');
  return value.map(object);
}
function fields(person: Record<string, unknown>, key: string, sourceId: string) {
  return list(person[key]).filter((field) => {
    const metadata = object(field.metadata), source = object(metadata.source);
    return source.type === 'CONTACT' && source.id === sourceId;
  }).sort((a, b) => Number(object(b.metadata).sourcePrimary === true) - Number(object(a.metadata).sourcePrimary === true));
}
function methods(person: Record<string, unknown>, key: string, sourceId: string): GoogleContactMethod[] {
  return fields(person, key, sourceId).map((field) => ({ value: text(field.value, key === 'emailAddresses' ? 320 : 200, true)!,
    label: text(field.type, 100), primary: object(field.metadata).sourcePrimary === true,
    canonical: key === 'phoneNumbers' ? text(field.canonicalForm, 32) : null }));
}
export function readGoogleContactChange(value: unknown): GoogleContactChange {
  const person = object(value), resourceName = resource(person.resourceName), metadata = object(person.metadata);
  if (metadata.deleted !== undefined && typeof metadata.deleted !== 'boolean') throw new GoogleContactsError('invalid');
  if (metadata.previousResourceNames !== undefined && (!Array.isArray(metadata.previousResourceNames) || metadata.previousResourceNames.length > 20)) throw new GoogleContactsError('invalid');
  const previousResourceNames = Array.isArray(metadata.previousResourceNames) ? metadata.previousResourceNames.map(resource) : [];
  if (metadata.deleted === true) return { resourceName, previousResourceNames, deleted: true, contacts: [] };
  const sources = list(metadata.sources, 10).filter((source) => source.type === 'CONTACT');
  if (!sources.length) throw new GoogleContactsError('invalid');
  const contacts = sources.map((source): GoogleContactFacts => {
    const sourceId = text(source.id, 255, true)!;
    if (!/^[A-Za-z0-9_-]+$/.test(sourceId)) throw new GoogleContactsError('invalid');
    const name = fields(person, 'names', sourceId)[0], organization = fields(person, 'organizations', sourceId)[0], address = fields(person, 'addresses', sourceId)[0];
    return { sourceId, resourceName, etag: text(source.etag, 512), name: name ? text(name.displayName ?? name.unstructuredName, 200) : null,
      emails: methods(person, 'emailAddresses', sourceId), phones: methods(person, 'phoneNumbers', sourceId),
      company: organization ? text(organization.name, 500) : null, title: organization ? text(organization.title, 500) : null,
      location: address ? [text(address.city, 150), text(address.region, 150), text(address.country, 150)].filter(Boolean).join(', ') || null : null };
  });
  if (new Set(contacts.map((contact) => contact.sourceId)).size !== contacts.length
    || contacts.some((contact) => new TextEncoder().encode(JSON.stringify(contact)).byteLength > 24 * 1024)) throw new GoogleContactsError('invalid');
  return { resourceName, previousResourceNames, deleted: false, contacts };
}
async function readResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new GoogleContactsError('invalid');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw new GoogleContactsError('invalid'); } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch { throw new GoogleContactsError('invalid'); }
  finally { reader.releaseLock(); }
}
export async function googleContactsPage(accessToken: string, input: { pageToken: string | null; syncToken: string | null }, fetcher: ProviderFetch = fetch) {
  const url = new URL('https://people.googleapis.com/v1/people/me/connections');
  url.searchParams.set('pageSize', String(GOOGLE_CONTACTS_PAGE_SIZE)); url.searchParams.set('personFields', PERSON_FIELDS);
  url.searchParams.set('sources', 'READ_SOURCE_TYPE_CONTACT'); url.searchParams.set('requestSyncToken', 'true');
  if (input.pageToken) url.searchParams.set('pageToken', text(input.pageToken, 8192, true)!);
  if (input.syncToken) url.searchParams.set('syncToken', text(input.syncToken, 8192, true)!);
  let response: Response;
  try { response = await fetcher(url.href, { method: 'GET', headers: { Authorization: 'Bearer ' + accessToken }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new GoogleContactsError('retry'); }
  if (response.status === 401 || response.status === 403) {
    // Do not revoke credentials for quota or policy errors that also use HTTP 403.
    const value = await readResponse(response), error = value.error ? object(value.error) : null;
    const reasons = error ? list(error.details).map((detail) => detail.reason) : [];
    if (response.status === 401 || reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) throw new GoogleContactsError('permission');
    throw new GoogleContactsError('retry');
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel();
    const delay = Number(response.headers.get('Retry-After'));
    throw new GoogleContactsError('retry', Number.isFinite(delay) && delay > 0 ? delay : 30);
  }
  const body = await readResponse(response);
  if (!response.ok) {
    const error = body.error ? object(body.error) : null;
    if (response.status === 400 && error && list(error.details).some((detail) => detail.reason === 'EXPIRED_SYNC_TOKEN')) throw new GoogleContactsError('cursor_expired');
    throw new GoogleContactsError('invalid');
  }
  const nextPageToken = text(body.nextPageToken, 8192), nextSyncToken = text(body.nextSyncToken, 8192);
  if ((!nextPageToken && !nextSyncToken) || (nextPageToken && nextSyncToken) || nextPageToken === input.pageToken && nextPageToken !== null) throw new GoogleContactsError('invalid');
  const changes = list(body.connections, GOOGLE_CONTACTS_PAGE_SIZE).map(readGoogleContactChange);
  return { changes, nextPageToken, nextSyncToken };
}
