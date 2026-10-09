import { calendarIdentifier, readCalendarFacts } from '@/packages/domain/src/calendars';
import type { CalendarEventFacts, CalendarEventsReview } from '@/packages/domain/src/calendar-events';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { fingerprintIdempotencyInput } from '@/lib/idempotency';
import { ProviderConnectionError, providerDigest } from './provider-vault';
import { googleConfiguration, type ProviderEnvironment, type ProviderFetch } from './google-provider';
import { googleConnectionAccess, providerWriteGuard, requireGoogleReconnection, requireProviderOwner, type ConnectionActor } from './provider-connections';
import { calendarDownloadWindow, eventSortKey, GoogleEventsError, googleEventsPage } from './google-calendar-events';
import { maintenanceGuard, removeGuard } from './recovery-storage';
import { calendarPlanObservationStatements } from './calendar-plan-observations';
import { calendarEventObservationStatements } from './calendar-event-observations';
type DB = CloudflareEnv['DB'];
type Access = { id: string; account_id: string; email: string; dataset_epoch: string; authorization_revision: number; selection_revision: number; facts: string; availability: string };
type Resource = { active_generation: string | null; window_start: string | null; window_end: string | null; last_downloaded_at: string | null; availability: 'available' | 'unavailable';
  sync_enabled: number; sync_interval: 3600 | 86400; settings_revision: number; past_days: number; future_days: number; next_sync_at: number };
type Run = { id: string; connection_id: string; calendar_id: string; workspace_id: string; user_id: string; dataset_epoch: string; authorization_revision: number;
  selection_revision: number; fingerprint: string; schedule_revision: number | null; status: string; generation: string; base_generation: string | null; calendar_time_zone: string;
  window_start: string; window_end: string; next_page: string | null; pages: number; processed: number; revision: number; lease_token: string | null; failures: number; retry_at: number; issue: string | null };
function publicRun(run: Run) { return { id: run.id, status: run.status, processed: run.processed, pages: run.pages, issue: run.issue, retry_at: run.retry_at }; }
const resourceFor = (db: DB, id: string, calendarId: string) => db.prepare('SELECT * FROM provider_event_resources WHERE connection_id = ? AND calendar_id = ?').bind(id, calendarId).first<Resource>();
const runFor = (db: DB, id: string) => db.prepare('SELECT * FROM provider_event_runs WHERE id = ?').bind(id).first<Run>();
export async function calendarEventAccess(db: DB, actor: ConnectionActor, id: string, calendarId: unknown) {
  await requireProviderOwner(db, actor);
  if (!isSyncUuid(id)) throw new ProviderConnectionError('Calendar connection not found.', 404);
  try { calendarIdentifier(calendarId); } catch { throw new ProviderConnectionError('Choose a saved calendar.', 400); }
  const c = await db.prepare(`SELECT c.id, c.account_id, c.email, c.dataset_epoch, c.authorization_revision, r.selection_revision, k.facts, k.availability FROM provider_connections c
    JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN workspaces w ON w.id = c.workspace_id
    JOIN provider_calendar_resources r ON r.connection_id = c.id JOIN provider_calendars k ON k.connection_id = c.id AND k.calendar_id = ?
    WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.purpose = 'calendar' AND c.status = 'connected'
      AND c.dataset_epoch = s.epoch AND s.paused = 0 AND w.lifecycle = 'active' AND (c.refresh_expires_at IS NULL OR c.refresh_expires_at > ?)
      AND EXISTS (SELECT 1 FROM json_each(r.selected_ids) WHERE value = k.calendar_id)`)
    .bind(calendarId, id, actor.workspaceId, actor.userId, Date.now()).first<Access>();
  if (!c) throw new ProviderConnectionError('Reconnect Calendar and refresh your saved choices before reading events.');
  return { ...c, calendar_id: calendarId as string, calendar: readCalendarFacts(JSON.parse(c.facts)) };
}
const access = calendarEventAccess;
const selectionCondition = `EXISTS (SELECT 1 FROM provider_calendar_resources r JOIN provider_calendars k ON k.connection_id = r.connection_id
  WHERE r.connection_id = ? AND r.selection_revision = ? AND k.calendar_id = ? AND k.availability = 'available'
  AND json_extract(k.facts, '$.access_role') != 'freeBusyReader' AND EXISTS (SELECT 1 FROM json_each(r.selected_ids) WHERE value = k.calendar_id))`;
