export const AUTH_COOKIE_NAME = 'bonds_session';
export const AUTHENTICATED_BY_HEADER = 'x-bonds-authenticated-by';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const MAXIMUM_SESSION_TTL_HOURS = 24 * 7;

type Environment = Record<string, string | undefined>;

export type AuthConfiguration =
  | { mode: 'disabled' }
  | {
      mode: 'enabled';
      password: string;
      sessionSecret: string;
      sessionTtlSeconds: number;
      apiToken: string | null;
    }
  | { mode: 'misconfigured'; reason: string };

export type EnabledAuthConfiguration = Extract<AuthConfiguration, { mode: 'enabled' }>;

const encoder = new TextEncoder();
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;

  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return difference === 0;
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function digest(value: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(hash));
}

function getSessionTtlSeconds(environment: Environment): number | null {
  const configured = environment.CRM_SESSION_TTL_HOURS;
  if (configured === undefined || configured === '') return SESSION_TTL_SECONDS;
  const hours = Number(configured);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAXIMUM_SESSION_TTL_HOURS) return null;
  return hours * 60 * 60;
}

function createSessionId(): string {
  return bytesToBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

function getSessionSignatureInput(payload: string, password: string): string {
  return `bonds-session-v2\0${password.length}\0${password}\0${payload}`;
}

function isValidSessionTtlSeconds(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= SESSION_TTL_SECONDS;
}

export function getAuthConfiguration(environment: Environment = process.env): AuthConfiguration {
  const password = environment.CRM_PASSWORD || '';
  const sessionSecret = environment.CRM_SESSION_SECRET || '';
  const apiToken = environment.CRM_API_TOKEN || '';
  const isProduction = environment.NODE_ENV === 'production';

  if (!password && !sessionSecret && !apiToken && !isProduction) {
    return { mode: 'disabled' };
  }

  if (!password || !sessionSecret) {
    return {
      mode: 'misconfigured',
      reason: 'CRM_PASSWORD and CRM_SESSION_SECRET must both be configured.',
    };
  }

  if (password.length < 12) {
    return { mode: 'misconfigured', reason: 'CRM_PASSWORD must be at least 12 characters.' };
  }

  if (sessionSecret.length < 32) {
    return { mode: 'misconfigured', reason: 'CRM_SESSION_SECRET must be at least 32 characters.' };
  }

  if (apiToken && apiToken.length < 32) {
    return { mode: 'misconfigured', reason: 'CRM_API_TOKEN must be at least 32 characters.' };
  }

  const sessionTtlSeconds = getSessionTtlSeconds(environment);
  if (sessionTtlSeconds === null) {
    return {
      mode: 'misconfigured',
      reason: `CRM_SESSION_TTL_HOURS must be a whole number from 1 to ${MAXIMUM_SESSION_TTL_HOURS}.`,
    };
  }

  return {
    mode: 'enabled',
    password,
    sessionSecret,
    sessionTtlSeconds,
    apiToken: apiToken || null,
  };
}

export async function verifyCredential(candidate: string, expected: string): Promise<boolean> {
  const [candidateHash, expectedHash] = await Promise.all([
    digest(candidate),
    digest(expected),
  ]);
  return constantTimeEqual(candidateHash, expectedHash);
}

export async function createSessionToken(
  sessionSecret: string,
  password: string,
  nowMilliseconds = Date.now(),
  sessionTtlSeconds = SESSION_TTL_SECONDS
): Promise<string> {
  if (!isValidSessionTtlSeconds(sessionTtlSeconds)) {
    throw new TypeError('Session lifetime is invalid.');
  }
  const issuedAt = Math.floor(nowMilliseconds / 1000);
  const expiresAt = issuedAt + sessionTtlSeconds;
  const payload = `v2.${issuedAt}.${expiresAt}.${createSessionId()}`;
  const signature = await sign(getSessionSignatureInput(payload, password), sessionSecret);
  return `${payload}.${signature}`;
}

export async function verifySessionToken(
  token: string | null | undefined,
  sessionSecret: string,
  password: string,
  nowMilliseconds = Date.now(),
  sessionTtlSeconds = SESSION_TTL_SECONDS
): Promise<boolean> {
  if (!token || !isValidSessionTtlSeconds(sessionTtlSeconds)) return false;

  const [version, issuedAtValue, expiresAtValue, sessionId, signature, ...extra] = token.split('.');
  if (
    version !== 'v2'
    || !signature
    || !SESSION_ID_PATTERN.test(sessionId || '')
    || extra.length > 0
  ) return false;

  const issuedAt = Number(issuedAtValue);
  const expiresAt = Number(expiresAtValue);
  const now = Math.floor(nowMilliseconds / 1000);

  if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt)) return false;
  if (issuedAt > now + 300 || expiresAt <= now) return false;
  if (expiresAt <= issuedAt || expiresAt - issuedAt > sessionTtlSeconds) return false;

  const payload = `${version}.${issuedAt}.${expiresAt}.${sessionId}`;
  const expectedSignature = await sign(
    getSessionSignatureInput(payload, password),
    sessionSecret
  );
  return constantTimeEqual(signature, expectedSignature);
}

export function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) return part.slice(separator + 1).trim();
  }

  return null;
}

export function getBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function isApiTokenPath(pathname: string): boolean {
  return pathname === '/api/import/linkedin';
}

export async function authenticateRequest(
  headers: Headers,
  configuration: EnabledAuthConfiguration,
  allowBearer = true
): Promise<'bearer' | 'session' | null> {
  if (allowBearer && configuration.apiToken) {
    const bearerToken = getBearerToken(headers.get('authorization'));
    if (bearerToken && await verifyCredential(bearerToken, configuration.apiToken)) {
      return 'bearer';
    }
  }

  const sessionToken = getCookieValue(headers.get('cookie'), AUTH_COOKIE_NAME);
  if (await verifySessionToken(
    sessionToken,
    configuration.sessionSecret,
    configuration.password,
    Date.now(),
    configuration.sessionTtlSeconds
  )) {
    return 'session';
  }

  return null;
}

export function getSafeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/';
  }

  try {
    const url = new URL(value, 'https://bonds.local');
    if (url.origin !== 'https://bonds.local') return '/';
    return `${url.pathname}${url.search}`;
  } catch {
    return '/';
  }
}
