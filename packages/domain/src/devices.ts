import { isSyncUuid } from './sync.ts';

export const DEVICE_CALLBACK_URL = 'bonds://auth';
export const DEVICE_TOKEN_PREFIX = 'everclose_device_';
export const DEVICE_CODE_TTL_SECONDS = 300;
export const DEVICE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export type DeviceIdentity = {
  deviceId: string;
  userId: string;
  workspaceId: string;
  email: string;
  name: string;
  expiresAt: string;
};
export type NativeAccount = DeviceIdentity & { origin: string; token: string };

export function deviceIdentity(value: unknown): DeviceIdentity {
  if (!value || typeof value !== 'object') throw new Error('Invalid phone account response.');
  const data = value as Record<string, unknown>;
  if (!isSyncUuid(data.deviceId) || !['userId', 'workspaceId', 'email', 'name', 'expiresAt'].every((key) =>
    typeof data[key] === 'string' && data[key].length > 0 && data[key].length <= 320)
    || !Number.isFinite(Date.parse(String(data.expiresAt)))) throw new Error('Invalid phone account response.');
  return { deviceId: data.deviceId, userId: String(data.userId), workspaceId: String(data.workspaceId),
    email: String(data.email), name: String(data.name), expiresAt: String(data.expiresAt) };
}

export function readNativeAccount(value: unknown, allowLocal = false): NativeAccount {
  const identity = deviceIdentity(value);
  const data = value as Record<string, unknown>;
  if (typeof data.origin !== 'string' || typeof data.token !== 'string' || !parseDeviceBearer(`Bearer ${data.token}`)) {
    throw new Error('The stored phone account is invalid.');
  }
  return { ...identity, origin: nativeAccountOrigin(data.origin, allowLocal), token: data.token };
}

export function accountScope(account: Pick<NativeAccount, 'origin' | 'userId' | 'workspaceId'> | null) {
  return account ? JSON.stringify([account.origin, account.workspaceId, account.userId]) : 'local-only';
}

export function base64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset], b = bytes[offset + 1], c = bytes[offset + 2];
    result += alphabet[a >> 2] + alphabet[((a & 3) << 4) | ((b || 0) >> 4)];
    if (offset + 1 < bytes.length) result += alphabet[((b & 15) << 2) | ((c || 0) >> 6)];
    if (offset + 2 < bytes.length) result += alphabet[c & 63];
  }
  return result;
}

export function isDeviceSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}
export function isDeviceState(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
export function isPkceVerifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/u.test(value);
}
export function parseDeviceBearer(value: string | null): string | null {
  if (!value?.startsWith(`Bearer ${DEVICE_TOKEN_PREFIX}`)) return null;
  const token = value.slice('Bearer '.length);
  return isDeviceSecret(token.slice(DEVICE_TOKEN_PREFIX.length)) ? token : null;
}
export function isNativeDeviceApiPath(pathname: string): boolean {
  if (/^\/api\/v1\/contact-photos\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(pathname)) return true;
  return ['/api/v1/gmail-context', '/api/v1/sync/bootstrap', '/api/v1/sync/pull', '/api/v1/sync/push',
    '/api/v2/sync/bootstrap', '/api/v2/sync/pull', '/api/v2/sync/push',
    '/api/v3/sync/bootstrap', '/api/v3/sync/pull', '/api/v3/sync/push',
    '/api/v4/sync/bootstrap', '/api/v4/sync/pull', '/api/v4/sync/push', '/api/v1/devices/session', '/api/v1/device-sources/push', '/api/v1/calendar-event-links/push'].includes(pathname);
}
export function nativeAccountOrigin(value: string, allowLocal = false): string {
  const url = new URL(value.trim());
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !(url.protocol === 'https:' || allowLocal && url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use an HTTPS Everclose server address, or localhost for a development simulator.');
  }
  return url.origin;
}
export function parseDeviceCallback(value: string, expectedState: string): string {
  const url = new URL(value);
  if (url.protocol !== 'bonds:' || url.hostname !== 'auth' || !['', '/'].includes(url.pathname)
    || url.username || url.password || url.port || url.hash || url.searchParams.getAll('code').length !== 1
    || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== expectedState
    || !isDeviceState(expectedState) || !isDeviceSecret(url.searchParams.get('code'))) {
    throw new Error('This sign-in response does not match the request from this phone.');
  }
  return url.searchParams.get('code')!;
}
