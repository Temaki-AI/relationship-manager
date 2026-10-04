import { createHash } from 'crypto';
import type Database from 'better-sqlite3';

const IDEMPOTENCY_PREFIX = 'idempotency:';
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_SCOPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const IDEMPOTENCY_RETENTION_DAYS = 7;
const MAX_IDEMPOTENCY_RECORDS = 5_000;

type StoredIdempotencyResult = {
  fingerprint: string;
  resourceId: number;
};

type ResourceWithId = {
  id: number;
};

export class IdempotencyError extends Error {
  readonly status: 400 | 409;

  constructor(message: string, status: 400 | 409) {
    super(message);
    this.name = 'IdempotencyError';
    this.status = status;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function parseStoredResult(value: string): StoredIdempotencyResult | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredIdempotencyResult>;
    if (!/^[a-f0-9]{64}$/.test(parsed.fingerprint || '')) return null;
    if (!Number.isSafeInteger(parsed.resourceId) || (parsed.resourceId || 0) <= 0) return null;
    return { fingerprint: parsed.fingerprint!, resourceId: parsed.resourceId! };
  } catch {
    return null;
  }
}

function storageKey(scope: string, idempotencyKey: string, durable = false): string {
  if (!IDEMPOTENCY_SCOPE_PATTERN.test(scope)) {
    throw new Error(`Invalid internal idempotency scope: ${scope}`);
  }
  return `${durable ? 'durable-' : ''}${IDEMPOTENCY_PREFIX}${scope}:${idempotencyKey}`;
}

function pruneExpiredIdempotencyRecords(db: Database.Database) {
  db.prepare(`
    DELETE FROM app_metadata
    WHERE key LIKE ?
      AND updated_at < datetime('now', ?)
  `).run(`${IDEMPOTENCY_PREFIX}%`, `-${IDEMPOTENCY_RETENTION_DAYS} days`);
}

function makeRoomForIdempotencyRecord(db: Database.Database) {
  db.prepare(`
    DELETE FROM app_metadata
    WHERE key IN (
      SELECT key
      FROM app_metadata
      WHERE key LIKE ?
      ORDER BY updated_at DESC, key DESC
      LIMIT -1 OFFSET ?
    )
  `).run(`${IDEMPOTENCY_PREFIX}%`, MAX_IDEMPOTENCY_RECORDS - 1);
}

export function requireIdempotencyKey(headers: Headers): string {
  const value = headers.get('idempotency-key')?.trim() || '';
  if (!value) {
    throw new IdempotencyError('An Idempotency-Key header is required for this create request.', 400);
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new IdempotencyError('Idempotency-Key must be a random UUID.', 400);
  }
  return value.toLowerCase();
}

export function fingerprintIdempotencyInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(input))).digest('hex');
}

export function runIdempotentCreate<T extends ResourceWithId>(
  db: Database.Database,
  options: {
    scope: string;
    durable?: boolean;
    idempotencyKey: string;
    fingerprint: string;
    create: () => T | null;
    load: (resourceId: number) => T | undefined;
  }
): { resource: T | null; replayed: boolean } {
  const key = storageKey(options.scope, options.idempotencyKey, options.durable);
  const operation = db.transaction(() => {
    if (!options.durable) pruneExpiredIdempotencyRecords(db);
    const existing = db.prepare('SELECT value FROM app_metadata WHERE key = ?')
      .get(key) as { value: string } | undefined;

    if (existing) {
      const stored = parseStoredResult(existing.value);
      if (!stored || stored.fingerprint !== options.fingerprint) {
        throw new IdempotencyError(
          'This Idempotency-Key was already used for a different create request.',
          409
        );
      }
      const resource = options.load(stored.resourceId);
      if (!resource) {
        throw new IdempotencyError(
          'The original create result is no longer available. Start a new request.',
          409
        );
      }
      return { resource, replayed: true };
    }

    if (!options.durable) makeRoomForIdempotencyRecord(db);
    const resource = options.create();
    if (!resource) return { resource: null, replayed: false };

    db.prepare(`
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).run(key, JSON.stringify({
      fingerprint: options.fingerprint,
      resourceId: resource.id,
    } satisfies StoredIdempotencyResult));
    return { resource, replayed: false };
  });

  return operation.immediate();
}
