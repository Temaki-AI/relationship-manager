import type { SQLiteDatabase } from 'expo-sqlite';
import { accountScope, type NativeAccount } from '../../../../packages/domain/src/devices';
import { GMAIL_CONTEXT_MAX_BYTES, readGmailContextManifest, readGmailContextPage, type GmailContextManifest, type GmailContextMessage } from '../../../../packages/domain/src/gmail-context';

type State = { enabled: number; revision: number; manifest: string | null; checked_at: number | null };
type Cached = { scope: string; messages: string; next: string | null; checked_at: number };
type Options = { fetcher?: typeof fetch; isCurrent?: () => boolean };
export class GmailContextError extends Error { constructor(message: string, readonly status = 0) { super(message); } }
const stateFor = (db: SQLiteDatabase) => db.getFirstAsync<State>('SELECT * FROM gmail_context_state WHERE id=1');
const changed = () => new GmailContextError('Email context changed. Refresh when contact changes have synced.');
async function epoch(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key='sync-cursor-v4'");
  return row ? (JSON.parse(row.value) as { epoch: string }).epoch : null;
}
async function pendingIdentity(db: SQLiteDatabase) {
  return Boolean(await db.getFirstAsync(`SELECT 1 FROM sync_queue WHERE entity_type='contact' AND
    (operation IN('create','delete') OR json_type(payload,'$.email') IS NOT NULL OR json_type(payload,'$.contact_methods') IS NOT NULL) LIMIT 1`));
}
async function accountGuard(db: SQLiteDatabase, account: NativeAccount, isCurrent: () => boolean) {
  const binding = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key='account-scope'");
  if (!isCurrent() || binding?.value !== accountScope(account)) throw changed();
}
async function guard(db: SQLiteDatabase, account: NativeAccount, revision: number, isCurrent: () => boolean) {
  await accountGuard(db, account, isCurrent);
  const state = await stateFor(db);
  if (!state?.enabled || state.revision !== revision || await pendingIdentity(db)) throw changed();
  return state;
}
export async function clearGmailContext(db: SQLiteDatabase, disable = false) {
  await db.withExclusiveTransactionAsync(async (tx) => { await discardGmailContext(tx, disable); });
}
async function discardGmailContext(db: SQLiteDatabase, disable: boolean) {
  await db.runAsync('DELETE FROM gmail_person_context');
  await db.runAsync('UPDATE gmail_context_state SET revision=revision+1,manifest=NULL,checked_at=NULL,enabled=CASE WHEN ? THEN 0 ELSE enabled END WHERE id=1', disable ? 1 : 0);
}
export async function discardGmailContextForEpoch(db: SQLiteDatabase, nextEpoch: string) {
  const state = await stateFor(db);
  if (state?.manifest && readGmailContextManifest(JSON.parse(state.manifest)).epoch !== nextEpoch) await discardGmailContext(db, false);
}
export async function setGmailContextEnabled(db: SQLiteDatabase, account: NativeAccount, enabled: boolean) {
  await db.withExclusiveTransactionAsync(async (tx) => {
    await accountGuard(tx, account, () => true); await discardGmailContext(tx, false);
    await tx.runAsync('UPDATE gmail_context_state SET enabled=? WHERE id=1', enabled ? 1 : 0);
  });
}
async function request(account: NativeAccount, query: URLSearchParams, fetcher: typeof fetch, isCurrent: () => boolean) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
  try {
    if (!isCurrent()) throw changed();
    const response = await fetcher(`${account.origin}/api/v1/gmail-context${query.size ? '?' + query : ''}`, { method: 'GET', credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${account.token}` }, signal: controller.signal });
    if (!isCurrent()) throw changed();
    if (!response.ok) throw new GmailContextError(response.status === 401 ? 'Sign in again to refresh email context.' : response.status === 404 || response.status === 501 ? 'Email context is not available on this server yet.' : 'Could not refresh reviewed email context.', response.status);
    const text = await response.text();
    // Bound actual UTF-8 bytes as well as the decoded string; do not parse an
    // oversized payload into the account cache.
    let bytes = 0; for (const c of text) { const p = c.codePointAt(0)!; bytes += p < 128 ? 1 : p < 2048 ? 2 : p < 65536 ? 3 : 4; }
    if (bytes > GMAIL_CONTEXT_MAX_BYTES || !isCurrent()) throw new GmailContextError('This email page is too large or no longer current.');
    try { return JSON.parse(text) as unknown; } catch { throw new GmailContextError('Invalid reviewed email response.', 409); }
  } finally { clearTimeout(timeout); }
}
function decode<T>(reader: () => T): T {
  try { return reader(); } catch { throw new GmailContextError('Invalid reviewed email response. Refresh the review.', 409); }
}
async function pruneRetainedMessages(db: SQLiteDatabase, manifest: ReturnType<typeof readGmailContextManifest>) {
  for (const source of manifest.sources) await db.runAsync(`UPDATE gmail_person_context SET messages=COALESCE(
    (SELECT json_group_array(json(value)) FROM json_each(messages) WHERE json_extract(value,'$.received_at')>=?),'[]') WHERE source_id=?`, Date.now() - source.past_days * 86400000, source.id);
}
async function handleFailure(db: SQLiteDatabase, error: unknown, revision: number, isCurrent: () => boolean) {
  if (isCurrent() && error instanceof GmailContextError && [401, 403, 404, 409, 413, 423, 501].includes(error.status)) {
    await db.withExclusiveTransactionAsync(async (tx) => { if (isCurrent() && (await stateFor(tx))?.revision === revision) await discardGmailContext(tx, false); });
  }
}
export async function refreshGmailManifest(db: SQLiteDatabase, account: NativeAccount, options: Options = {}) {
  const isCurrent = options.isCurrent ?? (() => true), fetcher = options.fetcher ?? fetch, state = await stateFor(db);
  if (!state?.enabled) return;
  await guard(db, account, state.revision, isCurrent);
  try {
    const raw = await request(account, new URLSearchParams(), fetcher, isCurrent), manifest = decode(() => readGmailContextManifest(raw));
    if (manifest.valid_until <= Date.now() || manifest.valid_until > Date.now() + 86400000 + 60000) throw changed();
    await db.withExclusiveTransactionAsync(async (tx) => {
      const fresh = await guard(tx, account, state.revision, isCurrent);
      if (manifest.epoch !== await epoch(tx)) { await discardGmailContext(tx, false); return; }
      const previous = fresh.manifest ? readGmailContextManifest(JSON.parse(fresh.manifest)) : null;
      if (!previous || previous.scope !== manifest.scope || !manifest.directory_ready) await tx.runAsync('DELETE FROM gmail_person_context');
      await pruneRetainedMessages(tx, manifest);
      await tx.runAsync('UPDATE gmail_context_state SET manifest=?,checked_at=?,revision=revision+? WHERE id=1', JSON.stringify(manifest), Date.now(), previous?.scope !== manifest.scope ? 1 : 0);
    });
  } catch (error) { await handleFailure(db, error, state.revision, isCurrent); throw error; }
}
export type NativeGmailContext = { enabled: boolean; manifest: GmailContextManifest | null; preparing: boolean; pendingIdentity: boolean; messages: GmailContextMessage[]; next: string | null; checkedAt: number | null; cached: boolean; limitReached: boolean };
export async function readGmailContext(db: SQLiteDatabase, account: NativeAccount, sourceId?: string, personId?: string): Promise<NativeGmailContext> {
  await accountGuard(db, account, () => true);
  const state = (await stateFor(db))!;
  const manifest = state.manifest ? readGmailContextManifest(JSON.parse(state.manifest)) : null;
  if (manifest && (manifest.valid_until <= Date.now() || Date.parse(account.expiresAt) <= Date.now())) { await clearGmailContext(db); return readGmailContext(db, account, sourceId, personId); }
  const pending = await pendingIdentity(db);
  const usable = Boolean(state.enabled && manifest?.directory_ready && manifest.valid_until > Date.now() && manifest.epoch === await epoch(db) && Date.parse(account.expiresAt) > Date.now() && !pending);
  const row = usable && sourceId && personId ? await db.getFirstAsync<Cached>('SELECT * FROM gmail_person_context WHERE source_id=? AND person_id=? AND scope=?', sourceId, personId, manifest!.scope) : null;
  const source = usable ? manifest!.sources.find((source) => source.id === sourceId) : undefined;
  const messages: GmailContextMessage[] = row && source ? (JSON.parse(row.messages) as GmailContextMessage[]).filter((message) => message.received_at >= Date.now() - source.past_days * 86400000) : [];
  await accountGuard(db, account, () => true);
  const unchanged = (await stateFor(db))?.revision === state.revision;
  return { enabled: Boolean(state.enabled), manifest: usable && unchanged ? manifest : null, preparing: Boolean(unchanged && state.enabled && manifest && !manifest.directory_ready && manifest.valid_until > Date.now()), pendingIdentity: pending, messages: unchanged ? messages : [], next: unchanged ? row?.next ?? null : null, checkedAt: unchanged ? row?.checked_at ?? null : null, cached: unchanged && Boolean(row), limitReached: Boolean(unchanged && row && JSON.parse(row.messages).length >= 500) };
}
export async function refreshGmailPerson(db: SQLiteDatabase, account: NativeAccount, sourceId: string, personId: string, after: string | null = null, options: Options = {}) {
  const isCurrent = options.isCurrent ?? (() => true), fetcher = options.fetcher ?? fetch;
  const state = await stateFor(db); if (!state?.enabled || !state.manifest) throw changed();
  await guard(db, account, state.revision, isCurrent);
  const manifest = readGmailContextManifest(JSON.parse(state.manifest));
  if (manifest.valid_until <= Date.now() || manifest.epoch !== await epoch(db) || Date.parse(account.expiresAt) <= Date.now()) throw changed();
  const query = new URLSearchParams({ scope: manifest.scope, source_id: sourceId, person_id: personId }); if (after) query.set('after', after);
  try {
    const raw = await request(account, query, fetcher, isCurrent), page = decode(() => readGmailContextPage(raw, manifest, sourceId, personId));
    // Revalidate the entire catalog after the page, before any local publication.
    const checked = await request(account, new URLSearchParams(), fetcher, isCurrent), fresh = decode(() => readGmailContextManifest(checked));
    if (fresh.scope !== manifest.scope || fresh.epoch !== manifest.epoch || !fresh.directory_ready || fresh.valid_until <= Date.now()) throw new GmailContextError('Reviewed email context changed. Refresh again.', 409);
    await db.withExclusiveTransactionAsync(async (tx) => {
      const current = await guard(tx, account, state.revision, isCurrent);
      if (!current.manifest || readGmailContextManifest(JSON.parse(current.manifest)).scope !== manifest.scope || manifest.epoch !== await epoch(tx)) throw changed();
      const previous = await tx.getFirstAsync<Cached>('SELECT * FROM gmail_person_context WHERE source_id=? AND person_id=?', sourceId, personId);
      if (after && (!previous || previous.scope !== manifest.scope || previous.next !== after)) throw changed();
      const old: GmailContextMessage[] = after && previous ? JSON.parse(previous.messages) : [];
      if (page.messages.some((message) => old.some((saved) => saved.id === message.id))) throw changed();
      const last = old.at(-1), first = page.messages[0];
      if (last && first && (first.received_at > last.received_at || first.received_at === last.received_at && first.id <= last.id)) throw changed();
      const messages = [...old, ...page.messages]; if (messages.length > 500) throw new GmailContextError('The offline limit is 500 messages. Review older email on the web.');
      await tx.runAsync('INSERT OR REPLACE INTO gmail_person_context(source_id,person_id,scope,messages,next,checked_at) VALUES(?,?,?,?,?,?)', sourceId, personId, manifest.scope, JSON.stringify(messages), page.next, Date.now());
      for (;;) {
        const size = await tx.getFirstAsync<{ count: number; bytes: number; profiles: number }>('SELECT COALESCE(SUM(json_array_length(messages)),0) AS count,COALESCE(SUM(length(CAST(messages AS BLOB))),0) AS bytes,COUNT(*) AS profiles FROM gmail_person_context');
        if (size && size.count <= 500 && size.bytes <= 4 * 1024 * 1024 && size.profiles <= 64) break;
        const evict = await tx.getFirstAsync<{ source_id: string; person_id: string }>('SELECT source_id,person_id FROM gmail_person_context WHERE NOT(source_id=? AND person_id=?) ORDER BY checked_at,source_id,person_id LIMIT 1', sourceId, personId);
        if (!evict) throw new GmailContextError('This email context exceeds the offline cache limit. Review it on the web.');
        await tx.runAsync('DELETE FROM gmail_person_context WHERE source_id=? AND person_id=?', evict.source_id, evict.person_id);
      }
    });
  } catch (error) { await handleFailure(db, error, state.revision, isCurrent); throw error; }
}
