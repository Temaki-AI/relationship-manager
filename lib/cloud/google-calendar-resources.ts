import { calendarIdentifier, readCalendarFacts, type CalendarReview } from '@/packages/domain/src/calendars';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { fingerprintIdempotencyInput } from '@/lib/idempotency';
import { ProviderConnectionError } from './provider-vault';
import { googleConfiguration, type ProviderEnvironment, type ProviderFetch } from './google-provider';
import { googleConnectionAccess, providerWriteGuard, requireGoogleReconnection, requireProviderOwner, type ConnectionActor } from './provider-connections';
import { GoogleCalendarError, googleCalendarsPage } from './google-calendars';
import { maintenanceGuard, removeGuard } from './recovery-storage';
type DB = CloudflareEnv['DB'];
type Connection = { id: string; dataset_epoch: string; authorization_revision: number; refresh_expires_at: number | null };
type Resource = { active_generation: string | null; selected_ids: string; selection_revision: number; last_discovered_at: string | null };
type Run = { id: string; connection_id: string; workspace_id: string; user_id: string; dataset_epoch: string; authorization_revision: number; status: string;
  generation: string; base_generation: string | null; next_page: string | null; pages: number; processed: number; revision: number; lease_token: string | null;
  lease_until: number | null; failures: number; retry_at: number; issue: string | null };
const currentCondition = `EXISTS (SELECT 1 FROM provider_connections c JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id
  JOIN workspaces w ON w.id = c.workspace_id JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
  WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.purpose = 'calendar' AND c.status = 'connected'
    AND c.dataset_epoch = ? AND c.authorization_revision = ? AND s.epoch = c.dataset_epoch AND s.paused = 0 AND w.lifecycle = 'active' AND m.role = 'owner')`;
