import { reconcileGoogleContactLinks } from './google-contact-reconciliation';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { googleConfiguration, type ProviderEnvironment, type ProviderFetch } from './google-provider';
import { googleConnectionAccess, requireProviderOwner, requireGoogleReconnection, providerWriteGuard, type ConnectionActor } from './provider-connections';
import { maintenanceGuard, removeGuard } from './recovery-storage';
import { GoogleContactsError, googleContactsPage, GOOGLE_CONTACTS_REQUEST_VERSION, type GoogleContactFacts } from './google-contacts';
import { ProviderConnectionError } from './provider-vault';

type DB = CloudflareEnv['DB'];
export type GoogleContactRun = { id: string; connection_id: string; workspace_id: string; user_id: string; dataset_epoch: string; authorization_revision: number;
  force_full: number; mode: 'full' | 'delta'; phase: 'copy' | 'fetch' | 'reconcile'; reconcile_after: number; reconciled: number; reconcile_skipped: number; schedule_revision: number | null; status: string; generation: string; base_generation: string | null;
  input_cursor: string | null; next_page: string | null; copy_after: string | null; pages: number; failures: number; processed: number; revision: number;
  lease_token: string | null; lease_until: number | null; next_attempt_at: number; issue: string | null; created_at: string; updated_at: string };
type Run = GoogleContactRun;
type Resource = { connection_id: string; workspace_id: string; dataset_epoch: string; authorization_revision: number;
  active_generation: string | null; sync_cursor: string | null; cursor_issued_at: number | null; request_version: number; last_synced_at: string | null; sync_enabled: number; sync_interval: number; next_sync_at: number; settings_revision: number };
