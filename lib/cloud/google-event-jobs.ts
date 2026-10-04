import { isSyncUuid } from '@/packages/domain/src/sync';
import { ProviderConnectionError } from './provider-vault';
import type { ProviderEnvironment, ProviderFetch } from './google-provider';
import { advanceEventDownload, startEventDownload } from './google-event-downloads';

type DB = CloudflareEnv['DB'];
export type CalendarEventQueueMessage = { kind: 'google-calendar'; version: 1; workspaceId: string; connectionId: string; runId: string };
export type CalendarEventQueue = { send(body: CalendarEventQueueMessage): Promise<unknown> };
type Run = { id: string; connection_id: string; workspace_id: string; user_id: string; status: string; revision: number; retry_at: number; schedule_revision: number | null };
const message = (run: Run): CalendarEventQueueMessage => ({ kind: 'google-calendar', version: 1, workspaceId: run.workspace_id, connectionId: run.connection_id, runId: run.id });
const eligible = `EXISTS (SELECT 1 FROM provider_connections c JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id
  JOIN workspaces w ON w.id = c.workspace_id JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
  JOIN provider_calendar_resources k ON k.connection_id = c.id JOIN provider_calendars a ON a.connection_id = c.id AND a.calendar_id = r.calendar_id
  JOIN provider_event_resources p ON p.connection_id = c.id AND p.calendar_id = r.calendar_id
  WHERE c.id = r.connection_id AND c.workspace_id = r.workspace_id AND c.user_id = r.user_id AND c.purpose = 'calendar' AND c.status = 'connected'
    AND c.authorization_revision = r.authorization_revision AND c.dataset_epoch = r.dataset_epoch AND s.epoch = r.dataset_epoch
    AND s.paused = 0 AND w.lifecycle = 'active' AND m.role = 'owner' AND (c.refresh_expires_at IS NULL OR c.refresh_expires_at > ?)
    AND k.selection_revision = r.selection_revision AND a.availability = 'available' AND json_extract(a.facts, '$.access_role') != 'freeBusyReader'
    AND EXISTS (SELECT 1 FROM json_each(k.selected_ids) WHERE value = r.calendar_id)
    AND p.sync_enabled = 1 AND p.settings_revision = r.schedule_revision)`;

export function readCalendarEventQueueMessage(value: unknown): CalendarEventQueueMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 5 && v.kind === 'google-calendar' && v.version === 1 && typeof v.workspaceId === 'string'
    && v.workspaceId.length > 0 && v.workspaceId.length <= 128 && isSyncUuid(v.connectionId) && isSyncUuid(v.runId)
    ? { kind: 'google-calendar', version: 1, workspaceId: v.workspaceId, connectionId: v.connectionId, runId: v.runId } : null;
}

export async function startDueCalendarEventDownloads(db: DB, environment: ProviderEnvironment) {
  const now = Date.now();
  const rows = (await db.prepare(`SELECT p.*, c.user_id, c.dataset_epoch, c.authorization_revision, k.selection_revision
    FROM provider_event_resources p JOIN provider_connections c ON c.id = p.connection_id
    JOIN workspace_sync_state s ON s.workspace_id = p.workspace_id JOIN workspaces w ON w.id = p.workspace_id
    JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = c.user_id AND m.role = 'owner'
    JOIN provider_calendar_resources k ON k.connection_id = c.id JOIN provider_calendars a ON a.connection_id = c.id AND a.calendar_id = p.calendar_id
    WHERE p.sync_enabled = 1 AND p.next_sync_at <= ? AND c.purpose = 'calendar' AND c.status = 'connected' AND c.dataset_epoch = s.epoch
      AND s.paused = 0 AND w.lifecycle = 'active' AND (c.refresh_expires_at IS NULL OR c.refresh_expires_at > ?)
      AND a.availability = 'available' AND json_extract(a.facts, '$.access_role') != 'freeBusyReader'
      AND EXISTS (SELECT 1 FROM json_each(k.selected_ids) WHERE value = p.calendar_id)
      AND NOT EXISTS (SELECT 1 FROM provider_event_runs j WHERE j.connection_id = p.connection_id AND j.calendar_id = p.calendar_id AND j.status = 'active')
    ORDER BY p.next_sync_at, p.connection_id, p.calendar_id LIMIT 5`).bind(now, now).all<{
      connection_id: string; calendar_id: string; workspace_id: string; user_id: string; dataset_epoch: string; authorization_revision: number;
      selection_revision: number; settings_revision: number; past_days: number; future_days: number; next_sync_at: number;
    }>()).results;
  let started = 0;
  for (const row of rows) {
    try {
      await startEventDownload(db, { workspaceId: row.workspace_id, userId: row.user_id, authMethod: 'web' }, environment, row.connection_id,
        { operation_id: crypto.randomUUID(), calendar_id: row.calendar_id, expected_epoch: row.dataset_epoch, expected_authorization_revision: row.authorization_revision,
          expected_selection_revision: row.selection_revision, past_days: row.past_days, future_days: row.future_days }, { revision: row.settings_revision, due: row.next_sync_at });
      started++;
    } catch (error) {
      // Another tick/manual download or a changed consent can win the guarded insert.
      if (!(error instanceof ProviderConnectionError) && !/CLOUD_RECOVERY_CONFLICT|provider_event_runs_one_active/u.test(String(error))) throw error;
    }
  }
  return started;
}

