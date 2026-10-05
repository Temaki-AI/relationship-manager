import { gmailAddress, gmailMessageFacts, readGmailChoices, type GmailDownloadRun, type GmailMessageFacts, type GmailSourceReview } from '@/packages/domain/src/gmail';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { fingerprintIdempotencyInput } from '@/lib/idempotency';
import { GoogleGmailError, googleGmailHistoryPage, googleGmailLabels, googleGmailMessageMetadata, googleGmailMessagesPage, googleGmailProfile } from './google-gmail';
import { googleConnectionAccess, providerWriteGuard, requireGoogleReconnection, requireProviderOwner, type ConnectionActor, type GoogleAccessGrant } from './provider-connections';
import { maintenanceGuard, removeGuard } from './recovery-storage';
import { ProviderConnectionError, providerDigest } from './provider-vault';
import { googleConfiguration, type ProviderEnvironment, type ProviderFetch } from './google-provider';
import type { D1PreparedStatement } from '@cloudflare/workers-types';

type DB = CloudflareEnv['DB'];
type Access = { id: string; email: string; dataset_epoch: string; authorization_revision: number };
type Resource = { connection_id: string; choices: string; settings_revision: number; active_generation: string | null; checkpoint: string | null;
  coverage: GmailSourceReview['coverage']; window_start: number | null; window_end: number | null; last_downloaded_at: string | null };
type Run = { id: string; connection_id: string; workspace_id: string; user_id: string; dataset_epoch: string; authorization_revision: number; settings_revision: number;
  fingerprint: string; generation: string; base_generation: string | null; mode: 'full' | 'incremental'; phase: string; status: string; window_start: number; window_end: number;
  history_start: string | null; history_checkpoint: string | null; label_position: number; next_page: string | null; pages: number; processed: number;
  limited: number; revision: number; failures: number; retry_at: number; issue: string | null; created_at: string };
