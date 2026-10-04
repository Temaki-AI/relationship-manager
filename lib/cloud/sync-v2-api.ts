import { getCloudflareContext } from '@opennextjs/cloudflare';
import { fingerprintIdempotencyInput, IdempotencyError } from '@/lib/idempotency';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { parseDateOnly, parseDateTime, parseOptionalText, parseRelationshipActivityType } from '@/lib/relationship-validation';
import { ContactConnectionInputError, normalizeConnectionText } from '@/lib/contact-connections';
import { createCloudBackup, maintenanceGuard, pruneCloudBackups, recoveryGuard, releaseBackupPin, removeGuard } from '@/lib/cloud/recovery-storage';
import { recoveryErrorResponse } from '@/lib/cloud/recovery-contract';
import { assertState, contactRecord, handleCloudSync, parseEpoch, parseSequence, stateSql, SyncError, type RecordRow, type State } from '@/lib/cloud/sync-api';
import { isSyncSequence, isSyncUuid, MAX_SYNC_PAGE_BYTES, MAX_SYNC_PUSH_BYTES, SYNC_PAGE_SIZE, type SyncValue } from '@/packages/domain/src/sync';
import { SYNC_V2_ENTITIES, type SyncV2PushRequest } from '@/packages/domain/src/sync-v2';
import { SYNC_V3_ENTITIES, type SyncV3PushRequest } from '@/packages/domain/src/sync-v3';
import { SYNC_V4_ENTITIES, type SyncV4Entity, type SyncV4EntityRecord, type SyncV4PushRequest } from '@/packages/domain/src/sync-v4';
import { refreshCalendarEventProjections } from '@/lib/cloud/calendar-event-projection';
import { SYNC_ENTITY_TABLES } from '@/lib/cloud/sync-projection';

type DB = CloudflareEnv['DB'];
type Version = 2 | 3 | 4;
type Input = SyncV2PushRequest | SyncV3PushRequest | SyncV4PushRequest;
type EntityRow = RecordRow & { entity_type: SyncV4Entity };
type Receipt = { fingerprint: string; result: string | null; owner_token?: string };
const encoder = new TextEncoder();
const fields = {
  interaction: ['date', 'occurred_at', 'type', 'summary', 'notes'],
  reminder: ['title', 'notes', 'remind_at', 'completed_at'],
  plan: ['type', 'planned_date', 'summary', 'notes', 'completed_at'],
  family: ['name', 'birthday', 'linked_contact_id'],
  relationship: ['relationship_label', 'reciprocal_label'],
} as const;
function entities(version: Version) { return version === 2 ? SYNC_V2_ENTITIES : version === 3 ? SYNC_V3_ENTITIES : SYNC_V4_ENTITIES; }
function entityList(version: Version) { return entities(version).map((entity) => `'${entity}'`).join(', '); }
function unionSql(version: Version) { return `SELECT 'contact' AS entity_type, public_id, legacy_id, revision, payload, deleted_at FROM sync_contact_records WHERE workspace_id = ?
  UNION ALL SELECT entity_type, public_id, legacy_id, revision, payload, deleted_at FROM sync_entity_records
  WHERE workspace_id = ? AND entity_type IN (${entityList(version)})`; }
const recordSql = `json_object('entity', r.entity_type, 'id', r.public_id, 'legacyId', r.legacy_id, 'revision', r.revision,
  'deleted', json(CASE WHEN r.deleted_at IS NULL THEN 'false' ELSE 'true' END), 'data', json(r.payload))`;
function json(body: unknown, status = 200) { return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } }); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isEntity(value: unknown, version: Version): value is SyncV4Entity { return (entities(version) as readonly unknown[]).includes(value); }
function entityRecord(row: EntityRow): SyncV4EntityRecord { return { ...contactRecord(row), entity: row.entity_type }; }

