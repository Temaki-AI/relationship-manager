import { getCloudflareContext } from '@opennextjs/cloudflare';
import { CalendarLinkError, calendarLinksFingerprintInput, readCalendarLinkMutation, type CalendarLinkMutation } from '@/packages/domain/src/calendar-event-links';
import { readSyncV4Record } from '@/packages/domain/src/sync-v4-client';
import { fingerprintIdempotencyInput } from '@/lib/idempotency';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { calendarLinkStatements } from './calendar-event-links';
import { calendarEventProjectionSql, refreshCalendarEventProjections } from './calendar-event-projection';
import { maintenanceGuard, removeGuard } from './recovery-storage';
import type { DeviceActor } from './device-api';

type DB = CloudflareEnv['DB'];
type EventRow = { id: number; public_id: string; revision: number; sync_revision: number; data: string };
const SCOPE = 'native-calendar-links-v1';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

function authorization(actor: DeviceActor, now = new Date().toISOString()) {
  return {
    sql: `EXISTS (SELECT 1 FROM workspace_members member JOIN workspaces w ON w.id = member.workspace_id
      JOIN device_sessions d ON d.workspace_id = member.workspace_id AND d.user_id = member.user_id
      WHERE member.workspace_id = ? AND member.user_id = ? AND member.role = 'owner' AND w.lifecycle = 'active'
        AND d.id = ? AND d.revoked_at IS NULL AND d.expires_at > ?)`,
    values: [actor.workspaceId, actor.userId, actor.deviceId ?? '', now],
  };
}
async function requireState(db: DB, actor: DeviceActor, epoch: string) {
  if (actor.authMethod !== 'device') throw new CalendarLinkError('Use your signed-in phone to save these meeting choices.', 403, 'device_required');
  const identity = await db.prepare(`SELECT m.role, w.lifecycle FROM device_sessions d
    JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id JOIN workspaces w ON w.id = m.workspace_id
    WHERE d.id = ? AND d.workspace_id = ? AND d.user_id = ? AND d.revoked_at IS NULL AND d.expires_at > ?`)
    .bind(actor.deviceId ?? '', actor.workspaceId, actor.userId, new Date().toISOString()).first<{ role: string; lifecycle: string }>();
  if (!identity) throw new CalendarLinkError('This phone session is no longer valid. Sign in again.', 401, 'unauthorized');
  if (identity.role !== 'owner' || identity.lifecycle !== 'active') throw new CalendarLinkError('Only the active workspace owner can change saved meeting links.', 403, 'forbidden');
  const state = await db.prepare('SELECT epoch, paused FROM workspace_sync_state WHERE workspace_id = ?').bind(actor.workspaceId).first<{ epoch: string; paused: number }>();
  if (!state || state.epoch !== epoch) throw new CalendarLinkError('Account data was restored. Review this meeting before syncing its links.', 409, 'epoch_changed');
  if (state.paused) throw new CalendarLinkError('Account recovery is in progress. Keep your meeting choices on the phone.', 423, 'maintenance');
}
function projection(row: EventRow) {
  return readSyncV4Record({ entity: 'source_event', id: row.public_id, legacyId: row.id, revision: row.sync_revision,
    deleted: false, data: JSON.parse(row.data) });
}
function snapshot(db: DB, workspaceId: string, eventId: string) {
  return db.prepare(`SELECT e.id, e.public_id, e.revision, s.revision AS sync_revision, ${calendarEventProjectionSql()} AS data
    FROM calendar_events e JOIN sync_entity_records s ON s.workspace_id = e.workspace_id AND s.public_id = e.public_id AND s.entity_type = 'source_event'
    WHERE e.workspace_id = ? AND e.public_id = ?`).bind(workspaceId, eventId).first<EventRow>();
}
async function receipt(db: DB, actor: DeviceActor, body: CalendarLinkMutation, fingerprint: string) {
  const row = await db.prepare('SELECT fingerprint, resource_id FROM mutation_receipts WHERE workspace_id = ? AND scope = ? AND request_key = ?')
    .bind(actor.workspaceId, SCOPE, body.operationId).first<{ fingerprint: string; resource_id: number | null }>();
  if (row && row.fingerprint !== fingerprint) throw new CalendarLinkError('This operation already belongs to different meeting choices.', 409, 'receipt_mismatch');
  return row;
}
async function acknowledge(db: DB, actor: DeviceActor, body: CalendarLinkMutation, resourceId: number | null) {
  await refreshCalendarEventProjections(db, actor.workspaceId);
  const auth = authorization(actor);
  // Permission, epoch and the latest acknowledgement are read in the same D1 snapshot.
  const result = await db.batch([
    db.prepare(`SELECT epoch, paused FROM workspace_sync_state WHERE workspace_id = ? AND ${auth.sql}`).bind(actor.workspaceId, ...auth.values),
    db.prepare(`SELECT e.id, e.public_id, e.revision, s.revision AS sync_revision, ${calendarEventProjectionSql()} AS data
      FROM calendar_events e JOIN sync_entity_records s ON s.workspace_id = e.workspace_id AND s.public_id = e.public_id AND s.entity_type = 'source_event'
      WHERE e.workspace_id = ? AND e.public_id = ? AND e.id = ?`).bind(actor.workspaceId, body.eventId, resourceId),
  ]);
  const state = result[0].results[0] as { epoch: string; paused: number } | undefined;
  if (!state || state.epoch !== body.epoch || state.paused) {
    await requireState(db, actor, body.epoch);
    throw new CalendarLinkError('The account changed while confirming this operation. Retry it unchanged.', 503, 'confirmation_unavailable');
  }
  const row = result[1].results[0] as EventRow | undefined;
  return { version: 1, operationId: body.operationId, epoch: body.epoch, event: row ? projection(row) : null };
}
async function resolveTargets(db: DB, actor: DeviceActor, body: CalendarLinkMutation, eventId: number) {
  const result = await db.batch([
    db.prepare('SELECT id, public_id FROM contacts WHERE workspace_id = ? AND public_id IN (SELECT value FROM json_each(?)) ORDER BY public_id').bind(actor.workspaceId, JSON.stringify(body.contactIds)),
    db.prepare('SELECT id, public_id FROM plans WHERE workspace_id = ? AND public_id IN (SELECT value FROM json_each(?)) ORDER BY public_id').bind(actor.workspaceId, JSON.stringify(body.planIds)),
    db.prepare(`SELECT 1 FROM calendar_event_plans link JOIN plans p ON p.workspace_id = link.workspace_id AND p.id = link.plan_id
      WHERE link.workspace_id = ? AND link.event_id != ? AND p.public_id IN (SELECT value FROM json_each(?)) LIMIT 1`).bind(actor.workspaceId, eventId, JSON.stringify(body.planIds)),
  ]);
  const people = result[0].results as { id: number; public_id: string }[], plans = result[1].results as { id: number; public_id: string }[];
  if (people.length !== body.contactIds.length || plans.length !== body.planIds.length) throw new CalendarLinkError('A selected person or plan was removed or merged. Review your choices.', 409, 'target_changed');
  if (result[2].results.length) throw new CalendarLinkError('A selected plan is already linked to another meeting. Review its existing link first.', 409, 'plan_linked');
  return { people, plans };
}

