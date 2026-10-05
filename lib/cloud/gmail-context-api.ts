import { getCloudflareContext } from '@opennextjs/cloudflare';
import { GMAIL_CONTEXT_MAX_BYTES, GMAIL_CONTEXT_MAX_SOURCES, type GmailContextManifest, type GmailContextPage } from '@/packages/domain/src/gmail-context';
import { gmailAddress, readGmailChoices } from '@/packages/domain/src/gmail';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { fingerprintIdempotencyInput } from '@/lib/idempotency';
import { advanceGmailDirectory, gmailDirectoryState } from './gmail-contact-directory';
import { reviewGmailPersonContext } from './google-gmail-matching';
import { ProviderConnectionError } from './provider-vault';
import { maintenanceGuard, removeGuard } from './recovery-storage';
import type { ConnectionActor } from './provider-connections';

type DB = CloudflareEnv['DB'];
type ContextActor = ConnectionActor & { deviceId?: string };
type Source = { id: string; email: string; authorization_revision: number; refresh_expires_at: number | null; choices: string; settings_revision: number; active_generation: string | null; matching_revision: number };
const changed = () => new ProviderConnectionError('Reviewed email context changed. Refresh before continuing.', 409);
const eligible = `c.workspace_id=? AND c.user_id=? AND c.purpose='gmail' AND c.status='connected'
  AND c.dataset_epoch=? AND (c.refresh_expires_at IS NULL OR c.refresh_expires_at>?)`;

/** Device sessions may read their owner's reviewed projection. They cannot manage
 * provider grants or invoke matching decisions. This adapter is internal to GET. */