const ownerCondition = `EXISTS (SELECT 1 FROM provider_connections c JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id
  JOIN workspaces w ON w.id = c.workspace_id JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
  WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.purpose = 'calendar' AND c.status = 'connected'
  AND c.dataset_epoch = ? AND c.authorization_revision = ? AND c.dataset_epoch = s.epoch AND s.paused = 0 AND w.lifecycle = 'active' AND m.role = 'owner'
  AND (c.refresh_expires_at IS NULL OR c.refresh_expires_at > ?))`;
const ownerValues = (actor: ConnectionActor, c: Access) => [c.id, actor.workspaceId, actor.userId, c.dataset_epoch, c.authorization_revision, Date.now()];
const scheduleCondition = `(? IS NULL OR EXISTS (SELECT 1 FROM provider_event_resources WHERE connection_id = ? AND calendar_id = ? AND sync_enabled = 1 AND settings_revision = ?))`;
const scheduleValues = (run: Run) => [run.schedule_revision, run.connection_id, run.calendar_id, run.schedule_revision];
export async function changeCalendarEventSchedule(db: DB, actor: ConnectionActor, id: string, body: Record<string, unknown>) {
  const c = await access(db, actor, id, body.calendar_id);
  if (Object.keys(body).length !== 9 || Object.keys(body).some((key) => !['calendar_id', 'expected_epoch', 'expected_authorization_revision', 'expected_selection_revision', 'expected_settings_revision', 'enabled', 'interval', 'past_days', 'future_days'].includes(key))
    || body.expected_epoch !== c.dataset_epoch || body.expected_authorization_revision !== c.authorization_revision || body.expected_selection_revision !== c.selection_revision
    || !Number.isSafeInteger(body.expected_settings_revision) || Number(body.expected_settings_revision) < 0 || typeof body.enabled !== 'boolean'
    || ![3600, 86400].includes(body.interval as number)) throw new ProviderConnectionError('Refresh these automatic event choices before saving.', 400);
  calendarDownloadWindow(c.calendar.time_zone, body.past_days, body.future_days);
  if (body.enabled && (c.availability !== 'available' || c.calendar.access_role === 'freeBusyReader')) throw new ProviderConnectionError('Refresh your calendar choices and event access before enabling automatic downloads.');
  const r = await resourceFor(db, id, c.calendar_id), guard = crypto.randomUUID();
  if ((r?.settings_revision ?? 0) !== body.expected_settings_revision) throw new ProviderConnectionError('Automatic event choices changed. Refresh before saving.');
  await db.batch([
    maintenanceGuard(db, guard, ownerCondition + ` AND ${body.enabled ? selectionCondition : 'EXISTS (SELECT 1 FROM provider_calendar_resources WHERE connection_id = ? AND selection_revision = ?)'}
      AND ${r ? 'EXISTS (SELECT 1 FROM provider_event_resources WHERE connection_id = ? AND calendar_id = ? AND settings_revision = ?)' : 'NOT EXISTS (SELECT 1 FROM provider_event_resources WHERE connection_id = ? AND calendar_id = ?)'}`,
      [...ownerValues(actor, c), id, c.selection_revision, ...(body.enabled ? [c.calendar_id] : []), id, c.calendar_id, ...(r ? [r.settings_revision] : [])]),
    db.prepare(`INSERT INTO provider_event_resources (connection_id, calendar_id, workspace_id, sync_enabled, sync_interval, settings_revision, past_days, future_days, next_sync_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT(connection_id, calendar_id) DO UPDATE SET sync_enabled = excluded.sync_enabled,
      sync_interval = excluded.sync_interval, settings_revision = provider_event_resources.settings_revision + 1, past_days = excluded.past_days,
      future_days = excluded.future_days, next_sync_at = excluded.next_sync_at`)
      .bind(id, c.calendar_id, actor.workspaceId, Number(body.enabled), body.interval as number, body.past_days as number, body.future_days as number, body.enabled ? Date.now() : 0),
    removeGuard(db, guard),
  ]);
  return { success: true };
}
export async function startEventDownload(db: DB, actor: ConnectionActor, environment: ProviderEnvironment, id: string, body: Record<string, unknown>, scheduled?: { revision: number; due: number }) {
  googleConfiguration(environment, 'calendar');
  const c = await access(db, actor, id, body.calendar_id);
  if (Object.keys(body).length !== 7 || !isSyncUuid(body.operation_id) || body.expected_epoch !== c.dataset_epoch || body.expected_authorization_revision !== c.authorization_revision
    || !Number.isInteger(body.expected_selection_revision)) throw new ProviderConnectionError('Refresh this calendar before downloading events.');
  const window = calendarDownloadWindow(c.calendar.time_zone, body.past_days, body.future_days);
  const fingerprint = fingerprintIdempotencyInput(body), previous = await runFor(db, body.operation_id);
  if (previous) {
    if (previous.connection_id !== id || previous.calendar_id !== c.calendar_id || previous.workspace_id !== actor.workspaceId || previous.user_id !== actor.userId
      || previous.dataset_epoch !== c.dataset_epoch || previous.authorization_revision !== c.authorization_revision || previous.fingerprint !== fingerprint
      || previous.schedule_revision !== (scheduled?.revision ?? null)) throw new ProviderConnectionError('This download request belongs to different calendar choices or dates.');
    return publicRun(previous);
  }
  if (body.expected_selection_revision !== c.selection_revision || c.availability !== 'available' || c.calendar.access_role === 'freeBusyReader') throw new ProviderConnectionError('Refresh calendar choices and event permissions before downloading.');
  const r = await resourceFor(db, id, c.calendar_id), guard = crypto.randomUUID(), generation = crypto.randomUUID(), now = new Date().toISOString();
  if (scheduled && (!r?.sync_enabled || r.settings_revision !== scheduled.revision || r.next_sync_at !== scheduled.due
    || scheduled.due > Date.now() || r.past_days !== body.past_days || r.future_days !== body.future_days)) throw new ProviderConnectionError('Automatic refresh choices changed.');
  try {
    await db.batch([
      maintenanceGuard(db, guard, ownerCondition + ' AND ' + selectionCondition + ` AND NOT EXISTS (SELECT 1 FROM provider_event_runs WHERE connection_id = ? AND calendar_id = ? AND status = 'active')
        AND ${r ? 'EXISTS (SELECT 1 FROM provider_event_resources WHERE connection_id = ? AND calendar_id = ? AND active_generation IS ?' + (scheduled ? ' AND sync_enabled = 1 AND settings_revision = ? AND next_sync_at = ?' : '') + ')' : 'NOT EXISTS (SELECT 1 FROM provider_event_resources WHERE connection_id = ? AND calendar_id = ?)'}`,
      [...ownerValues(actor, c), id, c.selection_revision, c.calendar_id, id, c.calendar_id, id, c.calendar_id, ...(r ? [r.active_generation] : []), ...(scheduled ? [scheduled.revision, scheduled.due] : [])]),
      db.prepare('DELETE FROM provider_event_index WHERE connection_id = ? AND calendar_id = ? AND generation IS NOT ?').bind(id, c.calendar_id, r?.active_generation ?? null),
      db.prepare('DELETE FROM provider_event_pages WHERE run_id IN (SELECT id FROM provider_event_runs WHERE connection_id = ? AND calendar_id = ?)').bind(id, c.calendar_id),
      db.prepare('INSERT INTO provider_event_resources (connection_id, calendar_id, workspace_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(id, c.calendar_id, actor.workspaceId),
      db.prepare(`INSERT INTO provider_event_runs (id, connection_id, calendar_id, workspace_id, user_id, dataset_epoch, authorization_revision, selection_revision,
        fingerprint, generation, base_generation, calendar_time_zone, window_start, window_end, created_at, updated_at, schedule_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(body.operation_id, id, c.calendar_id, actor.workspaceId, actor.userId, c.dataset_epoch, c.authorization_revision, c.selection_revision, fingerprint, generation, r?.active_generation ?? null, c.calendar.time_zone, window.start, window.end, now, now, scheduled?.revision ?? null),
      ...(scheduled ? [db.prepare('UPDATE provider_event_resources SET next_sync_at = ? WHERE connection_id = ? AND calendar_id = ?').bind(Date.now() + r!.sync_interval * 1000, id, c.calendar_id)] : []),
      removeGuard(db, guard),
    ]);
  } catch (error) { const replay = await runFor(db, body.operation_id); if (replay && replay.fingerprint === fingerprint && replay.connection_id === id && replay.user_id === actor.userId && replay.workspace_id === actor.workspaceId && replay.dataset_epoch === c.dataset_epoch && replay.authorization_revision === c.authorization_revision && replay.schedule_revision === (scheduled?.revision ?? null)) return publicRun(replay); throw error; }
  return publicRun((await runFor(db, body.operation_id))!);
}
export async function advanceEventDownload(db: DB, actor: ConnectionActor, environment: ProviderEnvironment, id: string, runId: unknown, fetcher: ProviderFetch = fetch) {
  if (!isSyncUuid(runId)) throw new ProviderConnectionError('Choose the current event download.');
  const run = await runFor(db, runId);
  if (!run || run.connection_id !== id || run.workspace_id !== actor.workspaceId || run.user_id !== actor.userId) throw new ProviderConnectionError('Event download not found.', 404);
  const c = await access(db, actor, id, run.calendar_id);
  if (run.dataset_epoch !== c.dataset_epoch || run.authorization_revision !== c.authorization_revision) throw new ProviderConnectionError('Calendar authorization changed.');
  if (run.status !== 'active' || run.retry_at > Date.now()) return publicRun(run);
  const lease = crypto.randomUUID(), nowMs = Date.now();
  const claimed = await db.prepare(`UPDATE provider_event_runs SET lease_token = ?, lease_until = ? WHERE id = ? AND revision = ? AND status = 'active' AND (lease_token IS NULL OR lease_until < ?)
    AND ${ownerCondition} AND ${selectionCondition} AND ${scheduleCondition} RETURNING id`).bind(lease, nowMs + 45_000, run.id, run.revision, nowMs, ...ownerValues(actor, c), id, run.selection_revision, run.calendar_id, ...scheduleValues(run)).first();
  if (!claimed) throw new ProviderConnectionError('This download is running or calendar choices changed. Refresh and try again.', 503);
  try {
    const grant = await googleConnectionAccess(db, actor, environment, id, run.dataset_epoch, fetcher, 'calendar');
    let page; try { page = await googleEventsPage(grant.accessToken, run.calendar_id, run.calendar_time_zone, run.window_start, run.window_end, run.next_page, fetcher); }
    catch (error) { if (error instanceof GoogleEventsError && error.reason === 'permission') await requireGoogleReconnection(db, grant); throw error; }
    const tokenHash = page.next ? await providerDigest(page.next) : null;
    if (run.pages >= 200 || page.next && run.pages + 1 >= 200 || run.processed + page.events.length > 5000
      || tokenHash && await db.prepare('SELECT 1 FROM provider_event_pages WHERE run_id = ? AND token_hash = ?').bind(run.id, tokenHash).first()) throw new GoogleEventsError('invalid');
    const done = page.next === null, guard = crypto.randomUUID(), now = new Date().toISOString();
    const planObservations = done ? await calendarPlanObservationStatements(db, actor.workspaceId, c.account_id, id, run.calendar_id, run.generation, page.events, run.calendar_time_zone) : [];
    await db.batch([
      providerWriteGuard(db, grant, guard),
      maintenanceGuard(db, guard + '-run', `EXISTS (SELECT 1 FROM provider_event_runs WHERE id = ? AND revision = ? AND lease_token = ? AND lease_until >= ? AND status = 'active')
        AND EXISTS (SELECT 1 FROM provider_event_resources WHERE connection_id = ? AND calendar_id = ? AND active_generation IS ?) AND ${selectionCondition} AND ${scheduleCondition} AND ${ownerCondition}`,
        [run.id, run.revision, lease, Date.now(), id, run.calendar_id, run.base_generation, id, run.selection_revision, run.calendar_id, ...scheduleValues(run), ...ownerValues(actor, c)]),
      ...page.events.map((event) => db.prepare('INSERT INTO provider_event_index (connection_id, calendar_id, generation, event_id, sort_key, facts) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, run.calendar_id, run.generation, event.id, eventSortKey(event, run.calendar_time_zone), JSON.stringify(event))),
      ...(tokenHash ? [db.prepare('INSERT INTO provider_event_pages (run_id, token_hash) VALUES (?, ?)').bind(run.id, tokenHash)] : []),
      ...(done ? [
        ...planObservations,
        ...calendarEventObservationStatements(db, actor.workspaceId, c.account_id, run.calendar_id, run.generation, run.window_start, run.window_end, now, c.calendar.summary, c.calendar.time_zone)(id),
        db.prepare(`UPDATE provider_event_resources SET active_generation = ?, window_start = ?, window_end = ?, last_downloaded_at = ?, availability = 'available' WHERE connection_id = ? AND calendar_id = ?`)
          .bind(run.generation, run.window_start, run.window_end, now, id, run.calendar_id),
        db.prepare('DELETE FROM provider_event_index WHERE connection_id = ? AND calendar_id = ? AND generation != ?').bind(id, run.calendar_id, run.generation),
        db.prepare('DELETE FROM provider_event_pages WHERE run_id = ?').bind(run.id),
      ] : []),
      db.prepare(`UPDATE provider_event_runs SET next_page = ?, pages = pages + 1, processed = processed + ?, status = ?, revision = revision + 1, failures = 0,
        retry_at = 0, issue = NULL, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`).bind(page.next, page.events.length, done ? 'complete' : 'active', now, run.id),
      removeGuard(db, guard), removeGuard(db, guard + '-run'),
    ]);
    return publicRun((await runFor(db, run.id))!);
  } catch (error) {
    if (error instanceof GoogleEventsError && error.reason !== 'permission' || /provider_event_index|PROVIDER_EVENT_INVALID/u.test(String(error))) {
      const retry = error instanceof GoogleEventsError && error.reason === 'retry' && run.failures < 8;
      const issue = retry ? 'provider_retry' : error instanceof GoogleEventsError && error.reason === 'unavailable' ? 'calendar_unavailable' : 'unsupported_events';
      const guard = crypto.randomUUID();
      try { await db.batch([
        maintenanceGuard(db, guard, ownerCondition + ' AND ' + selectionCondition + ' AND ' + scheduleCondition + ` AND EXISTS (SELECT 1 FROM provider_event_runs WHERE id = ? AND revision = ? AND lease_token = ? AND status = 'active')`, [...ownerValues(actor, c), id, run.selection_revision, run.calendar_id, ...scheduleValues(run), run.id, run.revision, lease]),
        db.prepare(`UPDATE provider_event_runs SET status = ?, failures = failures + 1, retry_at = ?, issue = ?, revision = revision + 1, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`)
          .bind(retry ? 'active' : 'failed', retry ? Date.now() + (error instanceof GoogleEventsError ? error.retryAfter : 30) * 1000 : 0, issue, new Date().toISOString(), run.id),
        ...(issue === 'calendar_unavailable' ? [db.prepare("UPDATE provider_event_resources SET availability = 'unavailable' WHERE connection_id = ? AND calendar_id = ?").bind(id, run.calendar_id)] : []),
        removeGuard(db, guard),
      ]); } catch { throw new ProviderConnectionError('Calendar choices or authorization changed during this download.'); }
      return publicRun((await runFor(db, run.id))!);
    }
    throw error;
  } finally { await db.prepare('UPDATE provider_event_runs SET lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ?').bind(run.id, lease).run(); }
}
export async function reviewCalendarEvents(db: DB, actor: ConnectionActor, id: string, query: URLSearchParams): Promise<CalendarEventsReview> {
  const c = await access(db, actor, id, query.get('calendar_id')), r = await resourceFor(db, id, c.calendar_id);
  let after: [string, string] | null = null;
  if (query.has('after')) {
    try { const raw = JSON.parse(query.get('after')!); if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(raw[0])) throw new Error(); calendarIdentifier(raw[1]); after = raw as [string, string]; } catch { throw new ProviderConnectionError('Start from the first event page.', 400); }
    if (query.get('generation') !== r?.active_generation) throw new ProviderConnectionError('Events changed. Start from the first page.');
  }
  const results = await db.batch([
    db.prepare(`SELECT * FROM provider_event_index WHERE connection_id = ? AND calendar_id = ? AND generation = ?
      AND (? = 1 OR json_extract(facts, '$.status') != 'cancelled') AND (? IS NULL OR (sort_key, event_id) > (?, ?)) ORDER BY sort_key, event_id LIMIT 51`)
      .bind(id, c.calendar_id, r?.active_generation ?? '', query.get('cancelled') === '1' ? 1 : 0, after?.[0] ?? null, after?.[0] ?? '', after?.[1] ?? ''),
    db.prepare("SELECT * FROM provider_event_runs WHERE connection_id = ? AND calendar_id = ? ORDER BY (status = 'active') DESC, created_at DESC, rowid DESC LIMIT 1").bind(id, c.calendar_id),
    db.prepare('SELECT * FROM provider_event_resources WHERE connection_id = ? AND calendar_id = ?').bind(id, c.calendar_id),
  ]);
  const fresh = results[2].results[0] as Resource | undefined, check = await access(db, actor, id, c.calendar_id);
  if (check.dataset_epoch !== c.dataset_epoch || check.authorization_revision !== c.authorization_revision || check.selection_revision !== c.selection_revision || (fresh?.active_generation ?? null) !== (r?.active_generation ?? null) || (fresh?.settings_revision ?? 0) !== (r?.settings_revision ?? 0)) throw new ProviderConnectionError('Calendar events or access changed. Refresh this page.');
  const rows = results[0].results as Array<{ event_id: string; sort_key: string; facts: string }>, page = rows.slice(0, 50), last = page.at(-1);
  return { epoch: c.dataset_epoch, authorization_revision: c.authorization_revision, selection_revision: c.selection_revision, calendar: c.calendar,
    availability: c.availability === 'unavailable' || c.calendar.access_role === 'freeBusyReader' || r?.availability === 'unavailable' ? 'unavailable' : 'available',
    can_download: c.availability === 'available' && c.calendar.access_role !== 'freeBusyReader',
    generation: r?.active_generation ?? null, window_start: r?.window_start ?? null, window_end: r?.window_end ?? null, last_downloaded_at: r?.last_downloaded_at ?? null,
    events: page.map((row) => JSON.parse(row.facts) as CalendarEventFacts), more: rows.length > 50, next: rows.length > 50 && last ? JSON.stringify([last.sort_key, last.event_id]) : null,
    run: results[1].results[0] ? publicRun(results[1].results[0] as Run) : null,
    schedule: { enabled: Boolean(fresh?.sync_enabled), interval: fresh?.sync_interval ?? 86400, revision: fresh?.settings_revision ?? 0,
      past_days: fresh?.past_days ?? 90, future_days: fresh?.future_days ?? 180, next_at: fresh?.sync_enabled ? fresh.next_sync_at : null } };
}
export async function cancelEventDownload(db: DB, actor: ConnectionActor, id: string, runId: unknown) {
  if (!isSyncUuid(runId)) throw new ProviderConnectionError('Choose the current event download.');
  const run = await runFor(db, runId);
  if (!run || run.connection_id !== id || run.workspace_id !== actor.workspaceId || run.user_id !== actor.userId) throw new ProviderConnectionError('Event download not found.', 404);
  const c = await access(db, actor, id, run.calendar_id);
  if (run.dataset_epoch !== c.dataset_epoch || run.authorization_revision !== c.authorization_revision) throw new ProviderConnectionError('Calendar authorization changed.');
  if (run.status !== 'active') return publicRun(run);
  const guard = crypto.randomUUID();
  try { await db.batch([
    maintenanceGuard(db, guard, ownerCondition + " AND EXISTS (SELECT 1 FROM provider_event_runs WHERE id = ? AND status = 'active')", [...ownerValues(actor, c), run.id]),
    db.prepare("UPDATE provider_event_runs SET status = 'cancelled', issue = 'cancelled_by_user', revision = revision + 1, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?").bind(new Date().toISOString(), run.id),
    db.prepare('DELETE FROM provider_event_index WHERE connection_id = ? AND calendar_id = ? AND generation = ?').bind(id, run.calendar_id, run.generation),
    db.prepare('DELETE FROM provider_event_pages WHERE run_id = ?').bind(run.id), removeGuard(db, guard),
  ]); } catch (error) { const fresh = await runFor(db, run.id); if (fresh && fresh.status !== 'active') return publicRun(fresh); throw error; }
  return publicRun((await runFor(db, run.id))!);
}