/** Writes only the Everclose association graph. No provider credentials, facts, plans or history are changed. */
export async function pushCalendarEventLinks(db: DB, actor: DeviceActor, value: unknown) {
  const body = readCalendarLinkMutation(value);
  await requireState(db, actor, body.epoch);
  const fingerprint = fingerprintIdempotencyInput({ actor: actor.userId, mutation: body });
  // A committed operation must remain replayable after privacy updates, merges or removal.
  const replay = await receipt(db, actor, body, fingerprint);
  if (replay) return acknowledge(db, actor, body, replay.resource_id);
  const row = await snapshot(db, actor.workspaceId, body.eventId);
  if (!row) throw new CalendarLinkError('The saved meeting was removed. Keep your choices for review.', 409, 'event_missing');
  if (fingerprintIdempotencyInput(calendarLinksFingerprintInput(projection(row))) !== body.baseFingerprint) {
    throw new CalendarLinkError('The meeting or its links changed. Review the current meeting while keeping your choices.', 409, 'event_changed');
  }
  const chosen = await resolveTargets(db, actor, body, row.id), auth = authorization(actor), owner = crypto.randomUUID(), now = new Date().toISOString();
  const pairs = (items: typeof chosen.people) => JSON.stringify(items.map((item) => [item.id, item.public_id]));
  const targetFence = `
    (SELECT COUNT(*) FROM json_each(?) chosen JOIN contacts c ON c.id = json_extract(chosen.value, '$[0]') AND c.public_id = json_extract(chosen.value, '$[1]') AND c.workspace_id = ?) = ?
    AND (SELECT COUNT(*) FROM json_each(?) chosen JOIN plans p ON p.id = json_extract(chosen.value, '$[0]') AND p.public_id = json_extract(chosen.value, '$[1]') AND p.workspace_id = ?) = ?
    AND NOT EXISTS (SELECT 1 FROM calendar_event_plans WHERE workspace_id = ? AND event_id != ? AND plan_id IN (SELECT json_extract(value, '$[0]') FROM json_each(?)))`;
  try {
    await db.batch([
      maintenanceGuard(db, owner, `${auth.sql} AND EXISTS (SELECT 1 FROM workspace_sync_state WHERE workspace_id = ? AND epoch = ? AND paused = 0)
        AND EXISTS (SELECT 1 FROM calendar_events WHERE workspace_id = ? AND public_id = ? AND id = ? AND revision = ?) AND ${targetFence}`,
      [...auth.values, actor.workspaceId, body.epoch, actor.workspaceId, body.eventId, row.id, row.revision,
        pairs(chosen.people), actor.workspaceId, chosen.people.length, pairs(chosen.plans), actor.workspaceId, chosen.plans.length,
        actor.workspaceId, row.id, pairs(chosen.plans)]),
      db.prepare('INSERT INTO mutation_receipts (workspace_id, scope, request_key, fingerprint, owner_token, resource_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .bind(actor.workspaceId, SCOPE, body.operationId, fingerprint, owner, row.id),
      maintenanceGuard(db, owner + '-receipt', 'EXISTS (SELECT 1 FROM mutation_receipts WHERE workspace_id = ? AND scope = ? AND request_key = ? AND owner_token = ?)', [actor.workspaceId, SCOPE, body.operationId, owner]),
      ...calendarLinkStatements(db, actor.workspaceId, body.eventId, chosen.people.map((p) => p.id), chosen.plans.map((p) => p.id), now),
      db.prepare('UPDATE calendar_events SET revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND id = ?').bind(now, actor.workspaceId, row.id),
      removeGuard(db, owner), removeGuard(db, owner + '-receipt'),
    ]);
  } catch (error) {
    const committed = await receipt(db, actor, body, fingerprint);
    if (committed) return acknowledge(db, actor, body, committed.resource_id);
    await requireState(db, actor, body.epoch);
    const latest = await snapshot(db, actor.workspaceId, body.eventId);
    if (!latest || fingerprintIdempotencyInput(calendarLinksFingerprintInput(projection(latest))) !== body.baseFingerprint) {
      throw new CalendarLinkError('The meeting or its links changed before saving. Review the current meeting.', 409, latest ? 'event_changed' : 'event_missing');
    }
    await resolveTargets(db, actor, body, latest.id);
    if (/CALENDAR_EVENT/u.test(String(error))) throw new CalendarLinkError('These links exceed the meeting capacity. Review fewer links.', 413, 'link_capacity');
    throw error;
  }
  return acknowledge(db, actor, body, row.id);
}

export async function handleCalendarEventLinks(request: Request, actor: DeviceActor, path: string[]) {
  try {
    if (path.join('/') !== 'v1/calendar-event-links/push' || request.method !== 'POST') return json({ error: 'Meeting links route not found.' }, 404);
    const env = getCloudflareContext().env, origin = request.headers.get('origin');
    if (origin !== null && origin !== new URL(env.BETTER_AUTH_URL).origin) throw new CalendarLinkError('Save these choices from Everclose.', 403, 'origin_required');
    return json(await pushCalendarEventLinks(env.DB, actor, await readJsonBody(request, { maximumBytes: 4096 })));
  } catch (error) {
    if (error instanceof CalendarLinkError || error instanceof RequestBodyError) return json({ error: error.message, code: error instanceof CalendarLinkError ? error.code : 'invalid_links' }, error.status);
    console.error('cloud.calendar_links.confirmation_failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    return json({ error: 'The server could not confirm these meeting choices. Retry the unchanged operation.', code: 'confirmation_unavailable' }, 503);
  }
}