async function bootstrap(request: Request, db: DB, workspaceId: string, version: Version) {
  const params = new URL(request.url).searchParams;
  const after = params.get('after');
  const continued = after !== null;
  const entity = params.get('entity');
  if (continued ? !isSyncUuid(after) || !isEntity(entity, version) : params.has('epoch') || params.has('sequence') || params.has('entity')) {
    throw new SyncError('Invalid bootstrap position.', 400, 'invalid_cursor');
  }
  const epoch = continued ? parseEpoch(params.get('epoch')) : undefined;
  const sequence = continued ? parseSequence(params.get('sequence')) : undefined;
  const batch = await db.batch([
    db.prepare(stateSql).bind(workspaceId),
    db.prepare(`SELECT * FROM (${unionSql(version)}) WHERE deleted_at IS NULL
      AND (entity_type > ? OR (entity_type = ? AND public_id > ?)) ORDER BY entity_type, public_id LIMIT ?`)
      .bind(workspaceId, workspaceId, entity || '', entity || '', after || '', SYNC_PAGE_SIZE + 1),
  ]);
  const state = batch[0].results[0] as State | undefined;
  assertState(state, epoch);
  if (continued && state!.head !== sequence) throw new SyncError('The workspace changed while downloading. Restart bootstrap; keep local edits.', 409, 'bootstrap_changed');
  const rows = batch[1].results as EntityRow[];
  const records: SyncV4EntityRecord[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, SYNC_PAGE_SIZE)) {
    const record = entityRecord(row);
    const size = encoder.encode(JSON.stringify(record)).byteLength;
    if (bytes + size > MAX_SYNC_PAGE_BYTES) break;
    records.push(record); bytes += size;
  }
  const last = records.at(-1);
  return json({ version, entities: entities(version), cursor: { epoch: state!.epoch, sequence: state!.head }, records,
    next: rows.length > records.length ? { epoch: state!.epoch, sequence: state!.head, entity: last!.entity, after: last!.id } : null });
}

async function pull(request: Request, db: DB, workspaceId: string, version: Version) {
  const params = new URL(request.url).searchParams;
  const epoch = parseEpoch(params.get('epoch'));
  const sequence = parseSequence(params.get('sequence'));
  const batch = await db.batch([
    db.prepare(stateSql).bind(workspaceId),
    db.prepare(`SELECT changes.sequence, changes.entity_type, changes.entity_id AS public_id, changes.revision, changes.payload,
      CASE WHEN changes.operation = 'delete' THEN changes.created_at ELSE NULL END AS deleted_at,
      CASE WHEN changes.entity_type = 'contact' THEN c.legacy_id ELSE r.legacy_id END AS legacy_id
      , CASE WHEN changes.entity_type = 'contact' THEN (SELECT canonical_public_id FROM contact_merge_aliases a
        WHERE a.workspace_id = changes.workspace_id AND a.public_id = changes.entity_id) ELSE NULL END AS merged_into_id
      FROM sync_changes changes LEFT JOIN sync_contact_records c ON c.workspace_id = changes.workspace_id AND c.public_id = changes.entity_id
      LEFT JOIN sync_entity_records r ON r.workspace_id = changes.workspace_id AND r.entity_type = changes.entity_type AND r.public_id = changes.entity_id
      WHERE changes.workspace_id = ? AND changes.epoch = ? AND changes.sequence > ?
      AND changes.entity_type IN (${entityList(version)}) ORDER BY changes.sequence LIMIT ?`)
      .bind(workspaceId, epoch, sequence, SYNC_PAGE_SIZE + 1),
  ]);
  const state = batch[0].results[0] as State | undefined;
  assertState(state, epoch);
  if (sequence > state!.head) throw new SyncError('The cursor is ahead of this workspace.', 400, 'invalid_cursor');
  const rows = batch[1].results as Array<EntityRow & { sequence: number }>;
  const changes: Array<{ sequence: number; entity: SyncV4Entity; record: SyncV4EntityRecord }> = [];
  let bytes = 0;
  for (const row of rows.slice(0, SYNC_PAGE_SIZE)) {
    const change = { sequence: row.sequence, entity: row.entity_type, record: entityRecord(row) };
    const size = encoder.encode(JSON.stringify(change)).byteLength;
    if (bytes + size > MAX_SYNC_PAGE_BYTES) break;
    changes.push(change); bytes += size;
  }
  const more = rows.length > changes.length;
  return json({ version, changes, more, cursor: { epoch, sequence: more ? changes.at(-1)!.sequence : state!.head } });
}