class GmailRunFault extends ProviderConnectionError {
  constructor(readonly reason: 'mailbox_identity_changed' | 'download_expired' | 'history_limit') { super('This Gmail download needs a new reviewed scan. The previous context was kept.'); }
}
const resource = (db: DB, id: string) => db.prepare('SELECT * FROM provider_gmail_resources WHERE connection_id = ?').bind(id).first<Resource>();
const runFor = (db: DB, id: string) => db.prepare('SELECT * FROM provider_gmail_runs WHERE id = ?').bind(id).first<Run>();
function publicRun(run: Run): GmailDownloadRun { return { id: run.id, mode: run.mode, phase: run.phase, status: run.status, pages: run.pages, processed: run.processed, limited: Boolean(run.limited), retry_at: run.retry_at, issue: run.issue }; }
async function access(db: DB, actor: ConnectionActor, id: string) {
  await requireProviderOwner(db, actor);
  if (!isSyncUuid(id)) throw new ProviderConnectionError('Gmail connection not found.', 404);
  const row = await db.prepare(`SELECT c.id,c.email,c.dataset_epoch,c.authorization_revision FROM provider_connections c
    JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.purpose = 'gmail' AND c.status = 'connected'
      AND c.dataset_epoch = s.epoch AND s.paused = 0 AND w.lifecycle = 'active'
      AND (c.refresh_expires_at IS NULL OR c.refresh_expires_at > ?)`)
    .bind(id, actor.workspaceId, actor.userId, Date.now()).first<Access>();
  if (!row) throw new ProviderConnectionError('Reconnect and review this Gmail account before downloading.', 409);
  return row;
}
function owner(c: Access, actor: ConnectionActor) {
  return { condition: `EXISTS(SELECT 1 FROM provider_connections c JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id
    JOIN workspaces w ON w.id = c.workspace_id JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
    WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.purpose = 'gmail' AND c.status = 'connected'
      AND c.dataset_epoch = ? AND c.authorization_revision = ? AND s.epoch = c.dataset_epoch AND s.paused = 0
      AND w.lifecycle = 'active' AND m.role = 'owner' AND (c.refresh_expires_at IS NULL OR c.refresh_expires_at > ?))`,
  values: [c.id, actor.workspaceId, actor.userId, c.dataset_epoch, c.authorization_revision, Date.now()] };
}
// Matching shares the same owner/grant boundary without requesting provider data.
export { access as gmailSourceAccess, owner as gmailSourceOwner };
export async function reviewGmailSource(db: DB, actor: ConnectionActor, id: string): Promise<GmailSourceReview | null> {
  const c = await access(db, actor, id), r = await resource(db, id);
  if (!r) return null;
  const latest = await db.prepare("SELECT * FROM provider_gmail_runs WHERE connection_id = ? ORDER BY (status = 'active') DESC, created_at DESC, rowid DESC LIMIT 1").bind(id).first<Run>();
  const current = owner(c, actor), guard = crypto.randomUUID();
  await db.batch([maintenanceGuard(db, guard, current.condition + ' AND EXISTS(SELECT 1 FROM provider_gmail_resources WHERE connection_id = ? AND settings_revision = ? AND active_generation IS ?)',
    [...current.values, id, r.settings_revision, r.active_generation]), removeGuard(db, guard)]);
  return { settings_revision: r.settings_revision, choices: readGmailChoices(JSON.parse(r.choices), c.email), generation: r.active_generation,
    coverage: r.coverage, window_start: r.window_start, window_end: r.window_end, last_downloaded_at: r.last_downloaded_at, run: latest ? publicRun(latest) : null };
}
export async function saveGmailChoices(db: DB, actor: ConnectionActor, env: ProviderEnvironment, id: string, body: Record<string, unknown>, fetcher: ProviderFetch = fetch) {
  const c = await access(db, actor, id), r = await resource(db, id);
  if (Object.keys(body).sort().join(',') !== 'choices,expected_authorization_revision,expected_epoch,expected_settings_revision'
    || body.expected_epoch !== c.dataset_epoch || body.expected_authorization_revision !== c.authorization_revision
    || body.expected_settings_revision !== (r?.settings_revision ?? 0)) throw new ProviderConnectionError('Mailbox choices or authorization changed. Refresh before saving.');
  const choices = readGmailChoices(body.choices, c.email), encoded = JSON.stringify(choices);
  const grant = await googleConnectionAccess(db, actor, env, id, c.dataset_epoch, fetcher, 'gmail');
  if (grant.authorizationRevision !== c.authorization_revision) throw new ProviderConnectionError('Gmail authorization changed. Refresh before saving choices.');
  let labels; try { labels = await googleGmailLabels(grant.accessToken, fetcher); }
  catch (error) { if (error instanceof GoogleGmailError && error.reason === 'permission') await requireGoogleReconnection(db, grant); throw error; }
  if (choices.label_ids.some((selected) => !labels.some((label) => label.id === selected))) throw new ProviderConnectionError('A selected Gmail label is unavailable. Preview the current labels first.');
  const guard = crypto.randomUUID();
  await db.batch([providerWriteGuard(db, grant, guard), maintenanceGuard(db, guard + '-settings',
    r ? 'EXISTS(SELECT 1 FROM provider_gmail_resources WHERE connection_id = ? AND settings_revision = ?)' : 'NOT EXISTS(SELECT 1 FROM provider_gmail_resources WHERE connection_id = ?)',
    r ? [id, r.settings_revision] : [id]),
  ...(encoded === r?.choices ? [] : [db.prepare(`INSERT INTO provider_gmail_resources(connection_id,workspace_id,user_id,dataset_epoch,authorization_revision,choices)
    VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET choices = excluded.choices, settings_revision = provider_gmail_resources.settings_revision + 1`)
    .bind(id, actor.workspaceId, actor.userId, c.dataset_epoch, c.authorization_revision, encoded)]), removeGuard(db, guard), removeGuard(db, guard + '-settings')]);
  return reviewGmailSource(db, actor, id);
}
export async function startGmailDownload(db: DB, actor: ConnectionActor, env: ProviderEnvironment, id: string, body: Record<string, unknown>) {
  googleConfiguration(env, 'gmail'); const c = await access(db, actor, id), r = await resource(db, id);
  if (!r) throw new ProviderConnectionError('Save the reviewed labels and retention choices before downloading.');
  if (Object.keys(body).sort().join(',') !== 'expected_authorization_revision,expected_epoch,expected_settings_revision,mode,operation_id'
    || !isSyncUuid(body.operation_id) || typeof body.mode !== 'string' || !['full', 'incremental'].includes(body.mode) || body.expected_epoch !== c.dataset_epoch
    || body.expected_authorization_revision !== c.authorization_revision || body.expected_settings_revision !== r.settings_revision) throw new ProviderConnectionError('Review current mailbox choices before downloading.');
  const fingerprint = fingerprintIdempotencyInput(body), previous = await runFor(db, body.operation_id);
  if (previous) {
    if (previous.connection_id !== id || previous.workspace_id !== actor.workspaceId || previous.user_id !== actor.userId || previous.fingerprint !== fingerprint
      || previous.dataset_epoch !== c.dataset_epoch || previous.authorization_revision !== c.authorization_revision || previous.settings_revision !== r.settings_revision) throw new ProviderConnectionError('This download request belongs to different mailbox choices.');
    return publicRun(previous);
  }
  if (body.mode === 'incremental' && (!r.checkpoint || !r.active_generation)) throw new ProviderConnectionError('Complete a reviewed full scan before incremental refresh.');
  const choices = readGmailChoices(JSON.parse(r.choices), c.email), now = Date.now(), guard = crypto.randomUUID(), generation = crypto.randomUUID(), current = owner(c, actor);
  try { await db.batch([maintenanceGuard(db, guard, current.condition + ` AND EXISTS(SELECT 1 FROM provider_gmail_resources WHERE connection_id = ? AND settings_revision = ? AND active_generation IS ?)
    AND NOT EXISTS(SELECT 1 FROM provider_gmail_runs WHERE connection_id = ? AND status = 'active')`, [...current.values, id, r.settings_revision, r.active_generation, id]),
    db.prepare('DELETE FROM provider_gmail_index WHERE connection_id = ? AND generation IS NOT ?').bind(id, r.active_generation),
    db.prepare(`INSERT INTO provider_gmail_runs(id,connection_id,workspace_id,user_id,dataset_epoch,authorization_revision,settings_revision,fingerprint,generation,base_generation,mode,window_start,window_end,history_start,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(body.operation_id, id, actor.workspaceId, actor.userId, c.dataset_epoch, c.authorization_revision, r.settings_revision, fingerprint, generation, r.active_generation, body.mode, now - choices.past_days * 86400000, now, body.mode === 'incremental' ? r.checkpoint : null, new Date(now).toISOString(), new Date(now).toISOString()),
    db.prepare(`INSERT INTO provider_gmail_index(connection_id,generation,message_id,received_at,observed_at,facts)
      SELECT connection_id,?,message_id,received_at,observed_at,facts FROM provider_gmail_index WHERE connection_id = ? AND generation = ? AND received_at BETWEEN ? AND ?`)
      .bind(generation, id, r.active_generation ?? '', now - choices.past_days * 86400000, now), removeGuard(db, guard)]);
  } catch (error) { const replay = await runFor(db, body.operation_id); if (replay && replay.fingerprint === fingerprint && replay.connection_id === id && replay.workspace_id === actor.workspaceId && replay.user_id === actor.userId && replay.dataset_epoch === c.dataset_epoch && replay.authorization_revision === c.authorization_revision) return publicRun(replay); throw error; }
  return publicRun((await runFor(db, body.operation_id))!);
}
async function pendingCount(db: DB, run: Run, phase: string) {
  return (await db.prepare('SELECT COUNT(*) n FROM provider_gmail_pending WHERE run_id = ? AND phase = ?').bind(run.id, phase).first<{ n: number }>())!.n;
}
export async function advanceGmailDownload(db: DB, actor: ConnectionActor, env: ProviderEnvironment, id: string, runId: unknown, fetcher: ProviderFetch = fetch) {
  if (!isSyncUuid(runId)) throw new ProviderConnectionError('Choose the current Gmail download.');
  const run = await runFor(db, runId);
  if (!run || run.connection_id !== id || run.workspace_id !== actor.workspaceId || run.user_id !== actor.userId) throw new ProviderConnectionError('Gmail download not found.', 404);
  const c = await access(db, actor, id), r = await resource(db, id);
  if (!r || run.dataset_epoch !== c.dataset_epoch || run.authorization_revision !== c.authorization_revision || run.settings_revision !== r.settings_revision) throw new ProviderConnectionError('Gmail choices or authorization changed.');
  if (run.status !== 'active' || run.retry_at > Date.now()) return publicRun(run);
  const choices = readGmailChoices(JSON.parse(r.choices), c.email), lease = crypto.randomUUID(), current = owner(c, actor);
  const runCondition = `EXISTS(SELECT 1 FROM provider_gmail_resources WHERE connection_id = ? AND settings_revision = ? AND active_generation IS ?)`;
  const runValues = [id, run.settings_revision, run.base_generation];
  const claimed = await db.prepare(`UPDATE provider_gmail_runs SET lease_token = ?,lease_until = ? WHERE id = ? AND revision = ? AND status = 'active'
    AND (lease_token IS NULL OR lease_until < ?) AND ${current.condition} AND ${runCondition} RETURNING id`)
    .bind(lease, Date.now() + 150000, run.id, run.revision, Date.now(), ...current.values, ...runValues).first();
  if (!claimed) throw new ProviderConnectionError('This Gmail download is running or its choices changed.', 503);
  let usedGrant: GoogleAccessGrant | undefined;
  try {
    if (Date.now() - Date.parse(run.created_at) > 3600000) throw new GmailRunFault('download_expired');
    const grant = await googleConnectionAccess(db, actor, env, id, run.dataset_epoch, fetcher, 'gmail'), guard = crypto.randomUUID();
    usedGrant = grant;
    if (grant.authorizationRevision !== run.authorization_revision) throw new ProviderConnectionError('Gmail authorization changed. Review the account before downloading.');
    const statements: D1PreparedStatement[] = []; const updates: Record<string, string | number | null> = {};
    if (run.phase === 'profile') {
      const profile = await googleGmailProfile(grant.accessToken, fetcher);
      if (profile.email !== gmailAddress(c.email)) throw new GmailRunFault('mailbox_identity_changed');
      updates.history_start = run.history_start ?? profile.historyId; updates.phase = run.mode === 'incremental' ? 'history' : 'list';
    } else if (run.phase === 'list') {
      const page = await googleGmailMessagesPage(grant.accessToken, choices.label_ids[run.label_position], run.next_page, fetcher);
      const count = await pendingCount(db, run, 'list');
      const seen = new Set((await db.prepare("SELECT message_id FROM provider_gmail_pending WHERE run_id = ? AND phase = 'list'").bind(run.id).all<{ message_id: string }>()).results.map((row: { message_id: string }) => row.message_id));
      const fresh = page.messages.filter((message) => !seen.has(message.id)), accepted = fresh.slice(0, choices.scan_limit - count);
      updates.limited = Number(fresh.length > accepted.length || count + accepted.length >= choices.scan_limit && (page.next !== null || run.label_position < choices.label_ids.length - 1));
      for (const message of accepted) statements.push(db.prepare("INSERT INTO provider_gmail_pending(run_id,message_id,phase) VALUES(?,?,'list')").bind(run.id, message.id));
      updates.phase = 'metadata'; updates.next_page = page.next; updates.pages = run.pages + 1;
      if (page.next) {
        const hash = await providerDigest(page.next);
        if (await db.prepare('SELECT 1 FROM provider_gmail_pages WHERE run_id = ? AND phase = ? AND token_hash = ?').bind(run.id, 'list-' + run.label_position, hash).first()) throw new GoogleGmailError('invalid');
        statements.push(db.prepare('INSERT INTO provider_gmail_pages(run_id,phase,token_hash) VALUES(?,?,?)').bind(run.id, 'list-' + run.label_position, hash));
      }
    } else if (run.phase === 'history') {
      const page = await googleGmailHistoryPage(grant.accessToken, run.history_start!, run.next_page, fetcher);
      if (run.history_checkpoint && BigInt(page.historyId) < BigInt(run.history_checkpoint)) throw new GoogleGmailError('invalid');
      const existing = new Set((await db.prepare("SELECT message_id FROM provider_gmail_pending WHERE run_id = ? AND phase = 'history'").bind(run.id).all<{ message_id: string }>()).results.map((row: { message_id: string }) => row.message_id));
      const changes = [...new Set(page.changes.map((change) => change.messageId))].filter((message) => !existing.has(message));
      if (existing.size + changes.length > choices.scan_limit) throw new GmailRunFault('history_limit');
      for (const message of changes) statements.push(db.prepare("INSERT INTO provider_gmail_pending(run_id,message_id,phase) VALUES(?,?,'history')").bind(run.id, message));
      updates.phase = page.next ? 'history' : 'history_metadata'; updates.next_page = page.next; updates.history_checkpoint = page.historyId; updates.pages = run.pages + 1;
      if (page.next) {
        const hash = await providerDigest(page.next);
        if (await db.prepare("SELECT 1 FROM provider_gmail_pages WHERE run_id = ? AND phase = 'history' AND token_hash = ?").bind(run.id, hash).first()) throw new GoogleGmailError('invalid');
        statements.push(db.prepare("INSERT INTO provider_gmail_pages(run_id,phase,token_hash) VALUES(?,'history',?)").bind(run.id, hash));
      }
    } else if (run.phase === 'metadata' || run.phase === 'history_metadata') {
      const phase = run.phase === 'metadata' ? 'list' : 'history';
      const pending = (await db.prepare('SELECT message_id FROM provider_gmail_pending WHERE run_id = ? AND phase = ? AND done = 0 ORDER BY message_id LIMIT 10').bind(run.id, phase).all<{ message_id: string }>()).results as Array<{ message_id: string }>;
      const results = await Promise.all(pending.map(async (item) => {
        try { const metadata = await googleGmailMessageMetadata(grant.accessToken, item.message_id, choices.retain_subject, fetcher); return { id: item.message_id, facts: gmailMessageFacts(metadata, choices, run.window_start, Date.now()) }; }
        catch (error) { if (error instanceof GoogleGmailError && error.reason === 'missing') return { id: item.message_id, facts: null }; throw error; }
      }));
      for (const result of results) {
        statements.push(db.prepare('DELETE FROM provider_gmail_index WHERE connection_id = ? AND generation = ? AND message_id = ?').bind(id, run.generation, result.id));
        if (result.facts) statements.push(db.prepare('INSERT INTO provider_gmail_index(connection_id,generation,message_id,received_at,observed_at,facts) VALUES(?,?,?,?,?,?)').bind(id, run.generation, result.id, result.facts.received_at, Date.now(), JSON.stringify(result.facts)));
        statements.push(db.prepare('UPDATE provider_gmail_pending SET done = 1 WHERE run_id = ? AND phase = ? AND message_id = ?').bind(run.id, phase, result.id));
      }
      updates.processed = run.processed + results.length;
      const remaining = (await db.prepare('SELECT COUNT(*) n FROM provider_gmail_pending WHERE run_id = ? AND phase = ? AND done = 0').bind(run.id, phase).first<{ n: number }>())!.n;
      if (remaining === results.length) {
        if (phase === 'history') updates.phase = 'publish';
        else if (run.limited || run.next_page === null && run.label_position === choices.label_ids.length - 1) { updates.phase = 'history'; updates.next_page = null; }
        else { updates.phase = 'list'; if (run.next_page === null) updates.label_position = run.label_position + 1; }
      }
    } else if (run.phase === 'publish') {
      if (!run.history_checkpoint) throw new GoogleGmailError('invalid');
      const publishedEnd = Date.now(), publishedStart = publishedEnd - choices.past_days * 86400000;
      const count = (await db.prepare(`SELECT COUNT(*) n FROM provider_gmail_index WHERE connection_id = ? AND generation = ? AND received_at BETWEEN ? AND ?
        AND (? = 1 OR message_id IN(SELECT message_id FROM provider_gmail_pending WHERE run_id = ?))`)
        .bind(id, run.generation, publishedStart, publishedEnd, run.mode === 'full' && !run.limited ? 0 : 1, run.id).first<{ n: number }>())!.n;
      const limited = Boolean(run.limited || count > choices.scan_limit || run.mode === 'incremental' && r.coverage === 'limited');
      if (run.mode === 'full' && !run.limited) statements.push(db.prepare('DELETE FROM provider_gmail_index WHERE connection_id = ? AND generation = ? AND message_id NOT IN(SELECT message_id FROM provider_gmail_pending WHERE run_id = ?)').bind(id, run.generation, run.id));
      statements.push(db.prepare('DELETE FROM provider_gmail_index WHERE connection_id = ? AND generation = ? AND (received_at < ? OR received_at > ?)').bind(id, run.generation, publishedStart, publishedEnd));
      statements.push(db.prepare(`DELETE FROM provider_gmail_index WHERE connection_id = ? AND generation = ? AND message_id NOT IN(
        SELECT message_id FROM provider_gmail_index WHERE connection_id = ? AND generation = ? ORDER BY received_at DESC,message_id DESC LIMIT ?)`)
        .bind(id, run.generation, id, run.generation, choices.scan_limit));
      statements.push(db.prepare('UPDATE provider_gmail_resources SET active_generation = ?,checkpoint = ?,coverage = ?,window_start = ?,window_end = ?,last_downloaded_at = ? WHERE connection_id = ?')
        .bind(run.generation, run.history_checkpoint, limited ? 'limited' : 'scanned', publishedStart, publishedEnd, new Date().toISOString(), id));
      statements.push(db.prepare('DELETE FROM provider_gmail_index WHERE connection_id = ? AND generation != ?').bind(id, run.generation));
      statements.push(db.prepare('DELETE FROM provider_gmail_pending WHERE run_id = ?').bind(run.id), db.prepare('DELETE FROM provider_gmail_pages WHERE run_id = ?').bind(run.id));
      updates.status = 'complete'; updates.limited = Number(limited);
    } else throw new GoogleGmailError('invalid');
    if ((updates.pages ?? run.pages) as number > 200 || (updates.processed ?? run.processed) as number > 20000) throw new GoogleGmailError('invalid');
    if (Date.now() - Date.parse(run.created_at) > 3600000) throw new GmailRunFault('download_expired');
    updates.window_end = Math.max(run.window_end, Date.now());
    const entries = Object.entries(updates);
    await db.batch([providerWriteGuard(db, grant, guard), maintenanceGuard(db, guard + '-run', current.condition + ' AND ' + runCondition + ` AND EXISTS(SELECT 1 FROM provider_gmail_runs WHERE id = ? AND revision = ? AND lease_token = ? AND lease_until >= ? AND status = 'active')`,
      [...current.values, ...runValues, run.id, run.revision, lease, Date.now()]),
      db.prepare('UPDATE provider_gmail_runs SET window_end = ? WHERE id = ?').bind(updates.window_end, run.id), ...statements,
      db.prepare('UPDATE provider_gmail_runs SET ' + entries.map(([key]) => key + ' = ?').join(',') + ', revision = revision + 1,failures = 0,retry_at = 0,issue = NULL,lease_token = NULL,lease_until = NULL,updated_at = ? WHERE id = ?')
        .bind(...entries.map(([, value]) => value), new Date().toISOString(), run.id), removeGuard(db, guard), removeGuard(db, guard + '-run')]);
    return publicRun((await runFor(db, run.id))!);
  } catch (error) {
    if (error instanceof GoogleGmailError && error.reason === 'permission') {
      // A late failure from an older token must not invalidate a newer grant.
      if (usedGrant) await requireGoogleReconnection(db, usedGrant);
      throw error;
    }
    if (error instanceof GoogleGmailError || error instanceof GmailRunFault || /PROVIDER_GMAIL_INVALID|provider_gmail_pages/u.test(String(error))) {
      const retry = error instanceof GoogleGmailError && error.reason === 'retry' && run.failures < 8, guard = crypto.randomUUID();
      await db.batch([maintenanceGuard(db, guard, current.condition + ` AND EXISTS(SELECT 1 FROM provider_gmail_runs WHERE id = ? AND revision = ? AND lease_token = ? AND status = 'active')`, [...current.values, run.id, run.revision, lease]),
        db.prepare('UPDATE provider_gmail_runs SET status = ?,revision = revision + 1,failures = failures + 1,retry_at = ?,issue = ?,lease_token = NULL,lease_until = NULL,updated_at = ? WHERE id = ?')
          .bind(retry ? 'active' : 'failed', retry ? Date.now() + (error instanceof GoogleGmailError ? error.retryAfter : 30) * 1000 : 0,
            retry ? 'provider_retry' : error instanceof GmailRunFault ? error.reason : error instanceof GoogleGmailError && error.reason === 'history_expired' ? 'history_repair_required' : 'unsupported_or_over_limit', new Date().toISOString(), run.id),
        ...(retry ? [] : [db.prepare('DELETE FROM provider_gmail_index WHERE connection_id = ? AND generation = ?').bind(id, run.generation), db.prepare('DELETE FROM provider_gmail_pending WHERE run_id = ?').bind(run.id), db.prepare('DELETE FROM provider_gmail_pages WHERE run_id = ?').bind(run.id)]), removeGuard(db, guard)]);
      return publicRun((await runFor(db, run.id))!);
    }
    throw error;
  } finally { await db.prepare('UPDATE provider_gmail_runs SET lease_token = NULL,lease_until = NULL WHERE id = ? AND lease_token = ?').bind(run.id, lease).run(); }
}
export async function cancelGmailDownload(db: DB, actor: ConnectionActor, id: string, runId: unknown) {
  if (!isSyncUuid(runId)) throw new ProviderConnectionError('Choose the current Gmail download.');
  const c = await access(db, actor, id), run = await runFor(db, runId);
  if (!run || run.connection_id !== id || run.workspace_id !== actor.workspaceId || run.user_id !== actor.userId || run.dataset_epoch !== c.dataset_epoch || run.authorization_revision !== c.authorization_revision) throw new ProviderConnectionError('Gmail download not found.', 404);
  if (run.status !== 'active') return publicRun(run);
  const current = owner(c, actor), guard = crypto.randomUUID();
  await db.batch([maintenanceGuard(db, guard, current.condition + " AND EXISTS(SELECT 1 FROM provider_gmail_runs WHERE id = ? AND revision = ? AND status = 'active')", [...current.values, run.id, run.revision]),
    db.prepare("UPDATE provider_gmail_runs SET status = 'cancelled',revision = revision + 1,lease_token = NULL,lease_until = NULL,updated_at = ? WHERE id = ? AND status = 'active'").bind(new Date().toISOString(), run.id),
    db.prepare('DELETE FROM provider_gmail_index WHERE connection_id = ? AND generation = ?').bind(id, run.generation), db.prepare('DELETE FROM provider_gmail_pending WHERE run_id = ?').bind(run.id),
    db.prepare('DELETE FROM provider_gmail_pages WHERE run_id = ?').bind(run.id), removeGuard(db, guard)]);
  return publicRun((await runFor(db, run.id))!);
}
export async function reviewGmailMessages(db: DB, actor: ConnectionActor, id: string, query: URLSearchParams) {
  const c = await access(db, actor, id), r = await resource(db, id); let after: [number, string] | null = null;
  if ([...query.keys()].some((key) => !['generation','after'].includes(key)) || [...query.keys()].some((key) => query.getAll(key).length !== 1)
    || (query.get('after')?.length ?? 0) > 1024) throw new ProviderConnectionError('Use the current Gmail message page.', 400);
  if (query.has('generation') && query.get('generation') !== r?.active_generation) throw new ProviderConnectionError('Gmail messages changed. Start from the first page.');
  if (query.has('after')) {
    try { const parsed = JSON.parse(query.get('after')!); if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || typeof parsed[1] !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(parsed[1])) throw new Error(); after = parsed as [number, string]; }
    catch { throw new ProviderConnectionError('Start from the first Gmail message page.', 400); }
    if (query.get('generation') !== r?.active_generation) throw new ProviderConnectionError('Gmail messages changed. Start from the first page.');
  }
  const earliest = Date.now() - (r ? readGmailChoices(JSON.parse(r.choices), c.email).past_days : 90) * 86400000;
  const rows = (await db.prepare(`SELECT message_id,received_at,observed_at,facts FROM provider_gmail_index WHERE connection_id = ? AND generation = ? AND received_at >= ?
    AND (? IS NULL OR (received_at,message_id) < (?,?)) ORDER BY received_at DESC,message_id DESC LIMIT 51`)
    .bind(id, r?.active_generation ?? '', earliest, after?.[0] ?? null, after?.[0] ?? 0, after?.[1] ?? '').all<{ message_id: string; received_at: number; observed_at: number; facts: string }>()).results as Array<{ message_id: string; received_at: number; observed_at: number; facts: string }>;
  const current = owner(c, actor), guard = crypto.randomUUID();
  await db.batch([maintenanceGuard(db, guard, current.condition + (r ? ' AND EXISTS(SELECT 1 FROM provider_gmail_resources WHERE connection_id = ? AND settings_revision = ? AND active_generation IS ?)' : ' AND NOT EXISTS(SELECT 1 FROM provider_gmail_resources WHERE connection_id = ?)'),
    [...current.values, id, ...(r ? [r.settings_revision, r.active_generation] : [])]), removeGuard(db, guard)]);
  const page = rows.slice(0, 50), last = page.at(-1);
  return { generation: r?.active_generation ?? null, coverage: r?.coverage ?? 'none', more: rows.length > 50,
    next: rows.length > 50 && last ? JSON.stringify([last.received_at, last.message_id]) : null,
    messages: page.map((row) => ({ facts: JSON.parse(row.facts) as GmailMessageFacts, observed_at: row.observed_at })) };
}

/** Privacy maintenance needs no provider grant and never reads Gmail. */
export async function pruneGmailCache(db: DB, now = Date.now()) {
  await db.batch([
    db.prepare(`UPDATE provider_gmail_runs SET status = 'failed',issue = 'download_expired',revision = revision + 1,lease_token = NULL,lease_until = NULL,updated_at = ?
      WHERE status = 'active' AND created_at < ?`).bind(new Date(now).toISOString(), new Date(now - 3600000).toISOString()),
    db.prepare(`DELETE FROM provider_gmail_index WHERE (connection_id,generation) IN(SELECT connection_id,generation FROM provider_gmail_runs WHERE status = 'failed' AND issue = 'download_expired')
      OR received_at < ? - 86400000 * (SELECT json_extract(r.choices,'$.past_days') FROM provider_gmail_resources r WHERE r.connection_id = provider_gmail_index.connection_id)`).bind(now),
    db.prepare("DELETE FROM provider_gmail_pending WHERE run_id IN(SELECT id FROM provider_gmail_runs WHERE status = 'failed' AND issue = 'download_expired')"),
    db.prepare("DELETE FROM provider_gmail_pages WHERE run_id IN(SELECT id FROM provider_gmail_runs WHERE status = 'failed' AND issue = 'download_expired')"),
    db.prepare(`DELETE FROM provider_gmail_runs WHERE status != 'active' AND updated_at < ? AND NOT EXISTS(SELECT 1 FROM provider_gmail_resources r
      WHERE r.connection_id = provider_gmail_runs.connection_id AND r.active_generation = provider_gmail_runs.generation)`).bind(new Date(now - 7 * 86400000).toISOString()),
    db.prepare(`UPDATE provider_gmail_matching SET revision=revision+1 WHERE
      EXISTS(SELECT 1 FROM provider_gmail_match_rules rule WHERE rule.connection_id=provider_gmail_matching.connection_id
        AND NOT EXISTS(SELECT 1 FROM provider_gmail_participants p JOIN provider_gmail_resources r ON r.connection_id=p.connection_id
          WHERE p.connection_id=rule.connection_id AND p.generation=r.active_generation AND p.email=rule.email))
      OR EXISTS(SELECT 1 FROM provider_gmail_match_receipts receipt WHERE receipt.connection_id=provider_gmail_matching.connection_id
        AND NOT EXISTS(SELECT 1 FROM provider_gmail_participants p JOIN provider_gmail_resources r ON r.connection_id=p.connection_id
          WHERE p.connection_id=receipt.connection_id AND p.generation=r.active_generation AND p.email=receipt.email))`),
    db.prepare(`DELETE FROM provider_gmail_match_rules WHERE NOT EXISTS(SELECT 1 FROM provider_gmail_participants p
      JOIN provider_gmail_resources r ON r.connection_id=p.connection_id WHERE p.connection_id=provider_gmail_match_rules.connection_id
        AND p.generation=r.active_generation AND p.email=provider_gmail_match_rules.email)`),
    db.prepare(`DELETE FROM provider_gmail_match_receipts WHERE NOT EXISTS(SELECT 1 FROM provider_gmail_participants p
      JOIN provider_gmail_resources r ON r.connection_id=p.connection_id WHERE p.connection_id=provider_gmail_match_receipts.connection_id
        AND p.generation=r.active_generation AND p.email=provider_gmail_match_receipts.email)`),
  ]);
}
