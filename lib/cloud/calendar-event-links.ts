import { getCloudflareContext } from '@opennextjs/cloudflare';
import { readCalendarEventFacts, type SavedCalendarEvent } from '@/packages/domain/src/calendar-events';
import { calendarIdentifier } from '@/packages/domain/src/calendars';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { fingerprintIdempotencyInput } from '@/lib/idempotency';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { calendarEventAccess } from './google-event-downloads';
import { requireProviderOwner, type ConnectionActor } from './provider-connections';
import { ProviderConnectionError } from './provider-vault';
import { createCloudBackup, recoveryGuard, releaseBackupPin, pruneCloudBackups, maintenanceGuard, removeGuard } from './recovery-storage';
import { recoveryErrorResponse } from './recovery-contract';
import { calendarSourceStatusSql } from './calendar-event-projection';
type DB = CloudflareEnv['DB'];
type Row = { id: number; public_id: string; workspace_id: string; provider: string; account_key: string; account_email: string; calendar_key: string; calendar_label: string; calendar_time_zone: string;
  external_id: string; facts: string; revision: number; availability: 'available' | 'unavailable'; observed_at: string };
const OWNER = `EXISTS (SELECT 1 FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id JOIN workspace_members m ON m.workspace_id = w.id WHERE s.workspace_id = ? AND s.epoch = ? AND s.paused = 0 AND w.lifecycle = 'active' AND m.user_id = ? AND m.role = 'owner')`;
async function state(db: DB, actor: ConnectionActor) {
  await requireProviderOwner(db, actor);
  const row = await db.prepare("SELECT s.epoch FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id WHERE s.workspace_id = ? AND s.paused = 0 AND w.lifecycle = 'active'").bind(actor.workspaceId).first<{ epoch: string }>();
  if (!row) throw new ProviderConnectionError('Event context is paused for recovery.'); return row;
}
const rowFor = (db: DB, workspaceId: string, publicId: string) => db.prepare('SELECT * FROM calendar_events WHERE workspace_id = ? AND public_id = ?').bind(workspaceId, publicId).first<Row>();
function ids(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 20 || value.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(value).size !== value.length) throw new ProviderConnectionError('Choose at most 20 distinct people and 20 distinct plans.', 400); return value;
}
async function source(db: DB, actor: ConnectionActor, id: string, query: URLSearchParams) {
  const c = await calendarEventAccess(db, actor, id, query.get('calendar_id'));
  const externalId = query.get('event_id'); try { calendarIdentifier(externalId); } catch { throw new ProviderConnectionError('Choose a downloaded event.', 400); }
  const item = await db.prepare(`SELECT i.facts, r.active_generation, r.last_downloaded_at FROM provider_event_resources r JOIN provider_event_index i ON i.connection_id = r.connection_id AND i.calendar_id = r.calendar_id AND i.generation = r.active_generation
    WHERE r.connection_id = ? AND r.calendar_id = ? AND i.event_id = ? AND r.availability = 'available'`).bind(id, c.calendar_id, externalId).first<{ facts: string; active_generation: string; last_downloaded_at: string }>();
  if (!item || c.availability !== 'available' || c.calendar.access_role === 'freeBusyReader') throw new ProviderConnectionError('Download the current event and restore calendar access before saving its context.');
  const facts = readCalendarEventFacts(JSON.parse(item.facts));
  const existing = await db.prepare("SELECT * FROM calendar_events WHERE workspace_id = ? AND provider = 'google-calendar' AND account_key = ? AND calendar_key = ? AND external_id = ?").bind(actor.workspaceId, c.account_id, c.calendar_id, externalId).first<Row>();
  return { connection: c, item, facts, existing };
}
async function project(db: DB, actor: ConnectionActor, row: Row): Promise<SavedCalendarEvent> {
  const data = await db.batch([
    db.prepare('SELECT c.id, c.name FROM calendar_event_people link JOIN contacts c ON c.id = link.contact_id AND c.workspace_id = link.workspace_id WHERE link.workspace_id = ? AND link.event_id = ? ORDER BY c.name, c.id').bind(actor.workspaceId, row.id),
    db.prepare("SELECT p.id, COALESCE(NULLIF(p.summary, ''), 'Plan') AS summary, p.contact_id, c.name AS contact_name, p.planned_date FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id JOIN contacts c ON c.id = p.contact_id AND c.workspace_id = p.workspace_id WHERE link.workspace_id = ? AND link.event_id = ? ORDER BY p.planned_date, p.id").bind(actor.workspaceId, row.id),
    db.prepare(`SELECT ${calendarSourceStatusSql()} AS source_status FROM calendar_events e WHERE e.workspace_id = ? AND e.id = ?`).bind(actor.workspaceId, row.id),
  ]);
  const status = data[2].results[0] as { source_status: SavedCalendarEvent['source_status'] };
  return { public_id: row.public_id, revision: row.revision, calendar_label: row.calendar_label, calendar_time_zone: row.calendar_time_zone, account_email: row.account_email,
    observed_at: row.observed_at, source_status: status.source_status,
    facts: readCalendarEventFacts(JSON.parse(row.facts)), people: data[0].results as SavedCalendarEvent['people'], plans: data[1].results as SavedCalendarEvent['plans'] };
}
async function directory(db: DB, actor: ConnectionActor, query: URLSearchParams) {
  const search = query.get('search') ?? '';
  if (search.length > 200 || /[\u0000-\u001f\u007f]/u.test(search)) throw new ProviderConnectionError('Use a shorter person or plan search.', 400);
  const after = (key: string) => { const raw = query.get(key); if (raw === null) return 0; if (!/^[1-9]\d{0,14}$/u.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ProviderConnectionError('Start this directory from the first page.', 400); return Number(raw); };
  const results = await db.batch([
    db.prepare(`SELECT c.id, c.name, c.email FROM contacts c WHERE c.workspace_id = ? AND c.id > ? AND (instr(lower(c.name), lower(?)) > 0 OR instr(lower(COALESCE(c.email, '')), lower(?)) > 0) ORDER BY c.id LIMIT 51`).bind(actor.workspaceId, after('contacts_after'), search, search),
    db.prepare(`SELECT p.id, COALESCE(NULLIF(p.summary, ''), 'Plan') AS summary, p.contact_id, c.name AS contact_name, p.planned_date FROM plans p JOIN contacts c ON c.id = p.contact_id AND c.workspace_id = p.workspace_id WHERE p.workspace_id = ? AND p.id > ? AND (instr(lower(COALESCE(p.summary, '')), lower(?)) > 0 OR instr(lower(c.name), lower(?)) > 0 OR instr(p.planned_date, ?) > 0) ORDER BY p.id LIMIT 51`).bind(actor.workspaceId, after('plans_after'), search, search, search),
  ]);
  const contacts = results[0].results as Array<{ id: number; name: string; email: string | null }>, plans = results[1].results as SavedCalendarEvent['plans'];
  return { contacts: contacts.slice(0, 50), plans: plans.slice(0, 50), contacts_more: contacts.length > 50, contacts_next: contacts.length > 50 ? contacts[49].id : null, plans_more: plans.length > 50, plans_next: plans.length > 50 ? plans[49].id : null };
}
export async function eventLinkPreview(db: DB, actor: ConnectionActor, connectionId: string, query: URLSearchParams) {
  const s = await source(db, actor, connectionId, query);
  const emails = [...new Set(s.facts.attendees.filter((p) => !p.self && !p.resource && p.email).map((p) => p.email!.trim().toLowerCase()))];
  const own = (await db.prepare("SELECT lower(email) AS email FROM provider_connections WHERE workspace_id = ? AND user_id = ? UNION SELECT lower(email) FROM user WHERE id = ? AND email_verified = 1").bind(actor.workspaceId, actor.userId, actor.userId).all<{ email: string }>()).results as Array<{ email: string }>;
  const wanted = emails.filter((email) => !own.some((p) => p.email === email));
  const choices = await directory(db, actor, query);
  const matched = await db.prepare(`WITH matched AS (SELECT address.value AS address, c.id, c.name, c.email, ROW_NUMBER() OVER (PARTITION BY address.value ORDER BY c.id) AS rank
      FROM json_each(?) address JOIN contacts c ON c.workspace_id = ? AND (lower(trim(c.email)) = address.value OR EXISTS (SELECT 1 FROM json_each(c.contact_methods) method WHERE json_extract(method.value, '$.kind') = 'email' AND lower(trim(json_extract(method.value, '$.value'))) = address.value))) SELECT * FROM matched WHERE rank <= 6 ORDER BY address, rank`).bind(JSON.stringify(wanted), actor.workspaceId).all();
  // Match decisions are suggestions, including ambiguous shared addresses. Nothing is checked by default.
  const matches = wanted.map((address) => { const rows = (matched.results as Array<{ address: string; id: number; name: string; email: string | null }>).filter((r) => r.address === address); return { address, candidates: rows.slice(0, 5).map(({ id, name, email }) => ({ id, name, email })), more: rows.length > 5 }; });
  return { epoch: s.connection.dataset_epoch, authorization_revision: s.connection.authorization_revision, selection_revision: s.connection.selection_revision, generation: s.item.active_generation,
    calendar_label: s.connection.calendar.summary, calendar_time_zone: s.connection.calendar.time_zone, account_email: s.connection.email, observed_at: s.item.last_downloaded_at,
    facts: s.facts, saved: s.existing ? await project(db, actor, s.existing) : null, matches, ...choices };
}
async function receipt(db: DB, actor: ConnectionActor, scope: string, key: string, fingerprint: string) {
  const r = await db.prepare('SELECT fingerprint, resource_id FROM mutation_receipts WHERE workspace_id = ? AND scope = ? AND request_key = ?').bind(actor.workspaceId, scope, key).first<{ fingerprint: string; resource_id: number | null }>();
  if (!r) return null; if (r.fingerprint !== fingerprint) throw new ProviderConnectionError('This request identity belongs to different event choices.');
  const row = r.resource_id === null ? null : await db.prepare('SELECT * FROM calendar_events WHERE workspace_id = ? AND id = ?').bind(actor.workspaceId, r.resource_id).first<Row>();
  return { replayed: true, event: row ? await project(db, actor, row) : null, removed: !row };
}
function associations(db: DB, workspaceId: string, eventPublicId: string, contactIds: number[], planIds: number[], now: string) {
  return [
    db.prepare('DELETE FROM calendar_event_people WHERE workspace_id = ? AND event_id = (SELECT id FROM calendar_events WHERE workspace_id = ? AND public_id = ?)').bind(workspaceId, workspaceId, eventPublicId),
    db.prepare('DELETE FROM calendar_event_plans WHERE workspace_id = ? AND event_id = (SELECT id FROM calendar_events WHERE workspace_id = ? AND public_id = ?)').bind(workspaceId, workspaceId, eventPublicId),
    ...contactIds.map((id) => db.prepare('INSERT INTO calendar_event_people (workspace_id, event_id, contact_id, created_at) SELECT ?, id, ?, ? FROM calendar_events WHERE workspace_id = ? AND public_id = ?').bind(workspaceId, id, now, workspaceId, eventPublicId)),
    ...planIds.map((id) => db.prepare('INSERT INTO calendar_event_plans (workspace_id, event_id, plan_id, created_at) SELECT ?, id, ?, ? FROM calendar_events WHERE workspace_id = ? AND public_id = ?').bind(workspaceId, id, now, workspaceId, eventPublicId)),
  ];
}
export { associations as calendarLinkStatements };
const targets = ` (SELECT COUNT(*) FROM contacts WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))) = ? AND (SELECT COUNT(*) FROM plans WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))) = ? AND NOT EXISTS (SELECT 1 FROM calendar_event_plans WHERE workspace_id = ? AND plan_id IN (SELECT value FROM json_each(?)) AND event_id IS NOT ?)`;
const targetValues = (workspace: string, contactIds: number[], planIds: number[], eventId: number | null) => [workspace, JSON.stringify(contactIds), contactIds.length, workspace, JSON.stringify(planIds), planIds.length, workspace, JSON.stringify(planIds), eventId];
export async function linkCalendarEvent(db: DB, actor: ConnectionActor, connectionId: string, body: Record<string, unknown>) {
  const current = await state(db, actor);
  if (Object.keys(body).length !== 10 || !isSyncUuid(body.operation_id) || body.expected_epoch !== current.epoch || body.expected_event_revision !== null && (!Number.isSafeInteger(body.expected_event_revision) || Number(body.expected_event_revision) < 1)) throw new ProviderConnectionError('Refresh the event and its saved links before saving.');
  const contactIds = ids(body.contact_ids), planIds = ids(body.plan_ids), fingerprint = fingerprintIdempotencyInput({ actor: actor.userId, connectionId, body }), scope = 'calendar-event-link';
  const replay = await receipt(db, actor, scope, body.operation_id, fingerprint); if (replay) return replay;
  const s = await source(db, actor, connectionId, new URLSearchParams({ calendar_id: String(body.calendar_id), event_id: String(body.event_id) }));
  if (body.expected_authorization_revision !== s.connection.authorization_revision || body.expected_selection_revision !== s.connection.selection_revision || body.expected_generation !== s.item.active_generation || body.expected_event_revision !== (s.existing?.revision ?? null)) throw new ProviderConnectionError('Event context changed. Refresh while keeping your choices.');
  const publicId = s.existing?.public_id ?? body.operation_id, owner = crypto.randomUUID(), now = new Date().toISOString();
  try { await db.batch([
    maintenanceGuard(db, owner, OWNER + ` AND EXISTS (SELECT 1 FROM provider_connections c JOIN provider_calendar_resources r ON r.connection_id = c.id JOIN provider_calendars k ON k.connection_id = c.id AND k.calendar_id = ? JOIN provider_event_resources e ON e.connection_id = c.id AND e.calendar_id = k.calendar_id JOIN provider_event_index i ON i.connection_id = e.connection_id AND i.calendar_id = e.calendar_id AND i.generation = e.active_generation AND i.event_id = ?
      WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.purpose = 'calendar' AND c.status = 'connected' AND c.dataset_epoch = ? AND c.authorization_revision = ? AND r.selection_revision = ? AND e.active_generation = ? AND e.availability = 'available' AND k.availability = 'available' AND json_extract(k.facts, '$.access_role') != 'freeBusyReader' AND (c.refresh_expires_at IS NULL OR c.refresh_expires_at > ?) AND i.facts = ? AND EXISTS (SELECT 1 FROM json_each(r.selected_ids) WHERE value = k.calendar_id))
      AND ${s.existing ? 'EXISTS (SELECT 1 FROM calendar_events WHERE id = ? AND workspace_id = ? AND revision = ?)' : "NOT EXISTS (SELECT 1 FROM calendar_events WHERE workspace_id = ? AND provider = 'google-calendar' AND account_key = ? AND calendar_key = ? AND external_id = ?)"} AND ${targets}`,
      [actor.workspaceId, current.epoch, actor.userId, s.connection.calendar_id, s.facts.id, connectionId, actor.workspaceId, actor.userId, current.epoch, s.connection.authorization_revision, s.connection.selection_revision, s.item.active_generation, Date.now(), s.item.facts,
        ...(s.existing ? [s.existing.id, actor.workspaceId, s.existing.revision] : [actor.workspaceId, s.connection.account_id, s.connection.calendar_id, s.facts.id]), ...targetValues(actor.workspaceId, contactIds, planIds, s.existing?.id ?? null)]),
    db.prepare('INSERT INTO mutation_receipts (workspace_id, scope, request_key, fingerprint, owner_token) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(actor.workspaceId, scope, body.operation_id, fingerprint, owner),
    maintenanceGuard(db, owner + '-receipt', 'EXISTS (SELECT 1 FROM mutation_receipts WHERE workspace_id = ? AND scope = ? AND request_key = ? AND owner_token = ?)', [actor.workspaceId, scope, body.operation_id, owner]),
    db.prepare(`INSERT INTO calendar_events (public_id, workspace_id, provider, account_key, account_email, calendar_key, calendar_label, calendar_time_zone, external_id, facts, availability, observed_at, created_at, updated_at)
      VALUES (?, ?, 'google-calendar', ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?) ON CONFLICT(workspace_id, provider, account_key, calendar_key, external_id) DO UPDATE SET facts = excluded.facts, calendar_label = excluded.calendar_label, calendar_time_zone = excluded.calendar_time_zone, account_email = excluded.account_email, availability = 'available', observed_at = excluded.observed_at, updated_at = excluded.updated_at, revision = calendar_events.revision + 1`)
      .bind(publicId, actor.workspaceId, s.connection.account_id, s.connection.email, s.connection.calendar_id, s.connection.calendar.summary, s.connection.calendar.time_zone, s.facts.id, s.item.facts, s.item.last_downloaded_at, now, now),
    ...associations(db, actor.workspaceId, publicId, contactIds, planIds, now),
    db.prepare('UPDATE mutation_receipts SET resource_id = (SELECT id FROM calendar_events WHERE workspace_id = ? AND public_id = ?) WHERE workspace_id = ? AND scope = ? AND request_key = ? AND owner_token = ?').bind(actor.workspaceId, publicId, actor.workspaceId, scope, body.operation_id, owner),
    removeGuard(db, owner), removeGuard(db, owner + '-receipt'),
  ]); } catch (error) { const raced = await receipt(db, actor, scope, body.operation_id, fingerprint); if (raced) return raced; throw error; }
  return { replayed: false, event: await project(db, actor, (await rowFor(db, actor.workspaceId, publicId))!), removed: false };
}
export async function savedCalendarEvents(db: DB, actor: ConnectionActor, query: URLSearchParams, publicId?: string) {
  const s = await state(db, actor);
  if (publicId) { if (!isSyncUuid(publicId)) throw new ProviderConnectionError('Saved event not found.', 404); const row = await rowFor(db, actor.workspaceId, publicId); if (!row) throw new ProviderConnectionError('Saved event not found.', 404); return { epoch: s.epoch, event: await project(db, actor, row), ...await directory(db, actor, query) }; }
  const after = query.get('after'); if (after !== null && (!/^[1-9]\d{0,14}$/u.test(after) || !Number.isSafeInteger(Number(after)))) throw new ProviderConnectionError('Start from the first saved event page.', 400);
  const limitValue = query.get('limit'); if (limitValue !== null && (!/^[1-9]\d?$/u.test(limitValue) || Number(limitValue) > 50)) throw new ProviderConnectionError('Saved event pages must contain 1 to 50 events.', 400);
  const limit = limitValue === null ? 50 : Number(limitValue);
  const contact = query.get('contact_id'); if (contact !== null && (!/^[1-9]\d{0,14}$/u.test(contact) || !Number.isSafeInteger(Number(contact)))) throw new ProviderConnectionError('Choose an existing person.', 400);
  const rows = (await db.prepare(`SELECT e.* FROM calendar_events e WHERE e.workspace_id = ? AND (? IS NULL OR e.id < ?) AND (? IS NULL OR EXISTS (SELECT 1 FROM calendar_event_people link WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id AND link.contact_id = ?) OR EXISTS (SELECT 1 FROM calendar_event_plans link JOIN plans p ON p.id = link.plan_id AND p.workspace_id = link.workspace_id WHERE link.workspace_id = e.workspace_id AND link.event_id = e.id AND p.contact_id = ?)) ORDER BY e.id DESC LIMIT ?`)
    .bind(actor.workspaceId, after, after === null ? 0 : Number(after), contact, contact === null ? 0 : Number(contact), contact === null ? 0 : Number(contact), limit + 1).all<Row>()).results;
  const events: SavedCalendarEvent[] = []; for (const row of rows.slice(0, limit)) events.push(await project(db, actor, row));
  return { epoch: s.epoch, events, more: rows.length > limit, next: rows.length > limit ? rows[limit - 1].id : null };
}
export async function editSavedCalendarEvent(db: DB, actor: ConnectionActor, publicId: string, body: Record<string, unknown>) {
  const current = await state(db, actor);
  if (!isSyncUuid(publicId) || Object.keys(body).length !== 5 || !isSyncUuid(body.operation_id) || body.expected_epoch !== current.epoch || !Number.isSafeInteger(body.expected_revision)) throw new ProviderConnectionError('Refresh saved event context before changing links.');
  const contactIds = ids(body.contact_ids), planIds = ids(body.plan_ids), scope = 'calendar-event-edit', fingerprint = fingerprintIdempotencyInput({ actor: actor.userId, publicId, body });
  const replay = await receipt(db, actor, scope, body.operation_id, fingerprint); if (replay) return replay;
  const row = await rowFor(db, actor.workspaceId, publicId); if (!row || row.revision !== body.expected_revision) throw new ProviderConnectionError('Saved event links changed. Refresh while keeping your choices.');
  const owner = crypto.randomUUID(), now = new Date().toISOString();
  try { await db.batch([
    maintenanceGuard(db, owner, OWNER + ' AND EXISTS (SELECT 1 FROM calendar_events WHERE id = ? AND workspace_id = ? AND revision = ?) AND ' + targets, [actor.workspaceId, current.epoch, actor.userId, row.id, actor.workspaceId, row.revision, ...targetValues(actor.workspaceId, contactIds, planIds, row.id)]),
    db.prepare('INSERT INTO mutation_receipts (workspace_id, scope, request_key, fingerprint, owner_token, resource_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(actor.workspaceId, scope, body.operation_id, fingerprint, owner, row.id),
    maintenanceGuard(db, owner + '-receipt', 'EXISTS (SELECT 1 FROM mutation_receipts WHERE workspace_id = ? AND scope = ? AND request_key = ? AND owner_token = ?)', [actor.workspaceId, scope, body.operation_id, owner]),
    ...associations(db, actor.workspaceId, publicId, contactIds, planIds, now),
    db.prepare('UPDATE calendar_events SET revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND id = ?').bind(now, actor.workspaceId, row.id), removeGuard(db, owner), removeGuard(db, owner + '-receipt'),
  ]); } catch (error) { const raced = await receipt(db, actor, scope, body.operation_id, fingerprint); if (raced) return raced; throw error; }
  return { replayed: false, event: await project(db, actor, (await rowFor(db, actor.workspaceId, publicId))!), removed: false };
}
export async function removeSavedCalendarEvent(db: DB, actor: ConnectionActor, publicId: string, body: Record<string, unknown>) {
  const current = await state(db, actor);
  if (!isSyncUuid(publicId) || Object.keys(body).length !== 3 || !isSyncUuid(body.operation_id) || body.expected_epoch !== current.epoch || !Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 1) throw new ProviderConnectionError('Refresh saved event context before removing it.');
  const scope = 'calendar-event-remove', fingerprint = fingerprintIdempotencyInput({ actor: actor.userId, publicId, body });
  const replay = await receipt(db, actor, scope, body.operation_id, fingerprint); if (replay) return replay;
  const row = await rowFor(db, actor.workspaceId, publicId); if (!row || row.revision !== body.expected_revision) throw new ProviderConnectionError('Saved event context changed. Refresh before removing it.');
  const recovery = await createCloudBackup(actor.workspaceId, 'pre-delete'), owner = crypto.randomUUID();
  try {
    try { await db.batch([
      recoveryGuard(db, actor.workspaceId, recovery),
      maintenanceGuard(db, owner, OWNER + ' AND EXISTS (SELECT 1 FROM calendar_events WHERE id = ? AND workspace_id = ? AND revision = ?)', [actor.workspaceId, current.epoch, actor.userId, row.id, actor.workspaceId, row.revision]),
      db.prepare('INSERT INTO mutation_receipts (workspace_id, scope, request_key, fingerprint, owner_token, resource_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(actor.workspaceId, scope, body.operation_id, fingerprint, owner, row.id),
      maintenanceGuard(db, owner + '-receipt', 'EXISTS (SELECT 1 FROM mutation_receipts WHERE workspace_id = ? AND scope = ? AND request_key = ? AND owner_token = ?)', [actor.workspaceId, scope, body.operation_id, owner]),
      db.prepare('DELETE FROM calendar_events WHERE workspace_id = ? AND id = ?').bind(actor.workspaceId, row.id),
      removeGuard(db, owner), removeGuard(db, owner + '-receipt'), removeGuard(db, recovery.token),
    ]); } catch (error) { const raced = await receipt(db, actor, scope, body.operation_id, fingerprint); if (raced) return raced; throw error; }
    try { await pruneCloudBackups(actor.workspaceId); } catch { console.error('cloud.backup.retention_pending'); }
    return { replayed: false, event: null, removed: true, recoveryPoint: { ...recovery.backup, protected: false } };
  } finally { await releaseBackupPin(actor.workspaceId, recovery.token, db); }
}
export async function handleSavedCalendarEvents(request: Request, actor: ConnectionActor, path: string[]) {
  try {
    const { env } = getCloudflareContext();
    if (path[0] !== 'calendar' || path[1] !== 'events' || ![2, 3].includes(path.length) || path.length === 3 && !isSyncUuid(path[2])) throw new ProviderConnectionError('Saved event route not found.', 404);
    if (request.method === 'GET') return Response.json(await savedCalendarEvents(env.DB, actor, new URL(request.url).searchParams, path[2]), { headers: { 'Cache-Control': 'no-store' } });
    if (['PATCH', 'DELETE'].includes(request.method) && path.length === 3) {
      if (request.headers.get('origin') !== new URL(env.BETTER_AUTH_URL || process.env.BETTER_AUTH_URL || '').origin) throw new ProviderConnectionError('Change event links from this Everclose app.', 403);
      const body = await readJsonBody(request, { maximumBytes: 4096 }); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestBodyError('Use a JSON object.', 400);
      const result = request.method === 'PATCH' ? await editSavedCalendarEvent(env.DB, actor, path[2], body as Record<string, unknown>) : await removeSavedCalendarEvent(env.DB, actor, path[2], body as Record<string, unknown>);
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    }
    return Response.json({ error: 'Saved event route not found.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ProviderConnectionError || error instanceof RequestBodyError) return Response.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
    if (/CALENDAR_EVENT/u.test(String(error))) return Response.json({ error: 'These event links exceed the supported bounds or changed. Refresh and review fewer links.' }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    const recovery = recoveryErrorResponse(error); if (recovery) { recovery.headers.set('Cache-Control', 'no-store'); return recovery; }
    return Response.json({ error: 'The event service could not confirm this request. Retry the unchanged operation.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
