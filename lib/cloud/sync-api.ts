import { getCloudflareContext } from '@opennextjs/cloudflare';
import { ContactInputError, normalizeContactCreateInput, normalizeContactPatchInput } from '@/lib/contact-input';
import { fingerprintIdempotencyInput, IdempotencyError } from '@/lib/idempotency';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { createCloudBackup, maintenanceGuard, pruneCloudBackups, recoveryGuard, releaseBackupPin, removeGuard } from '@/lib/cloud/recovery-storage';
import { recoveryErrorResponse } from '@/lib/cloud/recovery-contract';
import {
  isSyncSequence, isSyncUuid, MAX_SYNC_PAGE_BYTES, MAX_SYNC_PUSH_BYTES, MAX_SYNC_RECORD_BYTES,
  SYNC_PAGE_SIZE, SYNC_WRITABLE_CONTACT_FIELDS, type SyncContactRecord,
  type SyncMutationResult, type SyncPushRequest, type SyncValue,
} from '@/packages/domain/src/sync';

type DB = CloudflareEnv['DB'];
type State = { epoch: string; paused: number; lifecycle: string; head: number };
type RecordRow = { public_id: string; legacy_id: number; revision: number; payload: string | null; deleted_at: string | null; merged_into_id?: string | null };
type Receipt = { fingerprint: string; result: string | null };
const encoder = new TextEncoder();
const stateSql = `SELECT state.epoch, state.paused, workspace.lifecycle,
  COALESCE((SELECT MAX(sequence) FROM sync_changes WHERE workspace_id = state.workspace_id AND epoch = state.epoch), 0) AS head
  FROM workspace_sync_state state JOIN workspaces workspace ON workspace.id = state.workspace_id WHERE state.workspace_id = ?`;
const recordSql = `json_patch(json_object('id', r.public_id, 'legacyId', r.legacy_id, 'revision', r.revision,
  'deleted', json(CASE WHEN r.deleted_at IS NULL THEN 'false' ELSE 'true' END), 'data', json(r.payload)),
  CASE WHEN r.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM contact_merge_aliases a WHERE a.workspace_id = r.workspace_id AND a.public_id = r.public_id)
    THEN json_object('mergedIntoId', (SELECT canonical_public_id FROM contact_merge_aliases a WHERE a.workspace_id = r.workspace_id AND a.public_id = r.public_id)) ELSE '{}' END)`;

class SyncError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function assertState(state: State | undefined | null, epoch?: string) {
  if (!state) throw new SyncError('Workspace sync is unavailable.', 503, 'unavailable');
  if (state.paused || state.lifecycle !== 'active') throw new SyncError('Workspace maintenance is in progress. Retry after recovery completes.', 423, 'maintenance');
  if (epoch !== undefined && state.epoch !== epoch) throw new SyncError('Cloud data was replaced. Preserve local changes and start a new bootstrap before reconciling them.', 409, 'epoch_changed');
}
function parseSequence(value: string | null): number {
  if (value === null || !/^(0|[1-9][0-9]*)$/u.test(value) || !isSyncSequence(Number(value))) {
    throw new SyncError('A valid sequence is required.', 400, 'invalid_cursor');
  }
  return Number(value);
}
function parseEpoch(value: string | null): string {
  if (!isSyncUuid(value)) throw new SyncError('A valid epoch is required.', 400, 'invalid_cursor');
  return value;
}
function contactRecord(row: RecordRow): SyncContactRecord {
  if (row.payload && encoder.encode(row.payload).byteLength > MAX_SYNC_RECORD_BYTES) {
    throw new SyncError('A contact exceeds the supported sync size. Reduce its text fields before syncing.', 413, 'record_too_large');
  }
  return { id: row.public_id, legacyId: row.legacy_id, revision: row.revision,
    deleted: row.deleted_at !== null, data: row.payload === null ? null : JSON.parse(row.payload),
    ...(row.deleted_at !== null && row.merged_into_id ? { mergedIntoId: row.merged_into_id } : {}) };
}

