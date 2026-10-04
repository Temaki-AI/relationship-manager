import { calendarIdentifier, readCalendarFacts } from '@/packages/domain/src/calendars';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { fingerprintIdempotencyInput } from '@/lib/idempotency';
import { ProviderConnectionError } from './provider-vault';
import { googleConfiguration, type ProviderEnvironment, type ProviderFetch } from './google-provider';
import { googleConnectionAccess, providerWriteGuard, requireGoogleReconnection, requireProviderOwner, type ConnectionActor, type GoogleAccessGrant } from './provider-connections';
import { googleCalendarResponseJson } from './google-calendars';
import { maintenanceGuard, removeGuard } from './recovery-storage';

type DB = CloudflareEnv['DB'];
type Connection = { id: string; workspace_id: string; user_id: string; account_id: string; email: string; dataset_epoch: string; authorization_revision: number; status: string; epoch: string; refresh_expires_at: number | null };
type Setup = { connection_id: string; workspace_id: string; user_id: string; operation_id: string; fingerprint: string; request_json: string; dataset_epoch: string;
  authorization_revision: number; attempted: number; status: 'pending' | 'unknown' | 'ready' | 'held'; calendar_id: string | null; issue: string | null; revision: number; lease_token: string | null; lease_until: number | null };
type FrozenRequest = { client_id: string; calendar: { summary: string; timeZone: string; description: string } };
const frozenRequest = (row: Setup) => JSON.parse(row.request_json) as FrozenRequest;
const setupFor = (db: DB, id: string) => db.prepare('SELECT * FROM provider_owned_calendars WHERE connection_id = ?').bind(id).first<Setup>();
const currentOwner = `EXISTS (SELECT 1 FROM provider_connections c JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN workspaces w ON w.id = c.workspace_id
  JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ?
    AND c.purpose = 'calendar-publish' AND c.status = 'connected' AND c.dataset_epoch = ? AND c.authorization_revision = ? AND s.epoch = c.dataset_epoch
    AND s.paused = 0 AND w.lifecycle = 'active' AND m.role = 'owner' AND (c.refresh_expires_at IS NULL OR c.refresh_expires_at > ?))`;
