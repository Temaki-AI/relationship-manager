import { isSyncUuid } from '@/packages/domain/src/sync';
import { advanceGmailDownload, startGmailDownload } from './google-gmail-downloads';
import type { ProviderEnvironment, ProviderFetch } from './google-provider';
import { ProviderConnectionError } from './provider-vault';

type DB = CloudflareEnv['DB'];
export type GmailQueueMessage = { kind: 'google-gmail'; version: 1; workspaceId: string; connectionId: string; runId: string };
export type GmailQueue = { send(body: GmailQueueMessage): Promise<unknown> };
type Run = { id: string; connection_id: string; workspace_id: string; user_id: string; status: string; revision: number; retry_at: number };
const message = (run: Run): GmailQueueMessage => ({ kind: 'google-gmail', version: 1, workspaceId: run.workspace_id, connectionId: run.connection_id, runId: run.id });
const eligible = `EXISTS(SELECT 1 FROM provider_gmail_resources p JOIN provider_connections c ON c.id=p.connection_id
  JOIN workspace_sync_state s ON s.workspace_id=c.workspace_id JOIN workspaces w ON w.id=c.workspace_id
  JOIN workspace_members m ON m.workspace_id=c.workspace_id AND m.user_id=c.user_id
  WHERE c.id=r.connection_id AND c.workspace_id=r.workspace_id AND c.user_id=r.user_id AND c.purpose='gmail' AND c.status='connected'
    AND c.authorization_revision=r.authorization_revision AND c.dataset_epoch=r.dataset_epoch AND s.epoch=r.dataset_epoch
    AND s.paused=0 AND w.lifecycle='active' AND m.role='owner' AND (c.refresh_expires_at IS NULL OR c.refresh_expires_at>?)
    AND p.dataset_epoch=r.dataset_epoch AND p.authorization_revision=r.authorization_revision AND p.settings_revision=r.settings_revision
    AND p.active_generation IS r.base_generation AND p.sync_enabled=1 AND p.sync_revision=r.schedule_revision)`;

export function readGmailQueueMessage(raw: unknown): GmailQueueMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  return Object.keys(v).sort().join(',') === 'connectionId,kind,runId,version,workspaceId' && v.kind === 'google-gmail' && v.version === 1
    && typeof v.workspaceId === 'string' && v.workspaceId.length > 0 && v.workspaceId.length <= 128 && isSyncUuid(v.connectionId) && isSyncUuid(v.runId)
    ? { kind: 'google-gmail', version: 1, workspaceId: v.workspaceId, connectionId: v.connectionId, runId: v.runId } : null;
}

export async function startDueGmailDownloads(db: DB, env: ProviderEnvironment) {
  const now = Date.now();
  const rows = (await db.prepare(`SELECT p.*,c.user_id,c.dataset_epoch,c.authorization_revision FROM provider_gmail_resources p
    JOIN provider_connections c ON c.id=p.connection_id JOIN workspace_sync_state s ON s.workspace_id=p.workspace_id
    JOIN workspaces w ON w.id=p.workspace_id JOIN workspace_members m ON m.workspace_id=p.workspace_id AND m.user_id=c.user_id
    WHERE p.sync_enabled=1 AND p.next_sync_at<=? AND c.purpose='gmail' AND c.status='connected' AND m.role='owner'
      AND s.paused=0 AND w.lifecycle='active' AND c.dataset_epoch=s.epoch AND p.dataset_epoch=s.epoch AND p.user_id=c.user_id
      AND p.authorization_revision=c.authorization_revision AND (c.refresh_expires_at IS NULL OR c.refresh_expires_at>?)
      AND NOT EXISTS(SELECT 1 FROM provider_gmail_runs r WHERE r.connection_id=c.id AND r.status='active')
    ORDER BY p.next_sync_at,p.connection_id LIMIT 5`).bind(now, now).all<{
      connection_id: string; workspace_id: string; user_id: string; dataset_epoch: string; authorization_revision: number;
      settings_revision: number; sync_revision: number; next_sync_at: number; repair_required: number; checkpoint: string | null; active_generation: string | null;
    }>()).results;
  let scheduled = 0;
  for (const row of rows) {
    try {
      await startGmailDownload(db, { workspaceId: row.workspace_id, userId: row.user_id, authMethod: 'web' }, env, row.connection_id,
        { operation_id: crypto.randomUUID(), mode: !row.repair_required && row.checkpoint && row.active_generation ? 'incremental' : 'full',
          expected_epoch: row.dataset_epoch, expected_authorization_revision: row.authorization_revision, expected_settings_revision: row.settings_revision },
        { revision: row.sync_revision, due: row.next_sync_at });
      scheduled++;
    } catch (error) {
      if (!(error instanceof ProviderConnectionError) && !/CLOUD_RECOVERY_CONFLICT|provider_gmail_one_active_run/u.test(String(error))) throw error;
    }
  }
  return scheduled;
}