function validatePush(value: unknown, version: Version): Input {
  if (!object(value) || value.version !== version || !isSyncUuid(value.epoch) || !object(value.mutation)
    || Object.keys(value).some((key) => !['version', 'epoch', 'mutation'].includes(key))) throw new SyncError('Invalid sync request.', 400, 'invalid_mutation');
  const mutation = value.mutation;
  if (!isEntity(mutation.entity, version) || !isSyncUuid(mutation.entityId) || !isSyncUuid(mutation.operationId)
    || !['create', 'update', 'delete'].includes(String(mutation.type))) throw new SyncError('Valid entity and operation identifiers are required.', 400, 'invalid_mutation');
  if (mutation.entity === 'source_event') throw new SyncError('Source facts are read-only. Review event associations separately.', 400, 'read_only_entity');
  const allowed = mutation.type === 'create' ? ['operationId', 'entity', 'entityId', 'type', 'data']
    : mutation.type === 'update' ? ['operationId', 'entity', 'entityId', 'type', 'baseRevision', 'base', 'patch']
      : ['operationId', 'entity', 'entityId', 'type', 'baseRevision'];
  if (Object.keys(mutation).some((key) => !allowed.includes(key))) throw new SyncError('Unsupported mutation properties.', 400, 'invalid_mutation');
  if (mutation.type !== 'create' && (!isSyncSequence(mutation.baseRevision) || mutation.baseRevision < 1)) throw new SyncError('A valid base revision is required.', 400, 'invalid_mutation');
  if (mutation.entity === 'contact') return value as Input; // Full contact validation remains shared with v1.
  if (mutation.type !== 'delete') {
    const payload = mutation.type === 'create' ? mutation.data : mutation.patch;
    const supported: readonly string[] = fields[mutation.entity];
    if (!object(payload) || !Object.keys(payload).length || Object.keys(payload).some((key) =>
      !supported.includes(key) && !(mutation.type === 'create' && (key === 'contact_id' || mutation.entity === 'relationship' && key === 'related_contact_id')))) throw new SyncError('Unsupported or empty entity fields.', 400, 'invalid_mutation');
    if (mutation.type === 'update') {
      const base = mutation.base;
      if (!object(base) || Object.keys(base).length !== Object.keys(payload).length || Object.keys(payload).some((key) =>
        !Object.hasOwn(base, key) || !(base[key] === null || typeof base[key] === 'string' && base[key].length <= 100_000))) {
        throw new SyncError('Supply the original stored value for each edited field.', 400, 'invalid_mutation');
      }
    }
  }
  return value as Input;
}