async function ownerReader(db: DB, actor: ContextActor) {
  let deviceExpiry: number | null = null;
  if (actor.authMethod === 'device') {
    const device = isSyncUuid(actor.deviceId) ? await db.prepare(`SELECT expires_at FROM device_sessions WHERE id=? AND workspace_id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?`)
      .bind(actor.deviceId, actor.workspaceId, actor.userId, new Date().toISOString()).first<{ expires_at: string }>() : null;
    if (!device) throw new ProviderConnectionError('Sign in again to refresh email context.', 401);
    deviceExpiry = Date.parse(device.expires_at);
  }
  const state = await db.prepare(`SELECT s.epoch FROM workspace_sync_state s JOIN workspaces w ON w.id=s.workspace_id
    JOIN workspace_members m ON m.workspace_id=s.workspace_id WHERE s.workspace_id=? AND m.user_id=? AND m.role='owner' AND s.paused=0 AND w.lifecycle='active'`)
    .bind(actor.workspaceId, actor.userId).first<{ epoch: string }>();
  if (!state) throw new ProviderConnectionError('Reviewed email context is unavailable for this account.', 403);
  return { epoch: state.epoch, deviceExpiry, reader: { ...actor, authMethod: 'web' as const } };
}
async function catalog(db: DB, actor: ContextActor, prepare: boolean) {
  const { epoch, deviceExpiry, reader } = await ownerReader(db, actor);
  let directory = await gmailDirectoryState(db, reader);
  if (prepare && !directory.ready) directory = await advanceGmailDirectory(db, reader);
  const now = Date.now();
  const rows: Source[] = (await db.prepare(`SELECT c.id,c.email,c.authorization_revision,c.refresh_expires_at,r.choices,r.settings_revision,r.active_generation,m.revision AS matching_revision
    FROM provider_connections c JOIN provider_gmail_resources r ON r.connection_id=c.id JOIN provider_gmail_matching m ON m.connection_id=c.id
    WHERE ${eligible} ORDER BY c.id LIMIT ?`).bind(actor.workspaceId, actor.userId, epoch, now, GMAIL_CONTEXT_MAX_SOURCES + 1).all<Source>()).results;
  if (rows.length > GMAIL_CONTEXT_MAX_SOURCES) throw new ProviderConnectionError('Review fewer than 33 saved Gmail accounts before using phone context.', 413);
  const sources = rows.map((row) => { const choices = readGmailChoices(JSON.parse(row.choices), row.email);
    return { id: row.id, email: gmailAddress(row.email), past_days: choices.past_days, retain_subject: choices.retain_subject }; });
  const scope = fingerprintIdempotencyInput({ epoch, directory: { revision: directory.revision, ready: directory.ready }, sources: rows });
  const manifest: GmailContextManifest = { protocol: 1, scope, epoch, directory_ready: directory.ready,
    valid_until: Math.min(now + 86400000, deviceExpiry ?? now + 86400000, ...rows.map((row) => row.refresh_expires_at ?? now + 86400000)), sources };
  // One atomic guard verifies the exact complete catalog, including absence of
  // new sources. A revoke/expiry/choice/identity race cannot return a stale page.
  const guard = crypto.randomUUID();
  await db.batch([maintenanceGuard(db, guard, `EXISTS(SELECT 1 FROM workspace_sync_state s JOIN workspaces w ON w.id=s.workspace_id
      JOIN workspace_members m ON m.workspace_id=s.workspace_id WHERE s.workspace_id=? AND s.epoch=? AND s.paused=0 AND w.lifecycle='active' AND m.user_id=? AND m.role='owner')
    AND EXISTS(SELECT 1 FROM gmail_contact_directory d WHERE d.workspace_id=? AND d.revision=? AND
      (d.bootstrapped=1 AND NOT EXISTS(SELECT 1 FROM gmail_contact_directory_pending p WHERE p.workspace_id=d.workspace_id))=?)
    AND (SELECT COUNT(*) FROM provider_connections c JOIN provider_gmail_resources r ON r.connection_id=c.id JOIN provider_gmail_matching m ON m.connection_id=c.id WHERE ${eligible})=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) saved WHERE NOT EXISTS(SELECT 1 FROM provider_connections c JOIN provider_gmail_resources r ON r.connection_id=c.id
      JOIN provider_gmail_matching m ON m.connection_id=c.id WHERE ${eligible} AND c.id=json_extract(saved.value,'$.id')
      AND c.email=json_extract(saved.value,'$.email') AND c.authorization_revision=json_extract(saved.value,'$.authorization_revision')
      AND c.refresh_expires_at IS json_extract(saved.value,'$.refresh_expires_at') AND r.choices=json_extract(saved.value,'$.choices')
      AND r.settings_revision=json_extract(saved.value,'$.settings_revision') AND r.active_generation IS json_extract(saved.value,'$.active_generation')
      AND m.revision=json_extract(saved.value,'$.matching_revision')))
    ${actor.authMethod === 'device' ? 'AND EXISTS(SELECT 1 FROM device_sessions WHERE id=? AND workspace_id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?)' : ''}`,
    [actor.workspaceId, epoch, actor.userId, actor.workspaceId, directory.revision, directory.ready ? 1 : 0,
      actor.workspaceId, actor.userId, epoch, Date.now(), rows.length, JSON.stringify(rows), actor.workspaceId, actor.userId, epoch, Date.now(),
      ...(actor.authMethod === 'device' ? [actor.deviceId!, actor.workspaceId, actor.userId, new Date().toISOString()] : [])]), removeGuard(db, guard)]);
  return { manifest, rows, directory, reader };
}
export async function gmailContextManifest(db: DB, actor: ContextActor) { return (await catalog(db, actor, true)).manifest; }
export async function gmailContextPage(db: DB, actor: ContextActor, query: URLSearchParams): Promise<GmailContextPage> {
  if ([...query.keys()].some((key) => !['scope', 'source_id', 'person_id', 'after'].includes(key) || query.getAll(key).length !== 1)
    || !isSyncUuid(query.get('person_id')) || !isSyncUuid(query.get('source_id')) || !/^[a-f0-9]{64}$/u.test(query.get('scope') ?? '')) throw changed();
  const current = await catalog(db, actor, false), { manifest } = current;
  if (manifest.scope !== query.get('scope') || !manifest.directory_ready) throw changed();
  const sourceId = query.get('source_id')!, personId = query.get('person_id')!, row = current.rows.find((row) => row.id === sourceId);
  if (!row) throw changed();
  const pinned = new URLSearchParams({ directory_revision: String(current.directory.revision), matching_revision: String(row.matching_revision) });
  if (row.active_generation) pinned.set('generation', row.active_generation);
  if (query.has('after')) {
    try { const raw = query.get('after')!; if (!raw || raw.length > 1024) throw changed();
      const cursor = JSON.parse(raw);
      if (Object.keys(cursor).sort().join(',') !== 'cursor,person_id,scope,source_id' || cursor.scope !== manifest.scope || cursor.person_id !== personId || cursor.source_id !== sourceId || typeof cursor.cursor !== 'string' || !row.active_generation) throw changed();
      pinned.set('after', cursor.cursor);
    } catch { throw changed(); }
  }
  const saved = await reviewGmailPersonContext(db, current.reader, sourceId, personId, pinned);
  if (saved.person.public_id !== personId) throw changed(); // Resolve merged contacts through CRM sync first.
  const choice = manifest.sources.find((source) => source.id === sourceId)!;
  const page: GmailContextPage = { protocol: 1, scope: manifest.scope, source_id: sourceId, person_id: personId,
    messages: saved.messages.map(({ facts, linked_addresses }) => ({ id: facts.id, thread_id: facts.thread_id, received_at: facts.received_at,
      direction: facts.direction, subject: choice.retain_subject ? facts.subject : null, linked_addresses })),
    next: saved.next ? JSON.stringify({ scope: manifest.scope, person_id: personId, source_id: sourceId, cursor: saved.next }) : null };
  if ((await catalog(db, actor, false)).manifest.scope !== manifest.scope) throw changed();
  while (new TextEncoder().encode(JSON.stringify(page)).byteLength > GMAIL_CONTEXT_MAX_BYTES && page.messages.length > 1) {
    page.messages.pop(); const last = page.messages.at(-1)!;
    page.next = JSON.stringify({ scope: manifest.scope, person_id: personId, source_id: sourceId, cursor: JSON.stringify({ at: last.received_at, id: last.id }) });
  }
  if (new TextEncoder().encode(JSON.stringify(page)).byteLength > GMAIL_CONTEXT_MAX_BYTES) throw new ProviderConnectionError('This email page is too large. Review it on the web.', 413);
  return page;
}
export async function handleGmailContext(request: Request, actor: ContextActor, path: string[]) {
  const headers = { 'Cache-Control': 'no-store', Vary: 'Authorization, Cookie' };
  if (path.join('/') !== 'v1/gmail-context') return Response.json({ error: 'Not found.' }, { status: 404, headers });
  if (request.method !== 'GET') return Response.json({ error: 'Reviewed email context is read-only.' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
  try {
    const db = getCloudflareContext().env.DB, query = new URL(request.url).searchParams;
    return Response.json(query.size ? await gmailContextPage(db, actor, query) : await gmailContextManifest(db, actor), { headers });
  } catch (error) {
    return Response.json({ error: error instanceof ProviderConnectionError ? error.message : 'Could not read reviewed email context.' }, { status: error instanceof ProviderConnectionError ? error.status : 409, headers });
  }
}