export async function processCalendarEventMessage(delivery: { body: unknown; attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void },
  env: CloudflareEnv, fetcher: ProviderFetch = fetch) {
  const input = readCalendarEventQueueMessage(delivery.body);
  if (!input) { delivery.ack(); return; }
  const run = await env.DB.prepare(`SELECT r.* FROM provider_event_runs r WHERE r.id = ? AND r.workspace_id = ? AND r.connection_id = ?
    AND r.status = 'active' AND r.schedule_revision IS NOT NULL AND ${eligible}`)
    .bind(input.runId, input.workspaceId, input.connectionId, Date.now()).first<Run>();
  if (!run) { delivery.ack(); return; }
  if (run.retry_at > Date.now()) { delivery.retry({ delaySeconds: Math.max(2, Math.min(900, Math.ceil((run.retry_at - Date.now()) / 1000))) }); return; }
  try {
    const result = await advanceEventDownload(env.DB, { workspaceId: run.workspace_id, userId: run.user_id, authMethod: 'web' },
      { ...process.env, ...env } as unknown as ProviderEnvironment, run.connection_id, run.id, fetcher);
    if (result.status !== 'active') { delivery.ack(); return; }
    if (result.retry_at > Date.now()) { delivery.retry({ delaySeconds: Math.max(2, Math.min(900, Math.ceil((result.retry_at - Date.now()) / 1000))) }); return; }
    // The durable run stores the next page before this send. Cron repairs send outages.
    await env.GOOGLE_CALENDAR_QUEUE.send(input); delivery.ack();
  } catch (error) {
    const current = await env.DB.prepare(`SELECT r.id FROM provider_event_runs r WHERE r.id = ? AND r.status = 'active' AND ${eligible}`).bind(run.id, Date.now()).first();
    if (!current) { delivery.ack(); return; }
    if (error instanceof ProviderConnectionError && error.status === 503) { delivery.retry({ delaySeconds: 30 }); return; }
    throw error;
  }
}

export async function reconcileCalendarEventDownloads(db: DB, queue: CalendarEventQueue, environment: ProviderEnvironment) {
  // A worker outage must not leave an unbounded staging generation or an active lock forever.
  const expired = await db.prepare(`UPDATE provider_event_runs AS r SET status = 'failed', issue = 'job_expired', revision = revision + 1,
    lease_token = NULL, lease_until = NULL, updated_at = ? WHERE r.id IN
    (SELECT r.id FROM provider_event_runs r WHERE r.status = 'active' AND r.schedule_revision IS NOT NULL
      AND (r.created_at < ? OR NOT ${eligible}) AND (r.lease_token IS NULL OR r.lease_until < ?) LIMIT 20)`)
    .bind(new Date().toISOString(), new Date(Date.now() - 24 * 60 * 60_000).toISOString(), Date.now(), Date.now()).run();
  const scheduled = await startDueCalendarEventDownloads(db, environment);
  const runs = (await db.prepare(`SELECT r.* FROM provider_event_runs r WHERE r.status = 'active' AND r.schedule_revision IS NOT NULL
    AND r.retry_at <= ? AND (r.lease_token IS NULL OR r.lease_until < ?) AND ${eligible} ORDER BY r.updated_at, r.id LIMIT 5`)
    .bind(Date.now(), Date.now(), Date.now()).all<Run>()).results;
  for (const run of runs) {
    await queue.send(message(run));
    // Allocate a strictly advancing dispatch timestamp in D1. A wall-clock tie or
    // overlapping Cron tick must not repeatedly rank the same UUIDs first.
    await db.prepare(`UPDATE provider_event_runs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', max(?, COALESCE(
      (SELECT max(updated_at) FROM provider_event_runs WHERE status = 'active' AND schedule_revision IS NOT NULL), '')), '+0.001 seconds')
      WHERE id = ? AND revision = ? AND status = 'active'`).bind(new Date().toISOString(), run.id, run.revision).run();
  }
  const cleaned = await db.prepare(`DELETE FROM provider_event_index WHERE rowid IN (SELECT i.rowid FROM provider_event_index i
    WHERE NOT EXISTS (SELECT 1 FROM provider_event_resources p WHERE p.connection_id = i.connection_id AND p.calendar_id = i.calendar_id AND p.active_generation = i.generation)
      AND NOT EXISTS (SELECT 1 FROM provider_event_runs r WHERE r.connection_id = i.connection_id AND r.calendar_id = i.calendar_id AND r.status = 'active'
        AND (r.generation = i.generation OR r.base_generation = i.generation)) LIMIT 500)`).run();
  await db.prepare(`DELETE FROM provider_event_pages WHERE run_id IN (SELECT id FROM provider_event_runs WHERE status != 'active' LIMIT 100)`).run();
  await db.prepare(`DELETE FROM provider_event_runs WHERE id IN (SELECT id FROM provider_event_runs WHERE status != 'active' AND updated_at < ? LIMIT 100)`)
    .bind(new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()).run();
  return { scheduled, enqueued: runs.length, expired: expired.meta.changes, cleaned: cleaned.meta.changes };
}