const ownerValues = (c: Connection) => [c.id, c.workspace_id, c.user_id, c.dataset_epoch, c.authorization_revision, Date.now()];
async function connection(db: DB, actor: ConnectionActor, id: string, usable = true) {
  await requireProviderOwner(db, actor);
  if (!isSyncUuid(id)) throw new ProviderConnectionError('Publishing connection not found.', 404);
  const row = await db.prepare(`SELECT c.*, s.epoch FROM provider_connections c JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id
    JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.purpose = 'calendar-publish'
      AND s.paused = 0 AND w.lifecycle = 'active'`).bind(id, actor.workspaceId, actor.userId).first<Connection>();
  if (!row) throw new ProviderConnectionError('Publishing connection not found or workspace maintenance is active.', 404);
  if (usable && (row.status !== 'connected' || row.dataset_epoch !== row.epoch || row.refresh_expires_at !== null && row.refresh_expires_at <= Date.now())) throw new ProviderConnectionError('Reconnect Calendar publishing before continuing.');
  return row;
}
function view(row: Setup | null) {
  return row ? { operation_id: row.operation_id, revision: row.revision, status: row.status, attempted: Boolean(row.attempted), calendar_id: row.calendar_id,
    issue: row.issue, chosen_time_zone: frozenRequest(row).calendar.timeZone } : null;
}
export async function reviewOwnedCalendar(db: DB, actor: ConnectionActor, id: string) {
  const c = await connection(db, actor, id, false), row = await setupFor(db, id);
  return { epoch: c.epoch, authorization_revision: c.authorization_revision, email: c.email,
    unsent_access_changed: Boolean(row && !row.attempted && (row.dataset_epoch !== c.epoch || row.authorization_revision !== c.authorization_revision)),
    can_continue: c.status === 'connected' && c.dataset_epoch === c.epoch && (c.refresh_expires_at === null || c.refresh_expires_at > Date.now()), setup: view(row) };
}
export async function startOwnedCalendar(db: DB, actor: ConnectionActor, env: ProviderEnvironment, id: string, body: Record<string, unknown>) {
  const configuration = googleConfiguration(env, 'calendar-publish');
  const c = await connection(db, actor, id);
  if (Object.keys(body).length !== 4 || !isSyncUuid(body.operation_id) || body.expected_epoch !== c.dataset_epoch || body.expected_authorization_revision !== c.authorization_revision
    || typeof body.time_zone !== 'string' || body.time_zone.length > 100) throw new ProviderConnectionError('Review this publishing account and timezone again.', 400);
  let timeZone: string;
  try {
    timeZone = new Intl.DateTimeFormat('en', { timeZone: body.time_zone }).resolvedOptions().timeZone;
    if (/^[+-]/u.test(timeZone)) throw new Error('Google requires a timezone name.');
  } catch { throw new ProviderConnectionError('Choose a valid calendar timezone name, such as Europe/Lisbon.', 400); }
  const request = JSON.stringify({ client_id: configuration.clientId, calendar: { summary: 'Everclose', timeZone, description: 'Everclose calendar recovery: ' + body.operation_id } });
  const fingerprint = fingerprintIdempotencyInput({ connection: id, client_id: configuration.clientId, ...body });
  const existing = await setupFor(db, id);
  if (existing) {
    if (existing.operation_id === body.operation_id && existing.fingerprint === fingerprint) return view(existing)!;
    throw new ProviderConnectionError('This account already has a calendar setup. Review or reconcile it before starting another.');
  }
  const guard = crypto.randomUUID(), now = new Date().toISOString();
  try { await db.batch([
    maintenanceGuard(db, guard, currentOwner + ' AND NOT EXISTS (SELECT 1 FROM provider_owned_calendars WHERE connection_id = ?)', [...ownerValues(c), id]),
    db.prepare(`INSERT INTO provider_owned_calendars (connection_id, workspace_id, user_id, operation_id, fingerprint, request_json, dataset_epoch, authorization_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, actor.workspaceId, actor.userId, body.operation_id, fingerprint, request, c.dataset_epoch, c.authorization_revision, now, now),
    removeGuard(db, guard),
  ]); } catch (error) { const saved = await setupFor(db, id); if (saved?.operation_id === body.operation_id && saved.fingerprint === fingerprint) return view(saved)!; throw error; }
  return view((await setupFor(db, id))!)!;
}

class CalendarSetupError extends ProviderConnectionError {
  reason: 'permission' | 'retry' | 'invalid' | 'not_visible' | 'ambiguous';
  constructor(reason: CalendarSetupError['reason']) { super('Calendar creation or verification is unconfirmed. Review the retained setup before retrying.', reason === 'retry' ? 503 : 409); this.reason = reason; }
}
async function providerRequest(accessToken: string, url: URL, fetcher: ProviderFetch, body?: string) {
  let response: Response;
  try { response = await fetcher(url.href, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + accessToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body, redirect: 'error', signal: AbortSignal.timeout(10_000) }); } catch { throw new CalendarSetupError('retry'); }
  if (response.status === 401) throw new CalendarSetupError('permission');
  if (response.status === 429 || response.status >= 500) throw new CalendarSetupError('retry');
  if (response.status === 404) throw new CalendarSetupError('not_visible');
  let value; try { value = await googleCalendarResponseJson(response); } catch { throw new CalendarSetupError('invalid'); }
  if (!response.ok) {
    const error = value.error as { errors?: Array<{ reason?: string }> } | undefined;
    if (Array.isArray(error?.errors) && error.errors.some((e) => e && ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(e.reason || ''))) throw new CalendarSetupError('retry');
    throw new CalendarSetupError(response.status === 403 ? 'permission' : 'invalid');
  }
  return value;
}
function ownedIdentity(value: Record<string, unknown>, request: Record<string, unknown>, created = false) {
  if (value.description !== request.description || value.primary === true || !created && value.accessRole !== 'owner') throw new CalendarSetupError('invalid');
  try {
    const facts = readCalendarFacts({ id: value.id, summary: value.summary, time_zone: value.timeZone, access_role: 'owner', primary: false, hidden: value.hidden ?? false });
    return facts.id;
  } catch { throw new CalendarSetupError('invalid'); }
}
async function discoverOriginal(accessToken: string, row: Setup, fetcher: ProviderFetch) {
  const request = frozenRequest(row).calendar;
  if (row.calendar_id) {
    const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList/' + encodeURIComponent(calendarIdentifier(row.calendar_id)));
    url.searchParams.set('fields', 'id,summary,timeZone,description,accessRole,primary,hidden');
    const value = await providerRequest(accessToken, url, fetcher);
    if (ownedIdentity(value, request) !== row.calendar_id) throw new CalendarSetupError('invalid');
    return row.calendar_id;
  }
  let next: string | null = null, count = 0; const tokens = new Set<string>(), matches = new Set<string>();
  for (let page = 0; page < 4; page++) {
    const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    for (const [key, value] of Object.entries({ maxResults: '250', showHidden: 'true', showDeleted: 'false', minAccessRole: 'owner', fields: 'nextPageToken,items(id,summary,timeZone,description,accessRole,primary,hidden)' })) url.searchParams.set(key, value);
    if (next) url.searchParams.set('pageToken', next);
    const value = await providerRequest(accessToken, url, fetcher);
    if (value.items !== undefined && !Array.isArray(value.items)) throw new CalendarSetupError('invalid');
    const items = (value.items ?? []) as unknown[]; count += items.length;
    if (items.length > 250 || count > 1000) throw new CalendarSetupError('invalid');
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CalendarSetupError('invalid');
      const item = raw as Record<string, unknown>;
      if (item.description === request.description) matches.add(ownedIdentity(item, request));
    }
    if (value.nextPageToken === undefined) {
      if (matches.size !== 1) throw new CalendarSetupError(matches.size ? 'ambiguous' : 'not_visible');
      return [...matches][0];
    }
    if (typeof value.nextPageToken !== 'string' || !value.nextPageToken || value.nextPageToken.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value.nextPageToken) || tokens.has(value.nextPageToken)) throw new CalendarSetupError('invalid');
    next = value.nextPageToken; tokens.add(next);
  }
  throw new CalendarSetupError('invalid');
}

export async function advanceOwnedCalendar(db: DB, actor: ConnectionActor, env: ProviderEnvironment, id: string, body: Record<string, unknown>, fetcher: ProviderFetch = fetch) {
  const c = await connection(db, actor, id), row = await setupFor(db, id);
  if (Object.keys(body).length !== 4 || !row || row.operation_id !== body.operation_id || row.revision !== body.expected_revision
    || body.expected_epoch !== c.dataset_epoch || body.expected_authorization_revision !== c.authorization_revision) throw new ProviderConnectionError('Refresh the retained calendar setup before continuing.');
  if (!row.attempted && (row.dataset_epoch !== c.dataset_epoch || row.authorization_revision !== c.authorization_revision
    || frozenRequest(row).client_id !== googleConfiguration(env, 'calendar-publish').clientId)) throw new ProviderConnectionError('The unsent setup belongs to earlier consent or a different publishing app. Discard it and review a new request.');
  const lease = crypto.randomUUID();
  const claimed = await db.prepare(`UPDATE provider_owned_calendars SET lease_token = ?, lease_until = ? WHERE connection_id = ? AND revision = ?
    AND (lease_token IS NULL OR lease_until < ?) AND ${currentOwner} RETURNING connection_id`)
    .bind(lease, Date.now() + 75_000, id, row.revision, Date.now(), ...ownerValues(c)).first();
  if (!claimed) throw new ProviderConnectionError('This calendar setup is being verified or access changed. Refresh shortly.', 503);
  let revision = row.revision, grant: GoogleAccessGrant | undefined;
  try {
    grant = await googleConnectionAccess(db, actor, env, id, c.dataset_epoch, fetcher, 'calendar-publish');
    let calendarId: string;
    if (row.attempted) calendarId = await discoverOriginal(grant.accessToken, row, fetcher);
    else {
      const guard = crypto.randomUUID();
      await db.batch([
        providerWriteGuard(db, grant, guard),
        maintenanceGuard(db, guard + '-setup', currentOwner + ` AND EXISTS (SELECT 1 FROM provider_owned_calendars WHERE connection_id = ? AND revision = ? AND attempted = 0 AND lease_token = ? AND lease_until >= ?)` , [...ownerValues(c), id, revision, lease, Date.now()]),
        db.prepare("UPDATE provider_owned_calendars SET attempted = 1, status = 'unknown', revision = revision + 1, issue = NULL, updated_at = ? WHERE connection_id = ?").bind(new Date().toISOString(), id),
        removeGuard(db, guard), removeGuard(db, guard + '-setup'),
      ]);
      revision++;
      // This attempted marker is durable before sending. It is never cleared to resend.
      const stillCurrent = await db.prepare(`SELECT 1 WHERE ${currentOwner} AND EXISTS (SELECT 1 FROM provider_owned_calendars WHERE connection_id = ? AND revision = ? AND lease_token = ? AND lease_until >= ?)`)
        .bind(...ownerValues(c), id, revision, lease, Date.now()).first();
      if (!stillCurrent) throw new ProviderConnectionError('Authorization or recovery changed before calendar creation.');
      const url = new URL('https://www.googleapis.com/calendar/v3/calendars'); url.searchParams.set('fields', 'id,summary,timeZone,description');
      const request = frozenRequest(row).calendar;
      const value = await providerRequest(grant.accessToken, url, fetcher, JSON.stringify(request));
      calendarId = ownedIdentity(value, request, true);
    }
    const guard = crypto.randomUUID();
    await db.batch([
      providerWriteGuard(db, grant, guard),
      maintenanceGuard(db, guard + '-setup', currentOwner + ` AND EXISTS (SELECT 1 FROM provider_owned_calendars WHERE connection_id = ? AND revision = ? AND lease_token = ? AND lease_until >= ?)` , [...ownerValues(c), id, revision, lease, Date.now()]),
      db.prepare(`UPDATE provider_owned_calendars SET calendar_id = ?, status = 'ready', issue = NULL, dataset_epoch = ?, authorization_revision = ?, revision = revision + 1,
        lease_token = NULL, lease_until = NULL, updated_at = ? WHERE connection_id = ?`).bind(calendarId, c.dataset_epoch, c.authorization_revision, new Date().toISOString(), id),
      removeGuard(db, guard), removeGuard(db, guard + '-setup'),
    ]);
    return view((await setupFor(db, id))!)!;
  } catch (error) {
    if (error instanceof CalendarSetupError) {
      if (error.reason === 'permission') {
        // Revocation fences also hold the retained request; it must survive reconnection.
        if (grant) await requireGoogleReconnection(db, grant);
      } else {
        await db.prepare(`UPDATE provider_owned_calendars SET status = CASE WHEN attempted = 1 THEN 'unknown' ELSE status END,
          issue = ?, revision = revision + 1, lease_token = NULL, lease_until = NULL WHERE connection_id = ? AND revision = ? AND lease_token = ? AND lease_until >= ? AND ${currentOwner}`)
          .bind(error.reason, id, revision, lease, Date.now(), ...ownerValues(c)).run();
      }
      return view((await setupFor(db, id))!)!;
    }
    throw error;
  } finally { await db.prepare('UPDATE provider_owned_calendars SET lease_token = NULL, lease_until = NULL WHERE connection_id = ? AND lease_token = ?').bind(id, lease).run(); }
}
export async function discardUnsentOwnedCalendar(db: DB, actor: ConnectionActor, id: string, body: Record<string, unknown>) {
  const c = await connection(db, actor, id, false);
  if (Object.keys(body).length !== 2 || !isSyncUuid(body.operation_id) || !Number.isSafeInteger(body.expected_revision)) throw new ProviderConnectionError('Review the unsent calendar setup first.', 400);
  const result = await db.prepare(`DELETE FROM provider_owned_calendars WHERE connection_id = ? AND workspace_id = ? AND user_id = ? AND operation_id = ? AND revision = ? AND attempted = 0
    AND (lease_token IS NULL OR lease_until < ?) AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'owner')`)
    .bind(id, c.workspace_id, c.user_id, body.operation_id, body.expected_revision, Date.now(), c.workspace_id, c.user_id).run();
  if (!result.meta.changes) throw new ProviderConnectionError('This request may have reached Google. Reconcile it instead of discarding.');
  return { discarded: true };
}
export async function publishingCalendarAccess(db: DB, actor: ConnectionActor, env: ProviderEnvironment, id: string, fetcher: ProviderFetch = fetch) {
  const c = await connection(db, actor, id), row = await setupFor(db, id), configuration = googleConfiguration(env, 'calendar-publish');
  if (!row?.calendar_id || row.status !== 'ready' || row.dataset_epoch !== c.dataset_epoch || row.authorization_revision !== c.authorization_revision) throw new ProviderConnectionError('Verify the dedicated calendar setup before publishing.');
  if (frozenRequest(row).client_id !== configuration.clientId) throw new ProviderConnectionError('This calendar was created by a different OAuth app. Restore its publishing client before writing events.');
  const grant = await googleConnectionAccess(db, actor, env, id, c.dataset_epoch, fetcher, 'calendar-publish');
  try {
    const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList/' + encodeURIComponent(row.calendar_id));
    url.searchParams.set('fields', 'id,summary,timeZone,description,accessRole,primary,hidden');
    const value = await providerRequest(grant.accessToken, url, fetcher);
    if (ownedIdentity(value, frozenRequest(row).calendar) !== row.calendar_id) throw new CalendarSetupError('invalid');
    const calendar = readCalendarFacts({ id: value.id, summary: value.summary, time_zone: value.timeZone, access_role: 'owner', primary: false, hidden: value.hidden ?? false });
    const guard = crypto.randomUUID();
    await db.batch([providerWriteGuard(db, grant, guard),
      maintenanceGuard(db, guard + '-calendar', currentOwner + ' AND EXISTS (SELECT 1 FROM provider_owned_calendars WHERE connection_id = ? AND revision = ? AND status = ? AND calendar_id = ?)',
        [...ownerValues(c), id, row.revision, 'ready', row.calendar_id]), removeGuard(db, guard), removeGuard(db, guard + '-calendar')]);
    return { connection: c, setup: row, grant, calendar, clientId: configuration.clientId };
  } catch (error) {
    if (error instanceof CalendarSetupError && error.reason === 'permission') await requireGoogleReconnection(db, grant);
    throw error;
  }
}
export { currentOwner as publishingOwnerCondition, ownerValues as publishingOwnerValues };