export type GoogleContactsQueueMessage = { kind: 'google-contacts'; version: 1; workspaceId: string; connectionId: string; runId: string };
export type GoogleContactsQueue = { send(message: GoogleContactsQueueMessage): Promise<unknown> };
const MAX_CONTACTS = 20_000;
const MAX_PAGES = 1000;
const COPY_BATCH = 100;
function publicRun(run: Run) {
  return { id: run.id, status: run.status, mode: run.mode, phase: run.phase, processed: run.processed, pages: run.pages,
    reconciled: run.reconciled, skipped: run.reconcile_skipped, issue: run.issue, updated_at: run.updated_at, retry_at: run.next_attempt_at };
}
function conditions() {
  return `EXISTS (SELECT 1 FROM provider_connections c JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id
    JOIN workspaces w ON w.id = c.workspace_id JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
    WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.authorization_revision = ? AND c.dataset_epoch = ?
      AND c.status = 'connected' AND c.purpose = 'contacts' AND s.epoch = ? AND s.paused = 0 AND w.lifecycle = 'active' AND m.role = 'owner')`;
}
function conditionValues(run: Run) {
  return [run.connection_id, run.workspace_id, run.user_id, run.authorization_revision, run.dataset_epoch, run.dataset_epoch];
}
function scheduleCondition() { return '(? IS NULL OR EXISTS (SELECT 1 FROM provider_contact_resources WHERE connection_id = ? AND sync_enabled = 1 AND settings_revision = ?))'; }
function scheduleValues(run: Run) { return [run.schedule_revision, run.connection_id, run.schedule_revision]; }
function runGuard(db: DB, run: Run, lease: string, token: string) {
  return maintenanceGuard(db, token, conditions() + ' AND ' + scheduleCondition() + (run.phase === 'reconcile' ? ' AND EXISTS (SELECT 1 FROM provider_contact_resources WHERE connection_id = ? AND active_generation = ?)' : '') + ' AND EXISTS (SELECT 1 FROM provider_contact_runs WHERE id = ? AND revision = ? AND lease_token = ? AND lease_until >= ? AND status = \'active\')',
    [...conditionValues(run), ...scheduleValues(run), ...(run.phase === 'reconcile' ? [run.connection_id, run.generation] : []), run.id, run.revision, lease, Date.now()]);
}
async function connection(db: DB, actor: ConnectionActor, id: string) {
  await requireProviderOwner(db, actor);
  if (!isSyncUuid(id)) throw new ProviderConnectionError('Google connection not found.', 404);
  const row = await db.prepare(`SELECT c.id, c.authorization_revision, c.dataset_epoch, c.refresh_expires_at FROM provider_connections c
    JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.status = 'connected' AND c.purpose = 'contacts'
      AND c.dataset_epoch = s.epoch AND s.paused = 0 AND w.lifecycle = 'active'`)
    .bind(id, actor.workspaceId, actor.userId).first<{ id: string; authorization_revision: number; dataset_epoch: string; refresh_expires_at: number | null }>();
  if (!row || row.refresh_expires_at !== null && row.refresh_expires_at <= Date.now()) throw new ProviderConnectionError('Reconnect this account before reviewing Google Contacts.');
  return row;
}
function message(run: Run): GoogleContactsQueueMessage {
  return { kind: 'google-contacts', version: 1, workspaceId: run.workspace_id, connectionId: run.connection_id, runId: run.id };
}
export async function startGoogleContactsDownload(db: DB, actor: ConnectionActor, environment: ProviderEnvironment, id: string, body: Record<string, unknown>, queue?: GoogleContactsQueue, scheduled?: { revision: number; due: number }) {
  googleConfiguration(environment);
  const c = await connection(db, actor, id);
  if (Object.keys(body).some((key) => !['operation_id', 'expected_epoch', 'expected_authorization_revision', 'full'].includes(key)) || !isSyncUuid(body.operation_id) || body.expected_epoch !== c.dataset_epoch || body.expected_authorization_revision !== c.authorization_revision
    || (body.full !== undefined && typeof body.full !== 'boolean')) throw new ProviderConnectionError('Refresh this connection before starting its address book download.');
  const existing = await db.prepare('SELECT * FROM provider_contact_runs WHERE id = ?').bind(body.operation_id).first<Run>();
  if (existing) {
    if (existing.connection_id !== id || existing.workspace_id !== actor.workspaceId || existing.user_id !== actor.userId
      || existing.dataset_epoch !== c.dataset_epoch || existing.authorization_revision !== c.authorization_revision || existing.force_full !== Number(body.full === true)) throw new ProviderConnectionError('Use a new download request after the connection or dataset changes.');
    if (existing.status === 'active' && queue) await queue.send(message(existing));
    return publicRun(existing);
  }
  const resource = await db.prepare('SELECT * FROM provider_contact_resources WHERE connection_id = ?').bind(id).first<Resource>();
  const delta = body.full !== true && resource?.active_generation && resource.sync_cursor && resource.request_version === GOOGLE_CONTACTS_REQUEST_VERSION
    && resource.cursor_issued_at !== null && Date.now() - resource.cursor_issued_at < 6 * 24 * 60 * 60_000;
  const now = new Date().toISOString();
  const run: Run = { id: body.operation_id, connection_id: id, workspace_id: actor.workspaceId, user_id: actor.userId, dataset_epoch: c.dataset_epoch,
    authorization_revision: c.authorization_revision, force_full: Number(body.full === true), mode: delta ? 'delta' : 'full', phase: delta ? 'copy' : 'fetch', status: 'active',
    generation: crypto.randomUUID(), base_generation: resource?.active_generation ?? null, input_cursor: delta ? resource!.sync_cursor : null,
    reconcile_after: 0, reconciled: 0, reconcile_skipped: 0, schedule_revision: scheduled?.revision ?? null, next_page: null, copy_after: null, pages: 0, failures: 0, processed: 0, revision: 1, lease_token: null, lease_until: null, next_attempt_at: 0, issue: null, created_at: now, updated_at: now };
  const guard = crypto.randomUUID();
  await db.batch([
    maintenanceGuard(db, guard, conditions() + " AND NOT EXISTS (SELECT 1 FROM provider_contact_runs WHERE connection_id = ? AND status = 'active')"
      + (scheduled ? ' AND EXISTS (SELECT 1 FROM provider_contact_resources WHERE connection_id = ? AND sync_enabled = 1 AND settings_revision = ? AND next_sync_at = ?)' : '')
      + (resource ? ' AND EXISTS (SELECT 1 FROM provider_contact_resources WHERE connection_id = ? AND active_generation IS ?)'
        : ' AND NOT EXISTS (SELECT 1 FROM provider_contact_resources WHERE connection_id = ?)'),
      [...conditionValues(run), id, ...(scheduled ? [id, scheduled.revision, scheduled.due] : []), id, ...(resource ? [resource.active_generation] : [])]),
    db.prepare(`INSERT INTO provider_contact_resources (connection_id, workspace_id, dataset_epoch, authorization_revision, request_version)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(connection_id) DO NOTHING`).bind(id, actor.workspaceId, c.dataset_epoch, c.authorization_revision, GOOGLE_CONTACTS_REQUEST_VERSION),
    db.prepare(`INSERT INTO provider_contact_runs (id, connection_id, workspace_id, user_id, dataset_epoch, authorization_revision, force_full,
      mode, phase, status, generation, base_generation, input_cursor, created_at, updated_at, schedule_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
      .bind(run.id, id, actor.workspaceId, actor.userId, run.dataset_epoch, run.authorization_revision, run.force_full, run.mode, run.phase, run.generation, run.base_generation, run.input_cursor, now, now, run.schedule_revision),
    ...(scheduled ? [db.prepare('UPDATE provider_contact_resources SET next_sync_at = ? WHERE connection_id = ?').bind(Date.now() + resource!.sync_interval * 1000, id)] : []),
    removeGuard(db, guard),
  ]);
  // The durable run is the receipt. A lost queue send is retried by the same request or scheduled reconciliation.
  if (queue) await queue.send(message(run));
  return publicRun(run);
}
export async function reviewGoogleContacts(db: DB, actor: ConnectionActor, id: string, query: URLSearchParams = new URLSearchParams()) {
  const c = await connection(db, actor, id), q = query.get('q') || '', after = query.get('after') || '';
  if (q.length > 200 || after.length > 255 || /[\u0000-\u001f\u007f]/.test(q + after)) throw new ProviderConnectionError('Use a shorter contact search.', 400);
  const r = await db.prepare('SELECT * FROM provider_contact_resources WHERE connection_id = ?').bind(id).first<Resource>();
  if (query.has('generation') && query.get('generation') !== r?.active_generation) throw new ProviderConnectionError('The address book changed. Start this review again.');
  const run = await db.prepare("SELECT * FROM provider_contact_runs WHERE connection_id = ? ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 1").bind(id).first<Run>();
  let items: GoogleContactFacts[] = [], next: string | null = null;
  if (r?.active_generation) {
    const pattern = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    const rows = (await db.prepare(`SELECT source_id, facts FROM provider_contact_index WHERE connection_id = ? AND generation = ? AND source_id > ?
      AND (? = '' OR json_extract(facts, '$.name') LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM json_each(json_extract(facts, '$.emails')) e WHERE json_extract(e.value, '$.value') LIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM json_each(json_extract(facts, '$.phones')) p WHERE json_extract(p.value, '$.value') LIKE ? ESCAPE '\\'))
      ORDER BY source_id LIMIT 51`).bind(id, r.active_generation, after, q, pattern, pattern, pattern).all<{ source_id: string; facts: string }>()).results;
    items = rows.slice(0, 50).map((row: { facts: string }) => JSON.parse(row.facts)); if (rows.length > 50) next = rows[49].source_id;
  }
  const count = r?.active_generation ? await db.prepare('SELECT COUNT(*) AS count FROM provider_contact_index WHERE connection_id = ? AND generation = ?').bind(id, r.active_generation).first<{ count: number }>() : null;
  // Fence the read too: never return a cached provider result after a concurrent disconnect, restore or owner removal.
  const guard = crypto.randomUUID();
  await db.batch([maintenanceGuard(db, guard, conditions() + (r?.active_generation
    ? ' AND EXISTS (SELECT 1 FROM provider_contact_resources WHERE connection_id = ? AND active_generation = ?)'
    : ' AND NOT EXISTS (SELECT 1 FROM provider_contact_resources WHERE connection_id = ? AND active_generation IS NOT NULL)'),
    [id, actor.workspaceId, actor.userId, c.authorization_revision, c.dataset_epoch, c.dataset_epoch, id, ...(r?.active_generation ? [r.active_generation] : [])]), removeGuard(db, guard)]);
  return { generation: r?.active_generation ?? null, last_synced_at: r?.last_synced_at ?? null, count: count?.count ?? 0, items, next_after: next,
    run: run ? publicRun(run) : null, automatic_sync: Boolean(r?.sync_enabled), schedule: { enabled: Boolean(r?.sync_enabled), interval: r?.sync_interval ?? 86400, revision: r?.settings_revision ?? 0, next_at: r?.next_sync_at ?? 0 }, import_available: true };
}
export async function advanceGoogleContactsDownload(db: DB, environment: ProviderEnvironment, input: GoogleContactsQueueMessage, fetcher: ProviderFetch = fetch) {
  const original = await db.prepare('SELECT * FROM provider_contact_runs WHERE id = ? AND workspace_id = ? AND connection_id = ?')
    .bind(input.runId, input.workspaceId, input.connectionId).first<Run>();
  if (!original || original.status !== 'active') return { status: original?.status ?? 'missing', advanced: false, retryAfter: 0 };
  if (original.next_attempt_at > Date.now()) return { status: 'active', advanced: false, retryAfter: Math.ceil((original.next_attempt_at - Date.now()) / 1000) };
  const lease = crypto.randomUUID(), now = Date.now();
  const run = await db.prepare(`UPDATE provider_contact_runs SET lease_token = ?, lease_until = ? WHERE id = ? AND revision = ? AND status = 'active'
    AND (lease_token IS NULL OR lease_until < ?) AND ${conditions()} AND ${scheduleCondition()} RETURNING *`)
    .bind(lease, now + 45_000, original.id, original.revision, now, ...conditionValues(original), ...scheduleValues(original)).first<Run>();
  if (!run) return { status: 'active', advanced: false, retryAfter: 10 };
  try {
    const guard = crypto.randomUUID(), nowIso = new Date().toISOString();
    if (run.phase === 'copy') {
      const rows = (await db.prepare(`SELECT source_id FROM provider_contact_index WHERE connection_id = ? AND generation = ? AND source_id > ? ORDER BY source_id LIMIT ?`)
        .bind(run.connection_id, run.base_generation, run.copy_after ?? '', COPY_BATCH).all<{ source_id: string }>()).results;
      await db.batch([
        runGuard(db, run, lease, guard),
        ...(rows.length ? [db.prepare(`INSERT INTO provider_contact_index (connection_id, generation, source_id, resource_name, facts, observed_at)
          SELECT connection_id, ?, source_id, resource_name, facts, observed_at FROM provider_contact_index
          WHERE connection_id = ? AND generation = ? AND source_id > ? AND source_id <= ? ORDER BY source_id LIMIT ?`)
          .bind(run.generation, run.connection_id, run.base_generation, run.copy_after ?? '', rows.at(-1)!.source_id, COPY_BATCH)] : []),
        db.prepare(`UPDATE provider_contact_runs SET copy_after = ?, phase = ?, revision = revision + 1, issue = NULL, next_attempt_at = 0,
          failures = 0, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`).bind(rows.at(-1)?.source_id ?? run.copy_after, rows.length === COPY_BATCH ? 'copy' : 'fetch', nowIso, run.id),
        removeGuard(db, guard),
      ]);
      return { status: 'active', advanced: true, retryAfter: 0 };
    }
    if (run.phase === 'reconcile') {
      const grant = await googleConnectionAccess(db, { workspaceId: run.workspace_id, userId: run.user_id }, environment, run.connection_id, run.dataset_epoch, fetcher);
      if (grant.authorizationRevision !== run.authorization_revision) throw new ProviderConnectionError('The Google authorization changed.');
      return await reconcileGoogleContactLinks(db, run, lease, grant, (token) => runGuard(db, run, lease, token));
    }
    if (run.pages >= MAX_PAGES) throw new GoogleContactsError('invalid');
    const grant = await googleConnectionAccess(db, { workspaceId: run.workspace_id, userId: run.user_id }, environment, run.connection_id, run.dataset_epoch, fetcher);
    if (grant.authorizationRevision !== run.authorization_revision) throw new ProviderConnectionError('The connection changed before its download completed.');
    const page = await googleContactsPage(grant.accessToken, { pageToken: run.next_page, syncToken: run.input_cursor }, fetcher).catch(async (error) => {
      if (error instanceof GoogleContactsError && error.reason === 'permission') await requireGoogleReconnection(db, grant);
      throw error;
    });
    const statements = page.changes.flatMap((change) => change.deleted
      ? [db.prepare('DELETE FROM provider_contact_index WHERE connection_id = ? AND generation = ? AND resource_name = ?').bind(run.connection_id, run.generation, change.resourceName)]
      : [db.prepare(`DELETE FROM provider_contact_index WHERE connection_id = ? AND generation = ?
          AND resource_name IN (${[change.resourceName, ...change.previousResourceNames].map(() => '?').join(',')})
          AND source_id NOT IN (${change.contacts.map(() => '?').join(',')})`)
          .bind(run.connection_id, run.generation, change.resourceName, ...change.previousResourceNames, ...change.contacts.map((c) => c.sourceId)),
        ...change.contacts.map((contact) => db.prepare(`INSERT INTO provider_contact_index (connection_id, generation, source_id, resource_name, facts, observed_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(connection_id, generation, source_id) DO UPDATE SET resource_name = excluded.resource_name, facts = excluded.facts, observed_at = excluded.observed_at`)
        .bind(run.connection_id, run.generation, contact.sourceId, contact.resourceName, JSON.stringify(contact), nowIso))]);
    const complete = page.nextPageToken === null;
    const linked = complete ? await db.prepare(`SELECT l.id FROM contact_provider_links l JOIN provider_connections c ON c.account_id = l.account_key AND c.workspace_id = l.workspace_id
      WHERE c.id = ? AND l.workspace_id = ? AND l.provider = 'google' LIMIT 1`).bind(run.connection_id, run.workspace_id).first() : null;
    const finished = complete && !linked;
    await db.batch([
      runGuard(db, run, lease, guard), providerWriteGuard(db, grant, guard + '-provider'), ...statements,
      maintenanceGuard(db, guard + '-size', '(SELECT COUNT(*) FROM provider_contact_index WHERE connection_id = ? AND generation = ?) <= ?', [run.connection_id, run.generation, MAX_CONTACTS], -3),
      ...(complete ? [db.prepare(`UPDATE provider_contact_resources SET active_generation = ?, sync_cursor = ?,
        cursor_issued_at = CASE WHEN ? = 'full' THEN ? ELSE cursor_issued_at END, request_version = ?, last_synced_at = ?, next_sync_at = CASE WHEN sync_enabled = 1 THEN ? + sync_interval * 1000 ELSE 0 END WHERE connection_id = ?`)
        .bind(run.generation, page.nextSyncToken, run.mode, Date.now(), GOOGLE_CONTACTS_REQUEST_VERSION, nowIso, Date.now(), run.connection_id)] : []),
      db.prepare(`UPDATE provider_contact_runs SET next_page = ?, status = ?, phase = ?, pages = pages + 1, processed = processed + ?, revision = revision + 1,
        issue = NULL, next_attempt_at = 0, failures = 0, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`)
        .bind(page.nextPageToken, finished ? 'complete' : 'active', complete && linked ? 'reconcile' : 'fetch', page.changes.length, nowIso, run.id),
      removeGuard(db, guard), removeGuard(db, guard + '-provider'), removeGuard(db, guard + '-size'),
    ]);
    return { status: finished ? 'complete' : 'active', advanced: true, retryAfter: 0 };
  } catch (error) {
    if (error instanceof GoogleContactsError && error.reason === 'cursor_expired' && run.mode === 'delta') {
      const guard = crypto.randomUUID();
      await db.batch([runGuard(db, run, lease, guard), db.prepare(`UPDATE provider_contact_runs SET generation = ?, mode = 'full', phase = 'fetch',
        input_cursor = NULL, next_page = NULL, copy_after = NULL, pages = 0, processed = 0, revision = revision + 1, lease_token = NULL, lease_until = NULL,
        issue = 'cursor_expired', updated_at = ? WHERE id = ?`).bind(crypto.randomUUID(), new Date().toISOString(), run.id), removeGuard(db, guard)]);
      return { status: 'active', advanced: true, retryAfter: 0 };
    }
    const transient = error instanceof GoogleContactsError && error.reason === 'retry' || error instanceof ProviderConnectionError && error.status === 503 || run.phase === 'reconcile' && String(error).includes('CLOUD_RECOVERY_CONFLICT');
    const retry = transient && run.failures < 8;
    const delay = error instanceof GoogleContactsError ? error.retryAfter : run.phase === 'reconcile' ? 1 : 30;
    await db.prepare(`UPDATE provider_contact_runs SET status = ?, issue = ?, next_attempt_at = ?, failures = failures + 1, revision = revision + 1, lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND revision = ? AND lease_token = ? AND status = 'active'`)
      .bind(retry ? 'active' : 'failed', transient ? retry ? 'retry' : 'retry_exhausted' : error instanceof GoogleContactsError ? error.reason
        : error instanceof Error && error.message.includes('PROVIDER_CONTACTS_LIMIT') ? 'capacity' : 'connection_changed', retry ? Date.now() + delay * 1000 : 0, new Date().toISOString(), run.id, run.revision, lease).run();
    const current = await db.prepare('SELECT status FROM provider_contact_runs WHERE id = ?').bind(run.id).first<{ status: string }>();
    return { status: current?.status ?? 'missing', advanced: false, retryAfter: current?.status === 'active' && retry ? delay : 0 };
  } finally {
    await db.prepare('UPDATE provider_contact_runs SET lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ?').bind(run.id, lease).run();
  }
}
export function readGoogleContactsQueueMessage(value: unknown): GoogleContactsQueueMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return v.kind === 'google-contacts' && v.version === 1 && typeof v.workspaceId === 'string' && v.workspaceId.length > 0 && v.workspaceId.length <= 128
    && isSyncUuid(v.connectionId) && isSyncUuid(v.runId)
    ? { kind: 'google-contacts', version: 1, workspaceId: v.workspaceId, connectionId: v.connectionId, runId: v.runId } : null;
}
export async function processGoogleContactsMessage(delivery: { body: unknown; attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void },
  env: CloudflareEnv, fetcher: ProviderFetch = fetch) {
  const input = readGoogleContactsQueueMessage(delivery.body);
  if (!input) { delivery.ack(); return; }
  const result = await advanceGoogleContactsDownload(env.DB, { ...process.env, ...env } as unknown as ProviderEnvironment, input, fetcher);
  if (result.status !== 'active') { delivery.ack(); return; }
  if (result.advanced) {
    await env.GOOGLE_CONTACTS_QUEUE.send(input); delivery.ack();
  } else if (delivery.attempts >= 10) {
    await env.DB.prepare(`UPDATE provider_contact_runs SET status = 'failed', issue = 'retry_exhausted', updated_at = ? WHERE id = ? AND status = 'active'
      AND (lease_token IS NULL OR lease_until < ?)`).bind(new Date().toISOString(), input.runId, Date.now()).run();
    delivery.ack();
  } else delivery.retry({ delaySeconds: result.retryAfter || 30 });
}
export async function reconcileGoogleContactsDownloads(db: DB, queue: GoogleContactsQueue, environment?: ProviderEnvironment) {
  const scheduled = environment ? await startDueGoogleContactsDownloads(db, queue, environment) : 0;
  const rows = (await db.prepare(`SELECT r.* FROM provider_contact_runs r JOIN provider_connections c ON c.id = r.connection_id
    JOIN workspace_sync_state s ON s.workspace_id = r.workspace_id JOIN workspace_members m
      ON m.workspace_id = r.workspace_id AND m.user_id = r.user_id AND m.role = 'owner' JOIN workspaces w ON w.id = r.workspace_id
    WHERE r.status = 'active' AND c.status = 'connected' AND c.purpose = 'contacts' AND r.authorization_revision = c.authorization_revision
      AND r.dataset_epoch = s.epoch AND s.epoch = c.dataset_epoch AND s.paused = 0 AND w.lifecycle = 'active'
      AND (r.schedule_revision IS NULL OR EXISTS (SELECT 1 FROM provider_contact_resources p WHERE p.connection_id = r.connection_id AND p.sync_enabled = 1 AND p.settings_revision = r.schedule_revision))
      AND r.next_attempt_at <= ? AND (r.lease_token IS NULL OR r.lease_until < ?) ORDER BY r.updated_at LIMIT 5`)
    .bind(Date.now(), Date.now()).all<Run>()).results;
  for (const run of rows) {
    await queue.send(message(run));
    await db.prepare("UPDATE provider_contact_runs SET updated_at = ? WHERE id = ? AND status = 'active'").bind(new Date().toISOString(), run.id).run();
  }
  // Garbage collection is bounded and preserves the published preview and every active staging generation.
  const cleaned = await db.prepare(`DELETE FROM provider_contact_index WHERE rowid IN (SELECT i.rowid FROM provider_contact_index i
    WHERE NOT EXISTS (SELECT 1 FROM provider_contact_resources r WHERE r.connection_id = i.connection_id AND r.active_generation = i.generation)
      AND NOT EXISTS (SELECT 1 FROM provider_contact_runs j WHERE j.connection_id = i.connection_id AND (j.generation = i.generation OR j.base_generation = i.generation) AND j.status = 'active') LIMIT 500)`).run();
  await db.prepare(`DELETE FROM provider_contact_runs WHERE id IN (SELECT id FROM provider_contact_runs WHERE status != 'active' AND updated_at < ? LIMIT 100)`)
    .bind(new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()).run();
  return { enqueued: rows.length, scheduled, cleaned: cleaned.meta.changes };
}

export async function changeGoogleContactsSchedule(db: DB, actor: ConnectionActor, id: string, body: Record<string, unknown>) {
  const c = await connection(db, actor, id);
  if (Object.keys(body).some((key) => !['expected_epoch', 'expected_authorization_revision', 'expected_settings_revision', 'enabled', 'interval'].includes(key))
    || body.expected_epoch !== c.dataset_epoch || body.expected_authorization_revision !== c.authorization_revision || typeof body.enabled !== 'boolean'
    || ![3600,86400].includes(body.interval as number) || !Number.isSafeInteger(body.expected_settings_revision) || Number(body.expected_settings_revision) < 0) throw new ProviderConnectionError('Refresh this schedule before saving.');
  const guard = crypto.randomUUID(), resource = await db.prepare('SELECT * FROM provider_contact_resources WHERE connection_id = ?').bind(id).first<Resource>();
  if ((resource?.settings_revision ?? 0) !== body.expected_settings_revision) throw new ProviderConnectionError('These automatic sync choices changed. Refresh before saving.');
  await db.batch([maintenanceGuard(db, guard, conditions() + (resource ? ' AND EXISTS (SELECT 1 FROM provider_contact_resources WHERE connection_id = ? AND settings_revision = ?)' : ' AND NOT EXISTS (SELECT 1 FROM provider_contact_resources WHERE connection_id = ?)'),
    [id, actor.workspaceId, actor.userId, c.authorization_revision, c.dataset_epoch, c.dataset_epoch, id, ...(resource ? [resource.settings_revision] : [])]),
    db.prepare(`INSERT INTO provider_contact_resources (connection_id, workspace_id, dataset_epoch, authorization_revision, request_version, sync_enabled, sync_interval, next_sync_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET sync_enabled = excluded.sync_enabled, sync_interval = excluded.sync_interval,
      next_sync_at = excluded.next_sync_at, settings_revision = provider_contact_resources.settings_revision + 1`)
      .bind(id, actor.workspaceId, c.dataset_epoch, c.authorization_revision, GOOGLE_CONTACTS_REQUEST_VERSION, Number(body.enabled), body.interval as number, body.enabled ? Date.now() : 0),
    db.prepare(`UPDATE provider_contact_runs SET status = 'cancelled', issue = 'schedule_changed', lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE connection_id = ? AND status = 'active' AND schedule_revision IS NOT NULL`).bind(new Date().toISOString(), id), removeGuard(db, guard)]);
  return { success: true };
}
export async function startDueGoogleContactsDownloads(db: DB, queue: GoogleContactsQueue, environment: ProviderEnvironment) {
  const rows = (await db.prepare(`SELECT r.*, c.user_id FROM provider_contact_resources r JOIN provider_connections c ON c.id = r.connection_id
    JOIN workspace_sync_state s ON s.workspace_id = r.workspace_id JOIN workspaces w ON w.id = r.workspace_id
    JOIN workspace_members m ON m.workspace_id = r.workspace_id AND m.user_id = c.user_id AND m.role = 'owner'
    WHERE r.sync_enabled = 1 AND r.next_sync_at <= ? AND c.status = 'connected' AND c.purpose = 'contacts' AND c.dataset_epoch = s.epoch AND r.dataset_epoch = s.epoch
      AND r.authorization_revision = c.authorization_revision AND (c.refresh_expires_at IS NULL OR c.refresh_expires_at > ?)
      AND s.paused = 0 AND w.lifecycle = 'active' AND NOT EXISTS (SELECT 1 FROM provider_contact_runs j WHERE j.connection_id = c.id AND j.status = 'active')
    ORDER BY r.next_sync_at LIMIT 5`).bind(Date.now(), Date.now()).all<Resource & { user_id: string }>()).results;
  let started = 0;
  for (const row of rows) {
    try {
      await startGoogleContactsDownload(db, { workspaceId: row.workspace_id, userId: row.user_id, authMethod: 'web' }, environment, row.connection_id,
        { operation_id: crypto.randomUUID(), expected_epoch: row.dataset_epoch, expected_authorization_revision: row.authorization_revision }, queue, { revision: row.settings_revision, due: row.next_sync_at });
      started++;
    } catch (error) { if (!(error instanceof ProviderConnectionError) && !String(error).includes('CLOUD_RECOVERY_CONFLICT')) throw error; }
  }
  return started;
}
