import type Database from 'better-sqlite3';

export const SCOPED_IMPORT_MINUTE_ATTEMPTS = 30;
export const SCOPED_IMPORT_MINUTE_WINDOW_MILLISECONDS = 60 * 1000;
export const SCOPED_IMPORT_DAILY_ATTEMPTS = 500;
export const SCOPED_IMPORT_DAILY_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;

type AttemptWindow = {
  count: number;
  resetAt: number;
};

export type ScopedImportAttemptDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

const MINUTE_KEY = 'integration-import-limit:minute';
const DAILY_KEY = 'integration-import-limit:daily';

function readWindow(
  db: Database.Database,
  key: string,
  now: number
): AttemptWindow | null {
  const row = db.prepare('SELECT value FROM app_metadata WHERE key = ?')
    .get(key) as { value: string } | undefined;
  if (!row) return null;

  try {
    const parsed = JSON.parse(row.value) as Partial<AttemptWindow>;
    if (
      !Number.isInteger(parsed.count)
      || (parsed.count || 0) < 0
      || !Number.isFinite(parsed.resetAt)
      || (parsed.resetAt || 0) <= now
    ) {
      db.prepare('DELETE FROM app_metadata WHERE key = ?').run(key);
      return null;
    }
    return { count: parsed.count!, resetAt: parsed.resetAt! };
  } catch {
    db.prepare('DELETE FROM app_metadata WHERE key = ?').run(key);
    return null;
  }
}

function retryAfterSeconds(windows: AttemptWindow[], now: number): number {
  return Math.max(1, Math.ceil((Math.max(...windows.map((window) => window.resetAt)) - now) / 1000));
}

export function consumeScopedImportAttempt(
  db: Database.Database,
  now = Date.now()
): ScopedImportAttemptDecision {
  const consume = db.transaction(() => {
    const minute = readWindow(db, MINUTE_KEY, now);
    const daily = readWindow(db, DAILY_KEY, now);
    const blocked = [
      minute && minute.count >= SCOPED_IMPORT_MINUTE_ATTEMPTS ? minute : null,
      daily && daily.count >= SCOPED_IMPORT_DAILY_ATTEMPTS ? daily : null,
    ].filter((window): window is AttemptWindow => Boolean(window));

    if (blocked.length > 0) {
      return { allowed: false, retryAfterSeconds: retryAfterSeconds(blocked, now) };
    }

    const nextMinute = minute
      ? { count: minute.count + 1, resetAt: minute.resetAt }
      : { count: 1, resetAt: now + SCOPED_IMPORT_MINUTE_WINDOW_MILLISECONDS };
    const nextDaily = daily
      ? { count: daily.count + 1, resetAt: daily.resetAt }
      : { count: 1, resetAt: now + SCOPED_IMPORT_DAILY_WINDOW_MILLISECONDS };
    const upsert = db.prepare(`
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    upsert.run(MINUTE_KEY, JSON.stringify(nextMinute));
    upsert.run(DAILY_KEY, JSON.stringify(nextDaily));
    return { allowed: true, retryAfterSeconds: 0 };
  });

  return consume.immediate();
}
