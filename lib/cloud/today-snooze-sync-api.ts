import { getCloudflareContext } from '@opennextjs/cloudflare';
import { dateInTimeZone, normalizeTimeZone } from '@/packages/domain/src/civil-date';
import { MAX_ACTIVE_TODAY_SNOOZES, PromptSnoozeError, readPromptMutation, validatePromptUntil, type PromptMutation } from '@/packages/domain/src/today-snoozes';
import { fingerprintIdempotencyInput } from '@/lib/idempotency';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { maintenanceGuard, removeGuard } from './recovery-storage';
import type { DeviceActor } from './device-api';

type DB = CloudflareEnv['DB'];
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
function authorization(actor: DeviceActor, epoch: string) {
  return { sql: `EXISTS (SELECT 1 FROM device_sessions d JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id
    JOIN workspaces w ON w.id = d.workspace_id JOIN workspace_sync_state s ON s.workspace_id = d.workspace_id
    WHERE d.id = ? AND d.workspace_id = ? AND d.user_id = ? AND d.revoked_at IS NULL AND d.expires_at > ?
      AND m.role = 'owner' AND w.lifecycle = 'active' AND s.epoch = ? AND s.paused = 0)`,
  values: [actor.deviceId ?? '', actor.workspaceId, actor.userId, new Date().toISOString(), epoch] };
}
async function requireState(db: DB, actor: DeviceActor, epoch: string) {
  if (actor.authMethod !== 'device') throw new PromptSnoozeError('Use your signed-in phone to sync these choices.', 403, 'device_required');
  const state = await db.prepare(`SELECT m.role, w.lifecycle, s.epoch, s.paused FROM device_sessions d
    JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id
    JOIN workspaces w ON w.id = d.workspace_id JOIN workspace_sync_state s ON s.workspace_id = d.workspace_id
    WHERE d.id = ? AND d.workspace_id = ? AND d.user_id = ? AND d.revoked_at IS NULL AND d.expires_at > ?`)
    .bind(actor.deviceId ?? '', actor.workspaceId, actor.userId, new Date().toISOString()).first<{ role: string; lifecycle: string; epoch: string; paused: number }>();
  if (!state) throw new PromptSnoozeError('Sign in again to sync prompt choices. They remain saved on this phone.', 401, 'unauthorized');
  if (state.role !== 'owner') throw new PromptSnoozeError('Only the workspace owner can change prompt choices.', 403, 'forbidden');
  if (state.paused || state.lifecycle !== 'active') throw new PromptSnoozeError('Account recovery is in progress. Your choices are safe on this phone.', 423, 'maintenance');
  if (state.epoch !== epoch) throw new PromptSnoozeError('Account data was restored. Review these choices before syncing.', 409, 'epoch_changed');
}
async function target(db: DB, actor: DeviceActor, mutation: PromptMutation) {
  const row = mutation.kind === 'reminder'
    ? await db.prepare(`SELECT r.id AS target_id, c.id AS contact_id FROM reminders r JOIN contacts c ON c.id = r.contact_id AND c.workspace_id = r.workspace_id
      WHERE r.workspace_id = ? AND r.public_id = ? ${mutation.untilDate === null ? '' : 'AND r.completed_at IS NULL'}`).bind(actor.workspaceId, mutation.targetId).first<{ target_id: number; contact_id: number }>()
    : await db.prepare(`SELECT id AS target_id, id AS contact_id FROM contacts WHERE workspace_id = ? AND public_id = ? ${mutation.kind === 'birthday' && mutation.untilDate !== null ? 'AND birthday IS NOT NULL' : ''}`)
      .bind(actor.workspaceId, mutation.targetId).first<{ target_id: number; contact_id: number }>();
  if (!row) throw new PromptSnoozeError('This prompt’s person or reminder changed. Review the saved choice.', 409, 'target_changed');
  return row;
}
async function receipt(db: DB, actor: DeviceActor, body: PromptMutation, fingerprint: string) {
  const auth = authorization(actor, body.epoch);
  const result = await db.batch([
    db.prepare(`SELECT 1 FROM workspace_sync_state WHERE workspace_id = ? AND ${auth.sql}`).bind(actor.workspaceId, ...auth.values),
    db.prepare('SELECT fingerprint, result FROM sync_mutation_receipts WHERE workspace_id = ? AND epoch = ? AND operation_id = ?')
      .bind(actor.workspaceId, body.epoch, `today:${body.operationId}`),
  ]);
  if (!result[0].results.length) { await requireState(db, actor, body.epoch); throw new PromptSnoozeError('Could not confirm this choice. Retry the unchanged operation.', 503, 'confirmation_unavailable'); }
  const row = result[1].results[0] as { fingerprint: string; result: string | null } | undefined;
  if (row && row.fingerprint !== fingerprint) throw new PromptSnoozeError('This operation belongs to another prompt choice.', 409, 'receipt_mismatch');
  return row?.result ? JSON.parse(row.result) as Record<string, unknown> : null;
}
export async function pushPromptSnooze(db: DB, actor: DeviceActor, value: unknown, now = new Date()) {
  const body = readPromptMutation(value); await requireState(db, actor, body.epoch);
  const fingerprint = fingerprintIdempotencyInput({ actor: actor.userId, mutation: body });
  // A committed reply stays replayable after expiry or target deletion. Validate
  // future bounds only for a new write, never for its unchanged retry.
  const replay = await receipt(db, actor, body, fingerprint); if (replay) return replay;
  validatePromptUntil(body.untilDate, now, body.timeZone);
  const source = await target(db, actor, body), id = `${body.kind}-${source.target_id}`;
  const today = dateInTimeZone(now, body.timeZone)!, auth = authorization(actor, body.epoch), owner = crypto.randomUUID();
  const baseMatches = `(SELECT until_date FROM daily_snoozes WHERE workspace_id = ? AND id = ?) IS ?
    OR (? IS NULL AND NOT EXISTS (SELECT 1 FROM daily_snoozes WHERE workspace_id = ? AND id = ? AND until_date > ?))`;
  const baseValues = [actor.workspaceId, id, body.baseUntilDate, body.baseUntilDate, actor.workspaceId, id, today];
  const available = body.kind === 'reminder'
    ? `EXISTS (SELECT 1 FROM reminders r JOIN contacts c ON c.id = r.contact_id AND c.workspace_id = r.workspace_id WHERE r.workspace_id = ? AND r.id = ? AND r.public_id = ? AND r.contact_id = ? ${body.untilDate === null ? '' : 'AND r.completed_at IS NULL'})`
    : `EXISTS (SELECT 1 FROM contacts WHERE workspace_id = ? AND id = ? AND public_id = ? AND id = ? ${body.kind === 'birthday' && body.untilDate !== null ? 'AND birthday IS NOT NULL' : ''})`;
  const ack = { version: 1, epoch: body.epoch, operationId: body.operationId, kind: body.kind, targetId: body.targetId, untilDate: body.untilDate };
  const timestamp = now.toISOString();
  try {
    await db.batch([
      maintenanceGuard(db, owner, `${auth.sql} AND ${available} AND (${baseMatches}) AND
        (? IS NULL OR EXISTS (SELECT 1 FROM daily_snoozes WHERE workspace_id = ? AND id = ? AND until_date > ?)
          OR (SELECT COUNT(*) FROM daily_snoozes WHERE workspace_id = ? AND until_date > ?) < ?)`,
      [...auth.values, actor.workspaceId, source.target_id, body.targetId, source.contact_id, ...baseValues,
        body.untilDate, actor.workspaceId, id, today, actor.workspaceId, today, MAX_ACTIVE_TODAY_SNOOZES]),
      db.prepare(`INSERT INTO sync_mutation_receipts (workspace_id, epoch, operation_id, fingerprint, owner_token, result)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(actor.workspaceId, body.epoch, `today:${body.operationId}`, fingerprint, owner, JSON.stringify(ack)),
      maintenanceGuard(db, owner + '-receipt', 'EXISTS (SELECT 1 FROM sync_mutation_receipts WHERE workspace_id = ? AND epoch = ? AND operation_id = ? AND owner_token = ?)', [actor.workspaceId, body.epoch, `today:${body.operationId}`, owner]),
      body.untilDate === null
        ? db.prepare('DELETE FROM daily_snoozes WHERE workspace_id = ? AND id = ?').bind(actor.workspaceId, id)
        : db.prepare(`INSERT INTO daily_snoozes (workspace_id, id, contact_id, reminder_id, until_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, id) DO UPDATE SET until_date = excluded.until_date, updated_at = excluded.updated_at`)
          .bind(actor.workspaceId, id, source.contact_id, body.kind === 'reminder' ? source.target_id : null, body.untilDate, timestamp, timestamp),
      removeGuard(db, owner), removeGuard(db, owner + '-receipt'),
    ]);
  } catch (error) {
    await requireState(db, actor, body.epoch);
    const committed = await receipt(db, actor, body, fingerprint); if (committed) return committed;
    await target(db, actor, body);
    const current = await db.prepare('SELECT until_date FROM daily_snoozes WHERE workspace_id = ? AND id = ?').bind(actor.workspaceId, id).first<{ until_date: string }>();
    if ((current?.until_date ?? null) !== body.baseUntilDate && !(body.baseUntilDate === null && (!current || current.until_date <= today))) {
      throw new PromptSnoozeError('The web prompt choice changed. Review both choices before replacing it.', 409, 'prompt_changed');
    }
    const count = await db.prepare('SELECT COUNT(*) n FROM daily_snoozes WHERE workspace_id = ? AND until_date > ?').bind(actor.workspaceId, today).first<{ n: number }>();
    if (body.untilDate && (!current || current.until_date <= today) && count!.n >= MAX_ACTIVE_TODAY_SNOOZES) {
      throw new PromptSnoozeError('Too many snoozed prompts. Bring one back before snoozing another.', 409, 'prompt_capacity');
    }
    throw error;
  }
  return ack;
}
export async function promptSnoozeSnapshot(db: DB, actor: DeviceActor, epoch: string, timeZone: string, now = new Date()) {
  await requireState(db, actor, epoch);
  const auth = authorization(actor, epoch), today = dateInTimeZone(now, normalizeTimeZone(timeZone))!;
  const result = await db.batch([
    db.prepare(`SELECT 1 FROM workspace_sync_state WHERE workspace_id = ? AND ${auth.sql}`).bind(actor.workspaceId, ...auth.values),
    db.prepare(`SELECT CASE WHEN s.reminder_id IS NOT NULL THEN 'reminder' WHEN s.id = 'birthday-' || c.id THEN 'birthday' ELSE 'overdue' END AS kind,
      CASE WHEN s.reminder_id IS NOT NULL THEN r.public_id ELSE c.public_id END AS targetId, c.public_id AS contactId, s.until_date AS untilDate
      FROM daily_snoozes s JOIN contacts c ON c.workspace_id = s.workspace_id AND c.id = s.contact_id
      LEFT JOIN reminders r ON r.workspace_id = s.workspace_id AND r.id = s.reminder_id
      WHERE s.workspace_id = ? AND s.until_date > ? AND (s.reminder_id IS NULL OR r.completed_at IS NULL AND r.id IS NOT NULL)
      ORDER BY s.id LIMIT ?`).bind(actor.workspaceId, today, MAX_ACTIVE_TODAY_SNOOZES + 1),
  ]);
  if (!result[0].results.length) { await requireState(db, actor, epoch); throw new PromptSnoozeError('Could not confirm prompt choices. Retry shortly.', 503, 'confirmation_unavailable'); }
  if (result[1].results.length > MAX_ACTIVE_TODAY_SNOOZES) throw new PromptSnoozeError('Too many snoozed prompts. Review them on the web before syncing.', 409, 'prompt_capacity');
  return { version: 1, epoch, snoozes: result[1].results };
}
export async function handleTodaySnoozeSync(request: Request, actor: DeviceActor) {
  try {
    const env = getCloudflareContext().env, url = new URL(request.url), origin = request.headers.get('origin');
    if (origin !== null && origin !== new URL(env.BETTER_AUTH_URL).origin) throw new PromptSnoozeError('Save these choices from Everclose.', 403, 'origin_required');
    if (request.method === 'POST') return json(await pushPromptSnooze(env.DB, actor, await readJsonBody(request, { maximumBytes: 4096 })));
    if (request.method === 'GET') return json(await promptSnoozeSnapshot(env.DB, actor, url.searchParams.get('epoch') ?? '', url.searchParams.get('timeZone') ?? 'UTC'));
    return json({ error: 'Method not allowed.' }, 405);
  } catch (error) {
    if (error instanceof PromptSnoozeError || error instanceof RequestBodyError) return json({ error: error.message, code: error instanceof PromptSnoozeError ? error.code : 'invalid_prompt' }, error.status);
    console.error('cloud.today_prompt.confirmation_failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    return json({ error: 'Could not confirm this choice. Retry the unchanged operation.', code: 'confirmation_unavailable' }, 503);
  }
}