async function bootstrap(request: Request, db: DB, workspaceId: string) {
  const url = new URL(request.url);
  const after = url.searchParams.get('after');
  const continued = after !== null;
  if (continued && !isSyncUuid(after)) throw new SyncError('Invalid bootstrap position.', 400, 'invalid_cursor');
  if (!continued && (url.searchParams.has('epoch') || url.searchParams.has('sequence'))) {
    throw new SyncError('Start bootstrap without a cursor.', 400, 'invalid_cursor');
  }
  const epoch = continued ? parseEpoch(url.searchParams.get('epoch')) : undefined;
  const sequence = continued ? parseSequence(url.searchParams.get('sequence')) : undefined;
  const batch = await db.batch([
    db.prepare(stateSql).bind(workspaceId),
    db.prepare(`SELECT public_id, legacy_id, revision, payload, deleted_at FROM sync_contact_records
      WHERE workspace_id = ? AND deleted_at IS NULL AND public_id > ? ORDER BY public_id LIMIT ?`)
      .bind(workspaceId, after || '', SYNC_PAGE_SIZE + 1),
  ]);
  const state = batch[0].results[0] as State | undefined;
  assertState(state, epoch);
  if (continued && state!.head !== sequence) {
    throw new SyncError('The workspace changed while downloading. Restart bootstrap; keep any local edits.', 409, 'bootstrap_changed');
  }
  const rows = batch[1].results as RecordRow[];
  const records: SyncContactRecord[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, SYNC_PAGE_SIZE)) {
    const record = contactRecord(row);
    const size = encoder.encode(JSON.stringify(record)).byteLength;
    if (bytes + size > MAX_SYNC_PAGE_BYTES) break;
    records.push(record); bytes += size;
  }
  const more = rows.length > records.length;
  return json({ version: 1, entities: ['contact'], cursor: { epoch: state!.epoch, sequence: state!.head },
    records, next: more ? { epoch: state!.epoch, sequence: state!.head, after: records.at(-1)!.id } : null });
}

async function pull(request: Request, db: DB, workspaceId: string) {
  const url = new URL(request.url);
  const epoch = parseEpoch(url.searchParams.get('epoch'));
  const sequence = parseSequence(url.searchParams.get('sequence'));
  const batch = await db.batch([
    db.prepare(stateSql).bind(workspaceId),
    db.prepare(`SELECT sequence, entity_id AS public_id, revision, payload,
      CASE WHEN operation = 'delete' THEN created_at ELSE NULL END AS deleted_at,
      (SELECT legacy_id FROM sync_contact_records WHERE workspace_id = changes.workspace_id AND public_id = changes.entity_id) AS legacy_id
      , (SELECT canonical_public_id FROM contact_merge_aliases WHERE workspace_id = changes.workspace_id AND public_id = changes.entity_id) AS merged_into_id
      FROM sync_changes changes WHERE workspace_id = ? AND epoch = ? AND entity_type = 'contact' AND sequence > ? ORDER BY sequence LIMIT ?`)
      .bind(workspaceId, epoch, sequence, SYNC_PAGE_SIZE + 1),
  ]);
  const state = batch[0].results[0] as State | undefined;
  assertState(state, epoch);
  if (sequence > state!.head) throw new SyncError('The cursor is ahead of this workspace.', 400, 'invalid_cursor');
  const rows = batch[1].results as Array<RecordRow & { sequence: number }>;
  const changes: Array<{ sequence: number; entity: 'contact'; record: SyncContactRecord }> = [];
  let bytes = 0;
  for (const row of rows.slice(0, SYNC_PAGE_SIZE)) {
    const change = { sequence: row.sequence, entity: 'contact' as const, record: contactRecord(row) };
    const size = encoder.encode(JSON.stringify(change)).byteLength;
    if (bytes + size > MAX_SYNC_PAGE_BYTES) break;
    changes.push(change); bytes += size;
  }
  const more = rows.length > changes.length;
  return json({ version: 1, changes, more,
    cursor: { epoch, sequence: more ? changes.at(-1)!.sequence : state!.head } });
}

// Shared by the versioned entity endpoint; v1 continues to expose contacts only.
export { SyncError, stateSql, assertState, parseSequence, parseEpoch, contactRecord };
export type { State, RecordRow };

function validatePush(value: unknown): SyncPushRequest {
  if (!object(value) || value.version !== 1 || !isSyncUuid(value.epoch) || !object(value.mutation)
    || Object.keys(value).some((key) => !['version', 'epoch', 'mutation'].includes(key))) {
    throw new SyncError('Invalid sync request.', 400, 'invalid_mutation');
  }
  const mutation = value.mutation;
  if (!isSyncUuid(mutation.operationId) || !isSyncUuid(mutation.contactId)
    || !['create', 'update', 'delete'].includes(String(mutation.type))) {
    throw new SyncError('Mutation and contact identifiers must be UUIDs.', 400, 'invalid_mutation');
  }
  const allowed = mutation.type === 'create' ? ['operationId', 'contactId', 'type', 'data']
    : mutation.type === 'update' ? ['operationId', 'contactId', 'type', 'baseRevision', 'base', 'patch']
      : ['operationId', 'contactId', 'type', 'baseRevision'];
  if (Object.keys(mutation).some((key) => !allowed.includes(key))) throw new SyncError('Unsupported mutation properties.', 400, 'invalid_mutation');
  if (mutation.type !== 'create' && (!isSyncSequence(mutation.baseRevision) || mutation.baseRevision < 1)) {
    throw new SyncError('The current base revision is required.', 400, 'invalid_mutation');
  }
  const fields = mutation.type === 'create' ? mutation.data : mutation.type === 'update' ? mutation.patch : null;
  if (mutation.type !== 'delete') {
    if (!object(fields) || !Object.keys(fields).length || Object.keys(fields).some((key) =>
      !(SYNC_WRITABLE_CONTACT_FIELDS as readonly string[]).includes(key)
      || mutation.type === 'create' && key === 'last_contacted')) {
      throw new SyncError('Unsupported or empty contact fields. This sync version does not accept photos.', 400, 'invalid_mutation');
    }
    if (mutation.type === 'update') {
      const base = mutation.base;
      if (!object(base) || Object.keys(base).length !== Object.keys(fields).length || Object.keys(fields).some((key) =>
        !Object.hasOwn(base, key) || !(base[key] === null || typeof base[key] === 'string' && base[key].length <= 100_000
          || typeof base[key] === 'number' && Number.isFinite(base[key])))) {
        throw new SyncError('Supply the original stored value for each edited field.', 400, 'invalid_mutation');
      }
    }
  }
  return value as SyncPushRequest;
}