function normalizeChild(input: Input): Record<string, SyncValue> {
  const { mutation } = input;
  if (mutation.type === 'delete') return {};
  const create = mutation.type === 'create';
  const source = create ? mutation.data : mutation.patch;
  const result: Record<string, SyncValue> = {};
  const invalid = () => { throw new SyncError('Valid entity fields are required.', 400, 'invalid_mutation'); };
  if (create) { if (!isSyncUuid(source.contact_id)) invalid(); result.contact_id = source.contact_id as string; }
  function text(key: string, max: number, required = false) {
    if (!create && !Object.hasOwn(source, key)) return;
    const value = parseOptionalText(source[key], max);
    if (value === undefined || required && value === null) invalid();
    result[key] = value!;
  }
  function timestamp(key: string, required = false) {
    if (!create && !Object.hasOwn(source, key)) return;
    const raw = source[key];
    const value = raw == null && !required ? null : parseDateTime(raw);
    if (raw != null && (typeof raw !== 'string' || !/T(?:[01]\d|2[0-3]):[0-5]\d/u.test(raw)) || required && !value || raw != null && !value) invalid();
    result[key] = value;
  }
  if (mutation.entity !== 'family' && mutation.entity !== 'relationship') text('notes', 10_000);
  if (mutation.entity === 'interaction') {
    if (create || Object.hasOwn(source, 'date')) { const date = parseDateOnly(source.date); if (!date) invalid(); result.date = date; }
    if (create || Object.hasOwn(source, 'type')) { const type = parseRelationshipActivityType(source.type); if (!type) invalid(); result.type = type; }
    text('summary', 500);
    timestamp('occurred_at');
    if (result.occurred_at !== undefined && result.occurred_at !== null && (result.date === undefined || String(result.occurred_at).slice(0, 10) !== result.date)) invalid();
    if (!create && Object.hasOwn(source, 'date') && !Object.hasOwn(source, 'occurred_at')) {
      throw new SyncError('A date edit must also supply occurred_at and its original value; use null for a date-only interaction.', 400, 'invalid_mutation');
    }
  } else if (mutation.entity === 'reminder') {
    text('title', 200, true);
    timestamp('remind_at', true);
    timestamp('completed_at');
  } else if (mutation.entity === 'plan') {
    if (create || Object.hasOwn(source, 'planned_date')) { const date = parseDateOnly(source.planned_date); if (!date) invalid(); result.planned_date = date; }
    if (create || Object.hasOwn(source, 'type')) { const type = parseRelationshipActivityType(source.type); if (!type) invalid(); result.type = type; }
    text('summary', 500);
    timestamp('completed_at', !create);
    if (mutation.type === 'update' && Object.hasOwn(source, 'completed_at') && mutation.base.completed_at !== null) {
      throw new SyncError('Complete an open plan with a null original completion value.', 400, 'invalid_mutation');
    }
  } else if (mutation.entity === 'family') {
    if (create || Object.hasOwn(source, 'name')) result.name = normalizeConnectionText(source.name, 'Child name', 200);
    if (create || Object.hasOwn(source, 'birthday')) {
      const birthday = source.birthday == null || source.birthday === '' ? null : parseDateOnly(source.birthday);
      if (source.birthday != null && source.birthday !== '' && birthday === null) invalid();
      result.birthday = birthday;
    }
    if (create || Object.hasOwn(source, 'linked_contact_id')) {
      if (source.linked_contact_id != null && !isSyncUuid(source.linked_contact_id)) invalid();
      result.linked_contact_id = source.linked_contact_id as string | null ?? null;
    }
  } else if (mutation.entity === 'relationship') {
    if (create) { if (!isSyncUuid(source.related_contact_id)) invalid(); result.related_contact_id = source.related_contact_id as string; }
    for (const key of ['relationship_label', 'reciprocal_label']) if (create || Object.hasOwn(source, key)) result[key] = normalizeConnectionText(source[key], 'Relationship label', 80);
  }
  return result;
}

function receiptResponse(receipt: Receipt, fingerprint: string, replayed: boolean, version: Version) {
  if (receipt.fingerprint !== fingerprint) throw new IdempotencyError('This operation ID was already used for a different mutation.', 409);
  if (!receipt.result) throw new SyncError('Sync receipt is incomplete. Retry the same operation.', 503, 'unavailable');
  return json({ version, replayed, result: JSON.parse(receipt.result) });
}

