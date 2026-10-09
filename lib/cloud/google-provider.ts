import { ProviderConnectionError, providerKeyring, type ProviderKeyring } from './provider-vault';
import { GOOGLE_GMAIL_METADATA_SCOPE } from './google-gmail';

export const GOOGLE_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
export const GOOGLE_CONNECTION_SCOPES = ['openid', 'email', 'profile', GOOGLE_CONTACTS_SCOPE] as const;
export const GOOGLE_CALENDAR_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'] as const;
export const GOOGLE_CALENDAR_PUBLISH_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.app.created'] as const;
export const GOOGLE_GMAIL_SCOPES = ['openid', 'email', 'profile', GOOGLE_GMAIL_METADATA_SCOPE] as const;
export type GoogleConnectionPurpose = 'contacts' | 'calendar' | 'calendar-publish' | 'gmail';
const CLIENT_PREFIX: Record<GoogleConnectionPurpose, string> = { contacts: 'GOOGLE_CONNECTOR', calendar: 'GOOGLE_CALENDAR', 'calendar-publish': 'GOOGLE_CALENDAR_PUBLISH', gmail: 'GOOGLE_GMAIL' };
export const googlePurposeLabel = (purpose: GoogleConnectionPurpose) => purpose === 'gmail' ? 'Gmail metadata' : purpose === 'calendar-publish' ? 'Calendar publishing' : purpose === 'calendar' ? 'Calendar' : 'Contacts';
export function googlePurpose(value: unknown): GoogleConnectionPurpose {
  if (value !== 'contacts' && value !== 'calendar' && value !== 'calendar-publish' && value !== 'gmail') throw new ProviderConnectionError('Choose Contacts, Gmail metadata, Calendar reading or Calendar publishing access.');
  return value;
}
export function googleConnectionScopes(purpose: GoogleConnectionPurpose) { return purpose === 'gmail' ? GOOGLE_GMAIL_SCOPES : purpose === 'calendar-publish' ? GOOGLE_CALENDAR_PUBLISH_SCOPES : purpose === 'calendar' ? GOOGLE_CALENDAR_SCOPES : GOOGLE_CONNECTION_SCOPES; }
export type GoogleConfiguration = { clientId: string; clientSecret: string; origin: string; redirectUri: string; keyring: ProviderKeyring; purpose: GoogleConnectionPurpose };
export type ProviderEnvironment = Record<string, string | undefined>;
export function googleConfiguration(environment: ProviderEnvironment, purpose: GoogleConnectionPurpose = 'contacts'): GoogleConfiguration {
  try {
    const clientId = environment[CLIENT_PREFIX[purpose] + '_CLIENT_ID']?.trim(), clientSecret = environment[CLIENT_PREFIX[purpose] + '_CLIENT_SECRET']?.trim();
    const url = new URL(environment.BETTER_AUTH_URL || '');
    if (!clientId || clientId.length > 512 || !clientSecret || clientSecret.length > 1024
      || clientId === environment.GOOGLE_CLIENT_ID?.trim() || Object.entries(CLIENT_PREFIX).some(([other, prefix]) => other !== purpose && clientId === environment[prefix + '_CLIENT_ID']?.trim())
      || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error();
    return { clientId, clientSecret, origin: url.origin, redirectUri: url.origin + '/api/connections/google/callback',
      keyring: providerKeyring(environment.CONNECTOR_TOKEN_KEYRING), purpose };
  } catch { throw new ProviderConnectionError(`Google ${googlePurposeLabel(purpose)} connections need a separate OAuth client and token key on this server.`, 503); }
}
export type GoogleCredentials = { clientId: string; accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number | null; scopes: string[] };
export type ProviderFetch = (url: string, options: RequestInit) => Promise<Response>;
export class GoogleGrantError extends ProviderConnectionError {
  constructor(message = 'Google authorization expired or was revoked. Reconnect this account.') { super(message, 409); this.name = 'GoogleGrantError'; }
}
export class GooglePermissionError extends GoogleGrantError {
  constructor(purpose: GoogleConnectionPurpose = 'contacts') { super(`Grant ${purpose === 'calendar-publish' ? 'Calendar publishing' : 'read-only ' + googlePurposeLabel(purpose)} access with its dedicated Google connection client.`); this.name = 'GooglePermissionError'; }
}
function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\s\u0000-\u001f\u007f]/.test(value);
}
function scopes(value: unknown, purpose: GoogleConnectionPurpose, previous?: string[]): string[] {
  if (value === undefined && previous) return scopes(previous.join(' '), purpose);
  if (typeof value !== 'string' || value.length > 2048) throw new ProviderConnectionError('Google returned invalid permissions.', 502);
  const aliases: Record<string, string> = { 'https://www.googleapis.com/auth/userinfo.email': 'email', 'https://www.googleapis.com/auth/userinfo.profile': 'profile' };
  const result = [...new Set(value.split(/\s+/).filter(Boolean).map((scope) => aliases[scope] || scope))].sort();
  const allowed = googleConnectionScopes(purpose) as readonly string[];
  if (!result.includes('openid') || !result.includes('email') || allowed.slice(3).some((scope) => !result.includes(scope))
    || result.some((scope) => !allowed.includes(scope))) {
    throw new GooglePermissionError(purpose);
  }
  return result;
}
async function providerJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new ProviderConnectionError('Google returned an empty response.', 502);
  const reader = response.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength;
      if (length > 32 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(part.value); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ProviderConnectionError('Google returned an invalid response. Try connecting again.', 502); }
  finally { reader.releaseLock(); }
}
async function providerRequest(url: string, options: RequestInit, fetcher: ProviderFetch): Promise<Response> {
  try { return await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new ProviderConnectionError('Google could not be reached. Try again.', 503); }
}
async function tokenRequest(parameters: URLSearchParams, configuration: GoogleConfiguration, fetcher: ProviderFetch, previous?: GoogleCredentials, now = Date.now()): Promise<GoogleCredentials> {
  parameters.set('client_id', configuration.clientId); parameters.set('client_secret', configuration.clientSecret);
  const response = await providerRequest('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: parameters }, fetcher);
  const value = await providerJson(response);
  if (!response.ok) { if (value.error === 'invalid_grant') throw new GoogleGrantError(); throw new ProviderConnectionError('Google authorization could not be completed. Try again.', 503); }
  if (value.token_type !== 'Bearer' || !token(value.access_token) || !Number.isInteger(value.expires_in)
    || Number(value.expires_in) < 1 || Number(value.expires_in) > 86400
    || (value.refresh_token !== undefined && !token(value.refresh_token))) throw new ProviderConnectionError('Google returned invalid credentials.', 502);
  const refreshToken = value.refresh_token as string | undefined || previous?.refreshToken;
  if (!refreshToken) throw new ProviderConnectionError(`Google did not grant offline access. Reconnect and allow ${googlePurposeLabel(configuration.purpose)} access.`, 409);
  let refreshExpiresAt = previous?.refreshExpiresAt ?? null;
  if (value.refresh_token_expires_in !== undefined) {
    if (!Number.isInteger(value.refresh_token_expires_in) || Number(value.refresh_token_expires_in) < 1 || Number(value.refresh_token_expires_in) > 315360000) throw new ProviderConnectionError('Google returned an invalid authorization lifetime.', 502);
    refreshExpiresAt = now + Number(value.refresh_token_expires_in) * 1000;
  }
  return { clientId: configuration.clientId, accessToken: value.access_token, refreshToken,
    accessExpiresAt: now + Number(value.expires_in) * 1000, refreshExpiresAt, scopes: scopes(value.scope, configuration.purpose, previous?.scopes) };
}
export function exchangeGoogleCode(code: string, verifier: string, configuration: GoogleConfiguration, fetcher: ProviderFetch = fetch) {
  return tokenRequest(new URLSearchParams({ code, code_verifier: verifier, redirect_uri: configuration.redirectUri, grant_type: 'authorization_code' }), configuration, fetcher);
}
export function refreshGoogleCredentials(previous: GoogleCredentials, configuration: GoogleConfiguration, fetcher: ProviderFetch = fetch) {
  return tokenRequest(new URLSearchParams({ refresh_token: previous.refreshToken, grant_type: 'refresh_token' }), configuration, fetcher, previous);
}
export async function googleAccount(credentials: GoogleCredentials, fetcher: ProviderFetch = fetch) {
  const response = await providerRequest('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + credentials.accessToken } }, fetcher);
  if (!response.ok) throw new ProviderConnectionError('Google account identity could not be confirmed.', 502);
  const value = await providerJson(response);
  if (typeof value.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(value.sub) || value.email_verified !== true
    || typeof value.email !== 'string' || value.email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(value.email)
    || (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 200 || /[\u0000-\u001f\u007f]/.test(value.name)))) throw new ProviderConnectionError('Google returned an unverified account identity.', 502);
  return { accountId: value.sub, email: value.email, displayName: typeof value.name === 'string' ? value.name : value.email };
}
export async function revokeGoogleCredentials(credentials: GoogleCredentials, fetcher: ProviderFetch = fetch): Promise<boolean> {
  const response = await providerRequest('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: credentials.refreshToken }) }, fetcher);
  if (response.ok) return true;
  return response.status === 400 && (await providerJson(response)).error === 'invalid_token';
}
