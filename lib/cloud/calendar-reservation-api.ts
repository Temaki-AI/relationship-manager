import { getCloudflareContext } from '@opennextjs/cloudflare';
import { fingerprintIdempotencyInput as hash } from '@/lib/idempotency';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { publicationPlanSnapshot, type CalendarReservation, type PublicationPlan } from '@/packages/domain/src/calendar-reservations';
import { maintenanceGuard, removeGuard } from './recovery-storage';
import type { DeviceActor } from './device-api';

type DB = CloudflareEnv['DB'];
type ReservationRow = {
  id: string; workspace_id: string; user_id: string; plan_public_id: string; provider: CalendarReservation['provider'];
  publisher_id: string; epoch: string; plan_fingerprint: string | null; request_fingerprint: string | null;
  status: CalendarReservation['status']; attempted: number; result_action: string | null; revision: number;
};
export class CalendarReservationError extends Error {
  constructor(message: string, readonly status = 409, readonly code = 'calendar_review_changed') { super(message); }
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
function authorization(actor: DeviceActor, epoch: string) {
  const sql = `EXISTS (SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
    JOIN workspace_sync_state s ON s.workspace_id = m.workspace_id WHERE m.workspace_id = ? AND m.user_id = ?
      AND m.role = 'owner' AND w.lifecycle = 'active' AND s.paused = 0 AND s.epoch = ?)`;
  const values = [actor.workspaceId, actor.userId, epoch];
  return actor.authMethod === 'web' ? { sql, values } : {
    sql: sql + ` AND EXISTS (SELECT 1 FROM device_sessions d WHERE d.id = ? AND d.workspace_id = ? AND d.user_id = ?
      AND d.revoked_at IS NULL AND d.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    values: [...values, actor.deviceId ?? '', actor.workspaceId, actor.userId],
  };
}
async function requireState(db: DB, actor: DeviceActor, epoch: string) {
  if (!isSyncUuid(epoch)) throw new CalendarReservationError('Refresh this account before reviewing Calendar.', 400, 'invalid_epoch');
  const auth = authorization(actor, epoch);
  if (await db.prepare('SELECT 1 WHERE ' + auth.sql).bind(...auth.values).first()) return auth;
  const state = await db.prepare('SELECT epoch, paused FROM workspace_sync_state WHERE workspace_id = ?').bind(actor.workspaceId).first<{ epoch: string; paused: number }>();
  if (!state) throw new CalendarReservationError('Sign in with the workspace owner account before reviewing Calendar.', 401, 'unauthorized');
  if (state?.epoch !== epoch) throw new CalendarReservationError('Account data changed after recovery. Review the original Calendar receipt.', 409, 'epoch_changed');
  if (state?.paused) throw new CalendarReservationError('Wait for account recovery before opening Calendar.', 423, 'maintenance');
  throw new CalendarReservationError('Sign in with the workspace owner account before reviewing Calendar.', 401, 'unauthorized');
}
const rowFor = (db: DB, actor: DeviceActor, id: string) => db.prepare('SELECT * FROM calendar_publication_reservations WHERE workspace_id = ? AND id = ?').bind(actor.workspaceId, id).first<ReservationRow>();
const liveFor = (db: DB, actor: DeviceActor, planId: string) => db.prepare("SELECT * FROM calendar_publication_reservations WHERE workspace_id = ? AND plan_public_id = ? AND status != 'cancelled'").bind(actor.workspaceId, planId).first<ReservationRow>();
const planFor = (db: DB, actor: DeviceActor, planId: string) => db.prepare(`SELECT p.public_id, c.public_id AS contact_public_id,
  p.type, p.planned_date, p.summary, p.notes, p.completed_at FROM plans p JOIN contacts c ON c.id = p.contact_id AND c.workspace_id = p.workspace_id
  WHERE p.workspace_id = ? AND p.public_id = ?`).bind(actor.workspaceId, planId).first<PublicationPlan>();
function projection(actor: DeviceActor, row: ReservationRow): CalendarReservation {
  return { id: row.id, plan_id: row.plan_public_id, provider: row.provider, status: row.status,
    attempted: Boolean(row.attempted), revision: row.revision, epoch: row.epoch, plan_fingerprint: row.plan_fingerprint,
    on_this_phone: actor.authMethod === 'device' && row.provider === 'apple-calendar' && row.publisher_id === actor.deviceId };
}
export async function readCalendarReservation(db: DB, actor: DeviceActor, planId: string, epoch: string, operationId?: string) {
  if (!isSyncUuid(planId) || operationId !== undefined && !isSyncUuid(operationId)) throw new CalendarReservationError('Choose a saved plan and Calendar receipt.', 400, 'invalid_request');
  const auth = await requireState(db, actor, epoch), row = operationId ? await rowFor(db, actor, operationId) : await liveFor(db, actor, planId);
  const plan = await planFor(db, actor, planId);
  if (row && row.plan_public_id !== planId) throw new CalendarReservationError('Calendar receipt not found.', 404, 'not_found');
  if (!await db.prepare('SELECT 1 WHERE ' + auth.sql).bind(...auth.values).first()) { await requireState(db, actor, epoch); throw new CalendarReservationError('Refresh Calendar before continuing.', 503); }
  return { version: 1, epoch, plan_fingerprint: plan ? hash(publicationPlanSnapshot(plan)) : null, reservation: row ? projection(actor, row) : null };
}
function mutation(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CalendarReservationError('Choose a Calendar action.', 400, 'invalid_request');
  const b = value as Record<string, unknown>, keys = ['action', 'operation_id', 'plan_id', 'expected_epoch', 'expected_revision', 'expected_plan_fingerprint'];
  if (b.action === 'result') keys.push('result_action');
  if (Object.keys(b).length !== keys.length || Object.keys(b).some((key) => !keys.includes(key))
    || !['reserve', 'attempt', 'release', 'result'].includes(String(b.action)) || !isSyncUuid(b.operation_id) || !isSyncUuid(b.plan_id)
    || !isSyncUuid(b.expected_epoch) || typeof b.expected_plan_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(b.expected_plan_fingerprint)
    || (b.action === 'reserve' ? b.expected_revision !== null : !Number.isSafeInteger(b.expected_revision) || Number(b.expected_revision) < 1)
    || b.action === 'result' && !['saved', 'canceled'].includes(String(b.result_action))) throw new CalendarReservationError('Refresh the original Calendar review.', 400, 'invalid_request');
  return b as { action: 'reserve' | 'attempt' | 'release' | 'result'; operation_id: string; plan_id: string;
    expected_epoch: string; expected_revision: number | null; expected_plan_fingerprint: string; result_action?: 'saved' | 'canceled' };
}
export async function mutateCalendarReservation(db: DB, actor: DeviceActor, value: unknown) {
  const b = mutation(value);
  if (actor.authMethod !== 'device' || !isSyncUuid(actor.deviceId)) throw new CalendarReservationError('Use your signed-in phone for Calendar editor actions.', 403, 'device_required');
  const auth = await requireState(db, actor, b.expected_epoch), existing = await rowFor(db, actor, b.operation_id);
  const own = (r: ReservationRow) => r.provider === 'apple-calendar' && r.publisher_id === actor.deviceId && r.user_id === actor.userId && r.plan_public_id === b.plan_id;
  const fingerprint = hash({ kind: 'apple-calendar-reservation', device: actor.deviceId, plan: b.plan_id,
    epoch: b.expected_epoch, fingerprint: b.expected_plan_fingerprint });
  if (existing && !own(existing)) throw new CalendarReservationError('This operation belongs to another Calendar review.', 409, 'receipt_mismatch');
  if (existing && existing.plan_fingerprint !== b.expected_plan_fingerprint) throw new CalendarReservationError('Keep the original Calendar review; its plan snapshot changed.', 409, 'receipt_mismatch');
  if (b.action === 'reserve' && existing) {
    if (existing.request_fingerprint !== fingerprint) throw new CalendarReservationError('Keep the original Calendar review; its request changed.', 409, 'receipt_mismatch');
    return { version: 1, epoch: b.expected_epoch, reservation: projection(actor, existing) };
  }
  if (b.action !== 'reserve' && !existing) throw new CalendarReservationError('Calendar receipt not found.', 404, 'not_found');
  const plan = await planFor(db, actor, b.plan_id), now = new Date().toISOString(), guard = crypto.randomUUID();
  const samePlan = plan && !plan.completed_at && hash(publicationPlanSnapshot(plan)) === b.expected_plan_fingerprint;
  if (b.action === 'reserve' || b.action === 'attempt') {
    if (!samePlan || existing && existing.epoch !== b.expected_epoch) throw new CalendarReservationError('Sync the plan and review its latest fields before opening Calendar.', 409, 'plan_changed');
  }
  const planSql = `EXISTS (SELECT 1 FROM plans p JOIN contacts c ON c.workspace_id = p.workspace_id AND c.id = p.contact_id
    WHERE p.workspace_id = ? AND p.public_id = ? AND c.public_id = ? AND p.type = ? AND p.planned_date = ?
      AND p.summary IS ? AND p.notes IS ? AND p.completed_at IS NULL)`;
  const planValues = plan ? [actor.workspaceId, b.plan_id, plan.contact_public_id, plan.type, plan.planned_date, plan.summary, plan.notes] : [];
  const linkSql = `NOT EXISTS (SELECT 1 FROM calendar_event_plans l JOIN plans p ON p.id = l.plan_id AND p.workspace_id = l.workspace_id
    WHERE p.workspace_id = ? AND p.public_id = ?)`;
  if (b.action === 'attempt' && existing!.status === 'attempted' && existing!.revision === b.expected_revision! + 1
    && existing!.plan_fingerprint === b.expected_plan_fingerprint && existing!.attempted === 1) {
    if (!await db.prepare('SELECT 1 WHERE ' + auth.sql + ' AND ' + planSql + ' AND ' + linkSql)
      .bind(...auth.values, ...planValues, actor.workspaceId, b.plan_id).first()) {
      await requireState(db, actor, b.expected_epoch);
      throw new CalendarReservationError('The plan or its Calendar association changed. Keep the original receipt.', 409, 'plan_changed');
    }
    return { version: 1, epoch: b.expected_epoch, reservation: projection(actor, existing!) };
  }
  if (b.action === 'result' && existing!.result_action === b.result_action && existing!.revision === b.expected_revision! + 1
    && existing!.status === (b.result_action === 'saved' ? 'saved' : 'cancelled')) return { version: 1, epoch: b.expected_epoch, reservation: projection(actor, existing!) };
  if (b.action === 'release' && existing!.status === 'cancelled' && !existing!.attempted && existing!.revision === b.expected_revision! + 1) {
    return { version: 1, epoch: b.expected_epoch, reservation: projection(actor, existing!) };
  }
  let statements;
  if (b.action === 'reserve') {
    const live = await liveFor(db, actor, b.plan_id);
    if (live) throw new CalendarReservationError('This plan already has a Calendar publication. Review its original receipt instead of creating another event.', 409, 'already_reserved');
    statements = [maintenanceGuard(db, guard, auth.sql + ' AND ' + planSql + ' AND ' + linkSql
      + ' AND (SELECT count(*) FROM calendar_publication_reservations WHERE workspace_id = ?) < 25000', [...auth.values, ...planValues, actor.workspaceId, b.plan_id, actor.workspaceId]),
    db.prepare(`INSERT INTO calendar_publication_reservations (id, workspace_id, user_id, plan_public_id, provider, publisher_id, epoch,
      plan_fingerprint, request_fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, 'apple-calendar', ?, ?, ?, ?, ?, ?)`)
      .bind(b.operation_id, actor.workspaceId, actor.userId, b.plan_id, actor.deviceId, b.expected_epoch, b.expected_plan_fingerprint, fingerprint, now, now)];
  } else {
    const r = existing!, next = b.action === 'attempt' ? 'attempted' : b.action === 'release' || b.result_action === 'canceled' ? 'cancelled' : 'saved';
    if (r.revision !== b.expected_revision || b.action === 'attempt' && (r.status !== 'reserved' || r.attempted)
      || b.action === 'release' && (r.attempted || !['reserved', 'held'].includes(r.status))
      || b.action === 'result' && (r.status !== 'attempted' || !r.attempted || r.epoch !== b.expected_epoch)) {
      throw new CalendarReservationError('Keep the original Calendar receipt. An attempted editor cannot be discarded or opened again.', 409, 'receipt_changed');
    }
    const condition = auth.sql + (b.action === 'attempt' ? ' AND ' + planSql + ' AND ' + linkSql : '')
      + ' AND EXISTS (SELECT 1 FROM calendar_publication_reservations WHERE workspace_id = ? AND id = ? AND revision = ? AND status = ? AND attempted = ?)';
    statements = [maintenanceGuard(db, guard, condition, [...auth.values, ...(b.action === 'attempt' ? [...planValues, actor.workspaceId, b.plan_id] : []), actor.workspaceId, r.id, r.revision, r.status, r.attempted]),
      db.prepare('UPDATE calendar_publication_reservations SET status = ?, attempted = ?, result_action = ?, revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND revision = ?')
        .bind(next, b.action === 'attempt' ? 1 : r.attempted, b.action === 'result' ? b.result_action! : r.result_action, now, actor.workspaceId, r.id, r.revision)];
  }
  try { await db.batch([...statements, removeGuard(db, guard)]); }
  catch (error) {
    if (/CALENDAR_RESERVATION_INVALID|CLOUD_RECOVERY_CONFLICT|calendar_publication_reservations/.test(String(error))) {
      await requireState(db, actor, b.expected_epoch);
      throw new CalendarReservationError('The plan or Calendar reservation changed. Keep your original review and refresh.', 409, 'reservation_changed');
    }
    throw error;
  }
  return { version: 1, epoch: b.expected_epoch, reservation: projection(actor, (await rowFor(db, actor, b.operation_id))!) };
}
export async function handleCalendarReservations(request: Request, actor: DeviceActor) {
  try {
    const { env } = getCloudflareContext();
    if (request.method === 'POST') return json(await mutateCalendarReservation(env.DB, actor, await readJsonBody(request, { maximumBytes: 4096 })));
    if (request.method !== 'GET') return json({ error: 'Calendar reservation method not allowed.' }, 405);
    const p = new URL(request.url).searchParams;
    if ([...p.keys()].some((key) => !['plan_id', 'epoch', 'operation_id'].includes(key) || p.getAll(key).length !== 1)) throw new CalendarReservationError('Choose the saved Calendar review.', 400, 'invalid_request');
    return json(await readCalendarReservation(env.DB, actor, p.get('plan_id') ?? '', p.get('epoch') ?? '', p.get('operation_id') ?? undefined));
  } catch (error) {
    if (error instanceof CalendarReservationError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
    throw error;
  }
}