export async function processGmailMessage(delivery: { body: unknown; attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void }, env: CloudflareEnv, fetcher: ProviderFetch = fetch) {
  const input = readGmailQueueMessage(delivery.body);
  if (!input) { delivery.ack(); return; }
  const run = await env.DB.prepare(`SELECT r.* FROM provider_gmail_runs r WHERE r.id=? AND r.workspace_id=? AND r.connection_id=?
    AND r.status='active' AND r.schedule_revision IS NOT NULL AND ${eligible}`)
    .bind(input.runId, input.workspaceId, input.connectionId, Date.now()).first<Run>();
  if (!run) { delivery.ack(); return; }
  const wait = (at: number) => delivery.retry({ delaySeconds: Math.max(2, Math.min(900, Math.ceil((at - Date.now()) / 1000))) });
  if (run.retry_at > Date.now()) { wait(run.retry_at); return; }
  try {
    const result = await advanceGmailDownload(env.DB, { workspaceId: run.workspace_id, userId: run.user_id, authMethod: 'web' },
      { ...process.env, ...env } as unknown as ProviderEnvironment, run.connection_id, run.id, fetcher);
    if (result.status !== 'active') { delivery.ack(); return; }
    if (result.retry_at > Date.now()) { wait(result.retry_at); return; }
    // Publication of the checkpoint precedes this send. Cron repairs send outages;
    // duplicate delivery still has to claim the current run revision and lease.
    await env.GOOGLE_GMAIL_QUEUE.send(input); delivery.ack();
  } catch (error) {
    const current = await env.DB.prepare(`SELECT r.id FROM provider_gmail_runs r WHERE r.id=? AND r.status='active' AND ${eligible}`).bind(run.id, Date.now()).first();
    if (!current) { delivery.ack(); return; }
    if (error instanceof ProviderConnectionError && error.status === 503) { delivery.retry({ delaySeconds: 30 }); return; }
    throw error;
  }
}

export async function reconcileGmailDownloads(db: DB, queue: GmailQueue, env: ProviderEnvironment) {
  const expired = await db.prepare(`UPDATE provider_gmail_runs AS r SET status='failed',issue='download_expired',revision=revision+1,
    lease_token=NULL,lease_until=NULL,updated_at=? WHERE r.id IN(SELECT r.id FROM provider_gmail_runs r
      WHERE r.status='active' AND r.schedule_revision IS NOT NULL AND (r.created_at<? OR NOT ${eligible})
        AND (r.lease_token IS NULL OR r.lease_until<?) ORDER BY r.created_at,r.id LIMIT 20)`)
    .bind(new Date().toISOString(), new Date(Date.now() - 3600000).toISOString(), Date.now(), Date.now()).run();
  const scheduled = await startDueGmailDownloads(db, env);
  const runs = (await db.prepare(`SELECT r.* FROM provider_gmail_runs r WHERE r.status='active' AND r.schedule_revision IS NOT NULL
    AND r.retry_at<=? AND (r.lease_token IS NULL OR r.lease_until<?) AND ${eligible} ORDER BY r.updated_at,r.id LIMIT 5`)
    .bind(Date.now(), Date.now(), Date.now()).all<Run>()).results;
  for (const run of runs) {
    await queue.send(message(run));
    await db.prepare(`UPDATE provider_gmail_runs SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ',max(?,COALESCE(
      (SELECT max(updated_at) FROM provider_gmail_runs WHERE status='active' AND schedule_revision IS NOT NULL),'')),'+0.001 seconds')
      WHERE id=? AND revision=? AND status='active'`).bind(new Date().toISOString(), run.id, run.revision).run();
  }
  return { scheduled, enqueued: runs.length, expired: expired.meta.changes };
}
