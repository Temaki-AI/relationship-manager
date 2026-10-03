import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { isIP } from 'net';
import { trustsProxyHeaders } from './request-security.ts';

export const CLIENT_LOGIN_ATTEMPTS = 5;
export const CLIENT_LOGIN_WINDOW_MILLISECONDS = 15 * 60 * 1000;
export const ACCOUNT_LOGIN_ATTEMPTS = 20;
export const ACCOUNT_LOGIN_WINDOW_MILLISECONDS = 60 * 1000;

type AttemptWindow = {
  count: number;
  resetAt: number;
};

export type LoginAttemptDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

const KEY_PREFIX = 'auth-login-limit:';
const ACCOUNT_KEY = `${KEY_PREFIX}account`;

function normalizeIp(value: string | null): string | null {
  const candidate = value?.trim().toLowerCase() || '';
  return isIP(candidate) ? candidate : null;
}

export function getLoginClientKey(
  headers: Headers,
  trustProxy = trustsProxyHeaders()
): string {
  if (!trustProxy) return 'direct-client';
  const candidates = [
    headers.get('cf-connecting-ip'),
    headers.get('x-real-ip'),
    headers.get('x-forwarded-for')?.split(',')[0] || null,
  ];
  for (const candidate of candidates) {
    const ip = normalizeIp(candidate);
    if (ip) return `ip:${ip}`;
  }
  return 'trusted-proxy-unknown-client';
}

function clientStorageKey(clientKey: string): string {
  const digest = createHash('sha256').update(clientKey).digest('hex');
  return `${KEY_PREFIX}client:${digest}`;
}

function parseAttemptWindow(value: string, now: number): AttemptWindow | null {
  try {
    const parsed = JSON.parse(value) as Partial<AttemptWindow>;
    if (!Number.isInteger(parsed.count) || !Number.isFinite(parsed.resetAt)) return null;
    if ((parsed.count || 0) < 0 || (parsed.resetAt || 0) <= now) return null;
    return { count: parsed.count!, resetAt: parsed.resetAt! };
  } catch {
    return null;
  }
}

function readActiveWindows(
  db: Database.Database,
  now: number
): Map<string, AttemptWindow> {
  const rows = db.prepare('SELECT key, value FROM app_metadata WHERE key LIKE ?')
    .all(`${KEY_PREFIX}%`) as Array<{ key: string; value: string }>;
  const active = new Map<string, AttemptWindow>();
  const remove = db.prepare('DELETE FROM app_metadata WHERE key = ?');
  for (const row of rows) {
    const window = parseAttemptWindow(row.value, now);
    if (window) active.set(row.key, window);
    else remove.run(row.key);
  }
  return active;
}

function retryAfterSeconds(windows: AttemptWindow[], now: number): number {
  if (windows.length === 0) return 0;
  return Math.max(1, Math.ceil((Math.max(...windows.map((window) => window.resetAt)) - now) / 1000));
}

export function consumeLoginAttempt(
  db: Database.Database,
  clientKey: string,
  now = Date.now()
): LoginAttemptDecision {
  return db.transaction(() => {
    const clientKeyHash = clientStorageKey(clientKey);
    const active = readActiveWindows(db, now);
    const account = active.get(ACCOUNT_KEY);
    const client = active.get(clientKeyHash);
    const blocked = [
      account && account.count >= ACCOUNT_LOGIN_ATTEMPTS ? account : null,
      client && client.count >= CLIENT_LOGIN_ATTEMPTS ? client : null,
    ].filter((window): window is AttemptWindow => Boolean(window));
    if (blocked.length > 0) {
      return { allowed: false, retryAfterSeconds: retryAfterSeconds(blocked, now) };
    }

    const nextAccount: AttemptWindow = account
      ? { count: account.count + 1, resetAt: account.resetAt }
      : { count: 1, resetAt: now + ACCOUNT_LOGIN_WINDOW_MILLISECONDS };
    const nextClient: AttemptWindow = client
      ? { count: client.count + 1, resetAt: client.resetAt }
      : { count: 1, resetAt: now + CLIENT_LOGIN_WINDOW_MILLISECONDS };
    const upsert = db.prepare(`
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    upsert.run(ACCOUNT_KEY, JSON.stringify(nextAccount));
    upsert.run(clientKeyHash, JSON.stringify(nextClient));
    return { allowed: true, retryAfterSeconds: 0 };
  })();
}

export function clearLoginAttempts(db: Database.Database): number {
  return db.prepare('DELETE FROM app_metadata WHERE key LIKE ?').run(`${KEY_PREFIX}%`).changes;
}

export function countStoredLoginLimitKeys(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) count FROM app_metadata WHERE key LIKE ?')
    .get(`${KEY_PREFIX}%`) as { count: number }).count;
}