async function push(request: Request, db: DB, workspaceId: string, version: Version) {
  const input = validatePush(await readJsonBody(request, { maximumBytes: MAX_SYNC_PUSH_BYTES }), version);
  const { epoch, mutation } = input;
  if (mutation.entity === 'contact') {
    const { entity, entityId, ...rest } = mutation;
    const response = await handleCloudSync(new Request(request.url, { method: 'POST', headers: request.headers,
      body: JSON.stringify({ version: 1, epoch, mutation: { ...rest, contactId: entityId } }) }), workspaceId, ['v1', 'sync', 'push']);
    const body = await response.json() as { result?: { record: object | null; canonicalRecord?: object } };
    if (body.result?.record) body.result.record = { ...body.result.record, entity };
    if (body.result?.canonicalRecord) body.result.canonicalRecord = { ...body.result.canonicalRecord, entity };
    return json({ ...body, ...(response.ok ? { version } : {}) }, response.status);
  }
  assertState(await db.prepare(stateSql).bind(workspaceId).first<State>(), epoch);
  const fingerprint = fingerprintIdempotencyInput(mutation);
  const query = db.prepare('SELECT fingerprint, result FROM sync_mutation_receipts WHERE workspace_id = ? AND epoch = ? AND operation_id = ?')
    .bind(workspaceId, epoch, mutation.operationId);
  const previous = await query.first<Receipt>();
  if (previous) return receiptResponse(previous, fingerprint, true, version);
  const normalized = normalizeChild(input);
  // Preserve the original request/fingerprint while resolving referenced people.
  // The write guards re-check existence inside its atomic batch.
  for (const key of ['contact_id', 'linked_contact_id', 'related_contact_id']) {
    if (typeof normalized[key] !== 'string') continue;
    const canonical = await db.prepare(`SELECT c.public_id FROM contacts c LEFT JOIN contact_merge_aliases a
      ON a.workspace_id = c.workspace_id AND a.canonical_public_id = c.public_id
      WHERE c.workspace_id = ? AND (c.public_id = ? OR a.public_id = ?) LIMIT 1`).bind(workspaceId, normalized[key], normalized[key]).first<{ public_id: string }>();
    if (canonical) normalized[key] = canonical.public_id;
  }
  const columns = Object.keys(normalized).filter((key) => key !== 'contact_id');
  const expressions = columns.map((key) => ['linked_contact_id', 'related_contact_id'].includes(key) && normalized[key] !== null
    ? '(SELECT id FROM contacts WHERE workspace_id = ? AND public_id = ?)' : '?');
  const values = columns.flatMap((key) => ['linked_contact_id', 'related_contact_id'].includes(key) && normalized[key] !== null
    ? [workspaceId, normalized[key]] : [normalized[key]]);
  const entity = mutation.entity;
  const table = SYNC_ENTITY_TABLES[entity];
  const owner = crypto.randomUUID();
  const guardToken = crypto.randomUUID();
  const receiptValues = [workspaceId, epoch, mutation.operationId, owner];
  const predicate = `EXISTS (SELECT 1 FROM sync_mutation_receipts WHERE workspace_id = ? AND epoch = ? AND operation_id = ? AND owner_token = ? AND result IS NULL)`;
  let write: ReturnType<DB['prepare']>;
  if (mutation.type === 'create') {
    let referenceGuard = '';
    const referenceValues: SyncValue[] = [];
    if (entity === 'family' && normalized.linked_contact_id !== null) {
      referenceGuard = `AND EXISTS (SELECT 1 FROM contacts linked WHERE linked.workspace_id = ? AND linked.public_id = ?
        AND linked.id <> parent.id AND (? IS NULL OR linked.birthday IS ?)
        AND NOT EXISTS (SELECT 1 FROM contact_children child WHERE child.workspace_id = parent.workspace_id
          AND child.contact_id = parent.id AND child.linked_contact_id = linked.id))`;
      referenceValues.push(workspaceId, normalized.linked_contact_id, normalized.birthday, normalized.birthday);
    } else if (entity === 'relationship') {
      referenceGuard = `AND EXISTS (SELECT 1 FROM contacts related WHERE related.workspace_id = ? AND related.public_id = ?
        AND related.id <> parent.id AND NOT EXISTS (SELECT 1 FROM contact_relationships pair WHERE pair.workspace_id = parent.workspace_id
          AND ((pair.contact_id = parent.id AND pair.related_contact_id = related.id) OR (pair.related_contact_id = parent.id AND pair.contact_id = related.id))))`;
      referenceValues.push(workspaceId, normalized.related_contact_id);
    }
    write = db.prepare(`INSERT INTO ${table} (workspace_id, public_id, contact_id, ${columns.join(', ')})
      SELECT ?, ?, parent.id, ${expressions.join(', ')} FROM contacts parent WHERE parent.workspace_id = ? AND parent.public_id = ?
      AND ${predicate} AND NOT EXISTS (SELECT 1 FROM sync_entity_records WHERE workspace_id = ? AND entity_type = ? AND public_id = ?) ${referenceGuard}`)
      .bind(workspaceId, mutation.entityId, ...values, workspaceId, normalized.contact_id, ...receiptValues, workspaceId, entity, mutation.entityId, ...referenceValues);
  } else if (mutation.type === 'update') {
    let referenceGuard = entity === 'plan' && Object.hasOwn(normalized, 'completed_at') ? `AND completed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM sync_entity_records history WHERE history.workspace_id = ?
        AND history.entity_type = 'interaction' AND history.public_id = ?)` : '';
    const referenceValues: SyncValue[] = [];
    if (referenceGuard) referenceValues.push(workspaceId, mutation.operationId);
    if (entity === 'family' && Object.hasOwn(normalized, 'linked_contact_id') && normalized.linked_contact_id !== null) {
      const birthday = Object.hasOwn(normalized, 'birthday') ? '?' : `${table}.birthday`;
      referenceGuard = `AND EXISTS (SELECT 1 FROM contacts linked WHERE linked.workspace_id = ${table}.workspace_id AND linked.public_id = ?
        AND linked.id <> ${table}.contact_id AND (${table}.linked_contact_id IS linked.id OR ${birthday} IS NULL OR linked.birthday IS ${birthday})
        AND NOT EXISTS (SELECT 1 FROM contact_children child WHERE child.workspace_id = ${table}.workspace_id
          AND child.contact_id = ${table}.contact_id AND child.linked_contact_id = linked.id AND child.id <> ${table}.id))`;
      referenceValues.push(normalized.linked_contact_id, ...(birthday === '?' ? [normalized.birthday, normalized.birthday] : []));
    }
    write = db.prepare(`UPDATE ${table} SET ${columns.map((key, index) => `${key} = ${expressions[index]}`).join(', ')}
      ${entity === 'family' ? ", updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')" : ''}
      WHERE workspace_id = ? AND public_id = ? AND ${predicate}
      AND EXISTS (SELECT 1 FROM sync_entity_records r WHERE r.workspace_id = ${table}.workspace_id AND r.entity_type = ?
        AND r.public_id = ${table}.public_id AND r.deleted_at IS NULL AND r.revision >= ?
        AND (r.revision = ? OR (${columns.map((key) => `json_extract(r.payload, '$.${key}') IS ?`).join(' AND ')}))) ${referenceGuard}`)
      .bind(...values, workspaceId, mutation.entityId, ...receiptValues, entity, mutation.baseRevision, mutation.baseRevision,
        ...columns.map((key) => mutation.base[key]), ...referenceValues);
  } else {
    write = db.prepare(`DELETE FROM ${table} WHERE workspace_id = ? AND public_id = ? AND ${predicate}
      AND EXISTS (SELECT 1 FROM sync_entity_records r WHERE r.workspace_id = ${table}.workspace_id AND r.entity_type = ?
        AND r.public_id = ${table}.public_id AND r.deleted_at IS NULL AND r.revision = ?)`)
      .bind(workspaceId, mutation.entityId, ...receiptValues, entity, mutation.baseRevision);
  }
  const recovery = mutation.type === 'delete' ? await createCloudBackup(workspaceId, 'pre-delete') : null;
  const completion = entity === 'plan' && mutation.type === 'update' && normalized.completed_at != null;
  try {
    const results = await db.batch([
      maintenanceGuard(db, guardToken, `EXISTS (SELECT 1 FROM workspace_sync_state state JOIN workspaces workspace ON workspace.id = state.workspace_id
        WHERE state.workspace_id = ? AND state.epoch = ? AND state.paused = 0 AND workspace.lifecycle = 'active')`, [workspaceId, epoch]),
      ...(recovery ? [recoveryGuard(db, workspaceId, recovery)] : []),
      db.prepare(`INSERT INTO sync_mutation_receipts (workspace_id, epoch, operation_id, fingerprint, owner_token)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, epoch, operation_id) DO NOTHING`)
        .bind(workspaceId, epoch, mutation.operationId, fingerprint, owner),
      write,
      db.prepare(`UPDATE sync_mutation_receipts SET result = json_object('operationId', operation_id,
        'status', CASE WHEN changes() > 0 THEN 'applied' ELSE 'conflict' END,
        'record', json((SELECT ${recordSql} FROM sync_entity_records r WHERE r.workspace_id = ? AND r.entity_type = ? AND r.public_id = ?)))
        WHERE workspace_id = ? AND epoch = ? AND operation_id = ? AND owner_token = ? AND result IS NULL`)
        .bind(workspaceId, entity, mutation.entityId, ...receiptValues),
      // Store the plan write result before its side effect changes SQLite changes().
      // Receipt ownership plus the conditional open-plan update prevents a second log.
      ...(completion ? [db.prepare(`INSERT INTO interactions (workspace_id, public_id, contact_id, date, occurred_at, type, summary, notes)
        SELECT workspace_id, ?, contact_id, ?, ?, type, summary, notes FROM plans WHERE workspace_id = ? AND public_id = ?
          AND completed_at = ? AND EXISTS (SELECT 1 FROM sync_mutation_receipts receipt WHERE receipt.workspace_id = ?
            AND receipt.epoch = ? AND receipt.operation_id = ? AND receipt.owner_token = ?
            AND json_extract(receipt.result, '$.status') = 'applied')`)
        .bind(mutation.operationId, String(normalized.completed_at).slice(0, 10), normalized.completed_at, workspaceId, mutation.entityId,
          normalized.completed_at, ...receiptValues)] : []),
      db.prepare('SELECT fingerprint, result, owner_token FROM sync_mutation_receipts WHERE workspace_id = ? AND epoch = ? AND operation_id = ?')
        .bind(workspaceId, epoch, mutation.operationId),
      ...(recovery ? [removeGuard(db, recovery.token)] : []), removeGuard(db, guardToken),
    ]);
    const receipt = results[4 + Number(Boolean(recovery)) + Number(completion)].results[0] as Receipt;
    return receiptResponse(receipt, fingerprint, receipt.owner_token !== owner, version);
  } finally {
    if (recovery) { await releaseBackupPin(workspaceId, recovery.token); await pruneCloudBackups(workspaceId); }
  }
}