const currentValues = (actor: ConnectionActor, connection: Connection) => [connection.id, actor.workspaceId, actor.userId, connection.dataset_epoch, connection.authorization_revision];
function publicRun(run: Run) { return { id: run.id, status: run.status, processed: run.processed, pages: run.pages, issue: run.issue, retry_at: run.retry_at }; }
async function connection(db: DB, actor: ConnectionActor, id: string) {
  await requireProviderOwner(db, actor);
  if (!isSyncUuid(id)) throw new ProviderConnectionError('Calendar connection not found.', 404);
  const row = await db.prepare(`SELECT c.id, c.dataset_epoch, c.authorization_revision, c.refresh_expires_at FROM provider_connections c
    JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.purpose = 'calendar' AND c.status = 'connected'
      AND c.dataset_epoch = s.epoch AND s.paused = 0 AND w.lifecycle = 'active'`).bind(id, actor.workspaceId, actor.userId).first<Connection>();
  if (!row || row.refresh_expires_at !== null && row.refresh_expires_at <= Date.now()) throw new ProviderConnectionError('Reconnect Google Calendar before reviewing this account.');
  return row;
}
async function resource(db: DB, id: string) { return db.prepare('SELECT * FROM provider_calendar_resources WHERE connection_id = ?').bind(id).first<Resource>(); }
async function runFor(db: DB, id: string) { return db.prepare('SELECT * FROM provider_calendar_runs WHERE id = ?').bind(id).first<Run>(); }
export async function startCalendarDiscovery(db: DB, actor: ConnectionActor, environment: ProviderEnvironment, id: string, body: Record<string, unknown>) {
  googleConfiguration(environment, 'calendar'); const c = await connection(db, actor, id);
  if (Object.keys(body).length !== 3 || !isSyncUuid(body.operation_id) || body.expected_epoch !== c.dataset_epoch || body.expected_authorization_revision !== c.authorization_revision) throw new ProviderConnectionError('Refresh Calendar access before discovering calendars.');
  const previous = await runFor(db, body.operation_id);
  if (previous) {
    if (previous.connection_id !== id || previous.workspace_id !== actor.workspaceId || previous.user_id !== actor.userId || previous.dataset_epoch !== c.dataset_epoch || previous.authorization_revision !== c.authorization_revision) throw new ProviderConnectionError('This discovery request belongs to another account or authorization.');
    return publicRun(previous);
  }
  const r = await resource(db, id), guard = crypto.randomUUID(), generation = crypto.randomUUID(), now = new Date().toISOString();
  await db.batch([
    maintenanceGuard(db, guard, currentCondition + " AND NOT EXISTS (SELECT 1 FROM provider_calendar_runs WHERE connection_id = ? AND status = 'active')"
      + (r ? ' AND EXISTS (SELECT 1 FROM provider_calendar_resources WHERE connection_id = ? AND active_generation IS ?)' : ' AND NOT EXISTS (SELECT 1 FROM provider_calendar_resources WHERE connection_id = ?)'),
      [...currentValues(actor, c), id, id, ...(r ? [r.active_generation] : [])]),
    db.prepare('DELETE FROM provider_calendar_catalog WHERE connection_id = ?').bind(id),
    db.prepare('INSERT INTO provider_calendar_resources (connection_id, workspace_id, dataset_epoch, authorization_revision) VALUES (?, ?, ?, ?) ON CONFLICT(connection_id) DO NOTHING')
      .bind(id, actor.workspaceId, c.dataset_epoch, c.authorization_revision),
    db.prepare(`INSERT INTO provider_calendar_runs (id, connection_id, workspace_id, user_id, dataset_epoch, authorization_revision, generation, base_generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(body.operation_id, id, actor.workspaceId, actor.userId, c.dataset_epoch, c.authorization_revision, generation, r?.active_generation ?? null, now, now),
    removeGuard(db, guard),
  ]);
  return publicRun((await runFor(db, body.operation_id))!);
}
export async function advanceCalendarDiscovery(db: DB, actor: ConnectionActor, environment: ProviderEnvironment, id: string, runId: unknown, fetcher: ProviderFetch = fetch) {
  const c = await connection(db, actor, id);
  if (!isSyncUuid(runId)) throw new ProviderConnectionError('Choose the current calendar discovery.');
  const run = await runFor(db, runId);
  if (!run || run.connection_id !== id || run.workspace_id !== actor.workspaceId || run.user_id !== actor.userId || run.dataset_epoch !== c.dataset_epoch || run.authorization_revision !== c.authorization_revision) throw new ProviderConnectionError('Calendar discovery changed. Refresh this account.');
  if (run.status !== 'active' || run.retry_at > Date.now()) return publicRun(run);
  const lease = crypto.randomUUID(), nowMs = Date.now();
  const claimed = await db.prepare(`UPDATE provider_calendar_runs SET lease_token = ?, lease_until = ? WHERE id = ? AND revision = ? AND status = 'active'
    AND (lease_token IS NULL OR lease_until < ?) AND ${currentCondition} RETURNING id`).bind(lease, nowMs + 45_000, runId, run.revision, nowMs, ...currentValues(actor, c)).first();
  if (!claimed) throw new ProviderConnectionError('Calendar discovery is already running or changed. Try again shortly.', 503);
  try {
    const grant = await googleConnectionAccess(db, actor, environment, id, run.dataset_epoch, fetcher, 'calendar');
    let page;
    try { page = await googleCalendarsPage(grant.accessToken, run.next_page, fetcher); }
    catch (error) { if (error instanceof GoogleCalendarError && error.reason === 'permission') await requireGoogleReconnection(db, grant); throw error; }
    if (run.pages >= 20 || page.next && (page.next === run.next_page || run.pages + 1 >= 20) || run.processed + page.calendars.length > 500) throw new GoogleCalendarError('invalid');
    const guard = crypto.randomUUID(), now = new Date().toISOString(), done = page.next === null;
    await db.batch([
      providerWriteGuard(db, grant, guard),
      maintenanceGuard(db, guard + '-run', `EXISTS (SELECT 1 FROM provider_calendar_runs WHERE id = ? AND revision = ? AND lease_token = ? AND lease_until >= ? AND status = 'active')
        AND EXISTS (SELECT 1 FROM provider_calendar_resources WHERE connection_id = ? AND active_generation IS ?)`, [run.id, run.revision, lease, Date.now(), id, run.base_generation]),
      ...page.calendars.map((calendar) => db.prepare('INSERT INTO provider_calendar_catalog (connection_id, generation, calendar_id, facts) VALUES (?, ?, ?, ?)').bind(id, run.generation, calendar.id, JSON.stringify(calendar))),
      ...(done ? [
        db.prepare(`DELETE FROM provider_calendars WHERE connection_id = ? AND calendar_id NOT IN (SELECT value FROM json_each((SELECT selected_ids FROM provider_calendar_resources WHERE connection_id = ?)))`).bind(id, id),
        db.prepare("UPDATE provider_calendars SET availability = 'unavailable' WHERE connection_id = ?").bind(id),
        db.prepare(`INSERT INTO provider_calendars (connection_id, calendar_id, facts, availability, observed_at)
          SELECT connection_id, calendar_id, facts, 'available', ? FROM provider_calendar_catalog WHERE connection_id = ? AND generation = ?
          ON CONFLICT(connection_id, calendar_id) DO UPDATE SET facts = excluded.facts, availability = 'available', observed_at = excluded.observed_at`).bind(now, id, run.generation),
        db.prepare('UPDATE provider_calendar_resources SET active_generation = ?, selection_revision = selection_revision + 1, last_discovered_at = ? WHERE connection_id = ?').bind(run.generation, now, id),
        db.prepare('DELETE FROM provider_calendar_catalog WHERE connection_id = ?').bind(id),
      ] : []),
      db.prepare(`UPDATE provider_calendar_runs SET next_page = ?, pages = pages + 1, processed = processed + ?, status = ?, revision = revision + 1,
        failures = 0, retry_at = 0, issue = NULL, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`).bind(page.next, page.calendars.length, done ? 'complete' : 'active', now, run.id),
      removeGuard(db, guard), removeGuard(db, guard + '-run'),
    ]);
    return publicRun((await runFor(db, run.id))!);
  } catch (error) {
    if (error instanceof GoogleCalendarError && error.reason !== 'permission' || String(error).includes('provider_calendar_catalog') || String(error).includes('PROVIDER_CALENDAR_INVALID')) {
      const retry = error instanceof GoogleCalendarError && error.reason === 'retry' && run.failures < 8;
      await db.prepare(`UPDATE provider_calendar_runs SET status = ?, failures = failures + 1, retry_at = ?, issue = ?, revision = revision + 1,
        lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND revision = ? AND lease_token = ? AND status = 'active'`)
        .bind(retry ? 'active' : 'failed', retry ? Date.now() + Math.max(2, error instanceof GoogleCalendarError ? error.retryAfter : 30) * 1000 : 0, retry ? 'provider_retry' : 'unsupported_catalog', new Date().toISOString(), run.id, run.revision, lease).run();
      return publicRun((await runFor(db, run.id))!);
    }
    throw error;
  } finally { await db.prepare('UPDATE provider_calendar_runs SET lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ?').bind(run.id, lease).run(); }
}
export async function reviewCalendars(db: DB, actor: ConnectionActor, id: string, query = new URLSearchParams()): Promise<CalendarReview> {
  const c = await connection(db, actor, id), r = await resource(db, id), after = query.get('after'), search = query.get('search') ?? '';
  if (search.length > 200 || /[\u0000-\u001f\u007f]/u.test(search)) throw new ProviderConnectionError('Use a shorter calendar search.');
  if (after) { calendarIdentifier(after); if (query.get('generation') !== r?.active_generation) throw new ProviderConnectionError('The calendar list changed. Start again from the first page.'); }
  const selected = JSON.parse(r?.selected_ids ?? '[]') as string[];
  const results = await db.batch([
    db.prepare(`SELECT * FROM provider_calendars WHERE connection_id = ? AND (? IS NULL OR calendar_id > ?) AND instr(lower(json_extract(facts, '$.summary')), lower(?)) > 0 ORDER BY calendar_id LIMIT 51`).bind(id, after, after, search),
    db.prepare('SELECT * FROM provider_calendar_runs WHERE connection_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').bind(id),
    db.prepare('SELECT * FROM provider_calendar_resources WHERE connection_id = ?').bind(id),
    db.prepare(`SELECT * FROM provider_calendars WHERE connection_id = ? AND calendar_id IN (SELECT value FROM json_each(?)) ORDER BY calendar_id`).bind(id, JSON.stringify(selected)),
  ]);
  const fresh = results[2].results[0] as Resource | undefined;
  if ((fresh?.active_generation ?? null) !== (r?.active_generation ?? null) || (fresh?.selection_revision ?? 0) !== (r?.selection_revision ?? 0)) throw new ProviderConnectionError('Calendar choices changed. Refresh while keeping your draft.');
  const rows = results[0].results as Array<{ calendar_id: string; facts: string; availability: 'available' | 'unavailable'; observed_at: string }>;
  const choice = (row: typeof rows[number]) => ({ facts: readCalendarFacts(JSON.parse(row.facts)), availability: row.availability, selected: selected.includes(row.calendar_id), observed_at: row.observed_at });
  return { epoch: c.dataset_epoch, authorization_revision: c.authorization_revision, generation: r?.active_generation ?? null, selection_revision: r?.selection_revision ?? 0,
    selected_ids: selected, calendars: rows.slice(0, 50).map(choice), selected_calendars: (results[3].results as typeof rows).map(choice), more: rows.length > 50, next: rows.length > 50 ? rows[49].calendar_id : null,
    run: results[1].results[0] ? publicRun(results[1].results[0] as Run) : null, last_discovered_at: r?.last_discovered_at ?? null };
}
export async function selectCalendars(db: DB, actor: ConnectionActor, id: string, body: Record<string, unknown>) {
  const c = await connection(db, actor, id);
  if (Object.keys(body).length !== 6 || !isSyncUuid(body.operation_id) || !isSyncUuid(body.expected_generation) || body.expected_epoch !== c.dataset_epoch
    || body.expected_authorization_revision !== c.authorization_revision || !Number.isSafeInteger(body.expected_selection_revision) || Number(body.expected_selection_revision) < 1
    || !Array.isArray(body.selected_ids) || body.selected_ids.length > 20) throw new ProviderConnectionError('Refresh the calendar list and review your choices.');
  let ids: string[]; try { ids = body.selected_ids.map(calendarIdentifier); } catch { throw new ProviderConnectionError('Choose valid calendars.'); }
  if (new Set(ids).size !== ids.length) throw new ProviderConnectionError('Choose each calendar once.');
  const fingerprint = fingerprintIdempotencyInput(body), r = await resource(db, id);
  const receipt = async () => {
    const stored = await db.prepare('SELECT * FROM provider_calendar_selection_receipts WHERE connection_id = ? AND operation_id = ?').bind(id, body.operation_id).first<{ fingerprint: string; result_revision: number; dataset_epoch: string; authorization_revision: number }>();
    if (!stored) return null;
    if (stored.fingerprint !== fingerprint || stored.dataset_epoch !== c.dataset_epoch || stored.authorization_revision !== c.authorization_revision) throw new ProviderConnectionError('This request key belongs to different calendar choices.');
    return stored;
  };
  const previous = await receipt(); if (previous) return { replayed: true, applied_revision: previous.result_revision };
  if (!r || r.active_generation !== body.expected_generation || r.selection_revision !== body.expected_selection_revision) throw new ProviderConnectionError('The calendar list or choices changed. Refresh while keeping your draft.');
  const available = (await db.prepare("SELECT calendar_id FROM provider_calendars WHERE connection_id = ? AND availability = 'available' AND json_extract(facts, '$.access_role') != 'freeBusyReader'").bind(id).all<{ calendar_id: string }>()).results.map((row: { calendar_id: string }) => row.calendar_id);
  const existing = JSON.parse(r.selected_ids) as string[];
  if (ids.some((value) => !available.includes(value) && !existing.includes(value))) throw new ProviderConnectionError('Choose an available calendar with event read access. Previously selected missing calendars can be retained or removed.');
  const guard = crypto.randomUUID();
  try {
    await db.batch([
      maintenanceGuard(db, guard, currentCondition + ' AND EXISTS (SELECT 1 FROM provider_calendar_resources WHERE connection_id = ? AND active_generation = ? AND selection_revision = ? AND selected_ids IS ?)', [...currentValues(actor, c), id, r.active_generation, r.selection_revision, r.selected_ids]),
      db.prepare('INSERT INTO provider_calendar_selection_receipts (connection_id, operation_id, fingerprint, result_revision, dataset_epoch, authorization_revision) VALUES (?, ?, ?, ?, ?, ?)').bind(id, body.operation_id, fingerprint, r.selection_revision + 1, c.dataset_epoch, c.authorization_revision),
      db.prepare('UPDATE provider_calendar_resources SET selected_ids = ?, selection_revision = selection_revision + 1 WHERE connection_id = ?').bind(JSON.stringify([...ids].sort()), id),
      removeGuard(db, guard),
    ]);
    return { replayed: false, applied_revision: r.selection_revision + 1 };
  } catch (error) { const saved = await receipt(); if (saved) return { replayed: true, applied_revision: saved.result_revision }; throw error; }
}