async function push(request: Request, db: DB, workspaceId: string) {
  const input = validatePush(await readJsonBody(request, { maximumBytes: MAX_SYNC_PUSH_BYTES }));
  const { epoch, mutation } = input;
  const state = await db.prepare(stateSql).bind(workspaceId).first<State>();
  assertState(state, epoch);
  const fingerprint = fingerprintIdempotencyInput(mutation);
  const receiptQuery = db.prepare(`SELECT fingerprint, result FROM sync_mutation_receipts
    WHERE workspace_id = ? AND epoch = ? AND operation_id = ?`).bind(workspaceId, epoch, mutation.operationId);
  const previous = await receiptQuery.first<Receipt>();
  if (previous) return receiptResponse(previous, fingerprint, true);

  const normalized = mutation.type === 'create' ? normalizeContactCreateInput(mutation.data)
    : mutation.type === 'update' ? normalizeContactPatchInput(mutation.patch, mutation.base.contact_methods) : {};
  // This slice excludes photos; preserve the full create defaults without that field.
  const fields = Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== 'photo_url')) as Record<string, SyncValue>;
  const columns = Object.keys(fields);
  const owner = crypto.randomUUID();
  const guardToken = crypto.randomUUID();
  const receiptPredicate = `EXISTS (SELECT 1 FROM sync_mutation_receipts WHERE workspace_id = ?
    AND epoch = ? AND operation_id = ? AND owner_token = ? AND result IS NULL)`;
  const receiptValues = [workspaceId, epoch, mutation.operationId, owner];
  let write: ReturnType<DB['prepare']>;
  if (mutation.type === 'create') {
    write = db.prepare(`INSERT INTO contacts (workspace_id, public_id, ${columns.join(', ')})
      SELECT ?, ?, ${columns.map(() => '?').join(', ')} WHERE ${receiptPredicate}
      AND NOT EXISTS (SELECT 1 FROM sync_contact_records WHERE workspace_id = ? AND public_id = ?)`)
      .bind(workspaceId, mutation.contactId, ...Object.values(fields), ...receiptValues, workspaceId, mutation.contactId);
  } else if (mutation.type === 'update') {
    write = db.prepare(`UPDATE contacts SET ${columns.map((key) => `${key} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND (public_id = ? OR public_id =
        (SELECT canonical_public_id FROM contact_merge_aliases a WHERE a.workspace_id = ? AND a.public_id = ?)) AND ${receiptPredicate}
      ${'contact_methods' in fields ? 'AND contacts.contact_methods IS ?' : ''}
      AND EXISTS (SELECT 1 FROM sync_contact_records r WHERE r.workspace_id = contacts.workspace_id AND r.public_id = ? AND r.revision >= ?
        AND ((r.public_id = contacts.public_id AND r.deleted_at IS NULL AND r.revision = ?)
          OR (${columns.map((key) => `contacts.${key} IS ?`).join(' AND ')})))`)
      .bind(...Object.values(fields), workspaceId, mutation.contactId, workspaceId, mutation.contactId, ...receiptValues,
        ...('contact_methods' in fields ? [mutation.base.contact_methods] : []),
        mutation.contactId, mutation.baseRevision, mutation.baseRevision, ...columns.map((key) => mutation.base[key as keyof typeof mutation.base]));
  } else {
    write = db.prepare(`DELETE FROM contacts WHERE workspace_id = ? AND public_id = ? AND ${receiptPredicate}
      AND EXISTS (SELECT 1 FROM sync_contact_records r WHERE r.workspace_id = contacts.workspace_id
        AND r.public_id = contacts.public_id AND r.deleted_at IS NULL AND r.revision = ?)`)
      .bind(workspaceId, mutation.contactId, ...receiptValues, mutation.baseRevision);
  }
  const recovery = mutation.type === 'delete' ? await createCloudBackup(workspaceId, 'pre-delete') : null;
  try {
    const results = await db.batch([
      maintenanceGuard(db, guardToken, `EXISTS (SELECT 1 FROM workspace_sync_state state
        JOIN workspaces workspace ON workspace.id = state.workspace_id
        WHERE state.workspace_id = ? AND state.epoch = ? AND state.paused = 0 AND workspace.lifecycle = 'active')`, [workspaceId, epoch]),
      ...(recovery ? [recoveryGuard(db, workspaceId, recovery)] : []),
      db.prepare(`INSERT INTO sync_mutation_receipts (workspace_id, epoch, operation_id, fingerprint, owner_token)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, epoch, operation_id) DO NOTHING`)
        .bind(workspaceId, epoch, mutation.operationId, fingerprint, owner),
      write,
      // changes() is the outer resource write count, restored after its triggers.
      db.prepare(`UPDATE sync_mutation_receipts SET result = json_object('operationId', operation_id,
        'status', CASE WHEN changes() > 0 THEN 'applied' ELSE 'conflict' END,
        'record', json((SELECT ${recordSql} FROM sync_contact_records r WHERE r.workspace_id = ? AND r.public_id = ?)))
        WHERE workspace_id = ? AND epoch = ? AND operation_id = ? AND owner_token = ? AND result IS NULL`)
        .bind(workspaceId, mutation.contactId, ...receiptValues),
      // json_set preserves null fields inside the canonical record; JSON Merge Patch would remove them.
      db.prepare(`UPDATE sync_mutation_receipts SET result = json_set(result, '$.canonicalRecord',
        json((SELECT ${recordSql} FROM sync_contact_records r JOIN contact_merge_aliases a ON a.workspace_id = r.workspace_id
          AND a.canonical_public_id = r.public_id WHERE a.workspace_id = ? AND a.public_id = ?)))
        WHERE workspace_id = ? AND epoch = ? AND operation_id = ? AND owner_token = ? AND result IS NOT NULL
          AND EXISTS (SELECT 1 FROM contact_merge_aliases a WHERE a.workspace_id = ? AND a.public_id = ?)`)
        .bind(workspaceId, mutation.contactId, ...receiptValues, workspaceId, mutation.contactId),
      db.prepare(`SELECT fingerprint, result, owner_token FROM sync_mutation_receipts
        WHERE workspace_id = ? AND epoch = ? AND operation_id = ?`).bind(workspaceId, epoch, mutation.operationId),
      ...(recovery ? [removeGuard(db, recovery.token)] : []),
      removeGuard(db, guardToken),
    ]);
    const receipt = results[recovery ? 6 : 5].results[0] as Receipt & { owner_token: string };
    return receiptResponse(receipt, fingerprint, receipt.owner_token !== owner);
  } finally {
    if (recovery) {
      await releaseBackupPin(workspaceId, recovery.token);
      await pruneCloudBackups(workspaceId);
    }
  }
}

function receiptResponse(receipt: Receipt, fingerprint: string, replayed: boolean) {
  if (receipt.fingerprint !== fingerprint) throw new IdempotencyError('This operation ID was already used for a different mutation.', 409);
  if (!receipt.result) throw new SyncError('Sync receipt is incomplete. Retry the same operation.', 503, 'unavailable');
  const result = JSON.parse(receipt.result) as SyncMutationResult;
  return json({ version: 1, replayed, result });
}

export async function handleCloudSync(request: Request, workspaceId: string, path: string[]) {
  const { DB } = getCloudflareContext().env;
  try {
    if (path.length !== 3 || path[0] !== 'v1' || path[1] !== 'sync') return json({ error: 'Not found.' }, 404);
    if (path[2] === 'bootstrap' && request.method === 'GET') return await bootstrap(request, DB, workspaceId);
    if (path[2] === 'pull' && request.method === 'GET') return await pull(request, DB, workspaceId);
    if (path[2] === 'push' && request.method === 'POST') return await push(request, DB, workspaceId);
    return json({ error: 'Method not allowed.' }, 405);
  } catch (error) {
    if (String(error).includes('CONTACT_SYNC_LIMIT')) return json({ error: 'This person has reached the device-sync size limit. Keep your draft for review.', code: 'contact_capacity' }, 413);
    if (error instanceof SyncError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof RequestBodyError || error instanceof IdempotencyError) return json({ error: error.message }, error.status);
    if (error instanceof ContactInputError) return json({ error: error.message, code: 'invalid_mutation' }, 400);
    const recovery = recoveryErrorResponse(error);
    if (recovery) return recovery;
    console.error('cloud.sync.failed', error);
    return json({ error: 'Sync is temporarily unavailable. Keep local changes and retry the same operation.' }, 503);
  }
}