async function handleCloudEntitySync(request: Request, workspaceId: string, path: string[], version: Version) {
  const { DB } = getCloudflareContext().env;
  try {
    if (path.length !== 3 || path[0] !== `v${version}` || path[1] !== 'sync') return json({ error: 'Not found.' }, 404);
    if (version === 4 && ['bootstrap', 'pull'].includes(path[2]) && request.method === 'GET') await refreshCalendarEventProjections(DB, workspaceId);
    if (path[2] === 'bootstrap' && request.method === 'GET') return await bootstrap(request, DB, workspaceId, version);
    if (path[2] === 'pull' && request.method === 'GET') return await pull(request, DB, workspaceId, version);
    if (path[2] === 'push' && request.method === 'POST') return await push(request, DB, workspaceId, version);
    return json({ error: 'Method not allowed.' }, 405);
  } catch (error) {
    if (error instanceof SyncError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof RequestBodyError || error instanceof IdempotencyError) return json({ error: error.message }, error.status);
    if (error instanceof ContactConnectionInputError) return json({ error: error.message, code: 'invalid_mutation' }, 400);
    const recovery = recoveryErrorResponse(error);
    if (recovery) return recovery;
    console.error(`cloud.sync.v${version}.failed`, error);
    return json({ error: 'Sync is temporarily unavailable. Keep local changes and retry the same operation.' }, 503);
  }
}

export function handleCloudSyncV2(request: Request, workspaceId: string, path: string[]) {
  return handleCloudEntitySync(request, workspaceId, path, 2);
}
export function handleCloudSyncV3(request: Request, workspaceId: string, path: string[]) {
  return handleCloudEntitySync(request, workspaceId, path, 3);
}

export function handleCloudSyncV4(request: Request, workspaceId: string, path: string[]) {
  return handleCloudEntitySync(request, workspaceId, path, 4);
}
