import { gmailAddress } from '@/packages/domain/src/gmail';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { requireProviderOwner, type ConnectionActor } from './provider-connections';
import { ProviderConnectionError } from './provider-vault';
import { maintenanceGuard, removeGuard } from './recovery-storage';

type DB = CloudflareEnv['DB'];
type State = { revision: number; cursor_id: number; bootstrapped: number; progress_revision: number };
type Person = { id: number; public_id: string; email: string | null; emails: string };
const stateFor = (db: DB, workspace: string) => db.prepare('SELECT * FROM gmail_contact_directory WHERE workspace_id = ?').bind(workspace).first<State>();
const emailProjection = `COALESCE((SELECT json_group_array(json_extract(method.value,'$.value')) FROM json_each(c.contact_methods) method WHERE json_extract(method.value,'$.kind')='email'),'[]') AS emails`;

/** Derived identities contain no notes/names. Unicode normalization and exact
 * address identity match the Gmail parser; dots/plus tags are never guessed away.
 */
export function gmailPersonAddresses(primary: string | null, methods: string) {
  const addresses = new Set<string>(); const values = JSON.parse(methods) as unknown;
  if (!Array.isArray(values) || values.length > 256) throw new ProviderConnectionError('Review this person’s email methods before matching.');
  for (const raw of [primary, ...values]) {
    if (raw == null || raw === '') continue;
    try { addresses.add(gmailAddress(raw)); } catch { /* Unsupported addresses never become guesses. */ }
  }
  return [...addresses].sort();
}
export async function gmailDirectoryState(db: DB, actor: ConnectionActor) {
  await requireProviderOwner(db, actor);
  const state = await stateFor(db, actor.workspaceId);
  const epoch = await db.prepare('SELECT epoch FROM workspace_sync_state WHERE workspace_id = ? AND paused = 0').bind(actor.workspaceId).first<{ epoch: string }>();
  if (!state || !epoch) throw new ProviderConnectionError('Workspace matching is unavailable.', 409);
  const pending = Boolean(await db.prepare('SELECT 1 FROM gmail_contact_directory_pending WHERE workspace_id = ? LIMIT 1').bind(actor.workspaceId).first());
  const guard = crypto.randomUUID();
  await db.batch([maintenanceGuard(db, guard, `EXISTS(SELECT 1 FROM gmail_contact_directory d JOIN workspace_sync_state s ON s.workspace_id=d.workspace_id
    JOIN workspaces w ON w.id=d.workspace_id JOIN workspace_members m ON m.workspace_id=d.workspace_id
    WHERE d.workspace_id=? AND d.revision=? AND d.progress_revision=? AND s.epoch=? AND s.paused=0 AND w.lifecycle='active' AND m.user_id=? AND m.role='owner')`,
  [actor.workspaceId, state.revision, state.progress_revision, epoch.epoch, actor.userId]), removeGuard(db, guard)]);
  return { revision: state.revision, ready: Boolean(state.bootstrapped) && !pending, cursor_id: state.cursor_id };
}

/** One bounded internal batch makes no provider requests. A single JSON insert
 * keeps the SQL statement count independent of the number of email methods.
 */
export async function advanceGmailDirectory(db: DB, actor: ConnectionActor) {
  await requireProviderOwner(db, actor);
  const state = await stateFor(db, actor.workspaceId);
  const epoch = await db.prepare('SELECT epoch FROM workspace_sync_state WHERE workspace_id = ? AND paused = 0').bind(actor.workspaceId).first<{ epoch: string }>();
  if (!state || !epoch) throw new ProviderConnectionError('Workspace matching needs review.', 409);
  let pending: Array<{ contact_public_id: string }> = [];
  if (state.bootstrapped) pending = (await db.prepare('SELECT contact_public_id FROM gmail_contact_directory_pending WHERE workspace_id = ? ORDER BY contact_public_id LIMIT 100').bind(actor.workspaceId).all<{ contact_public_id: string }>()).results;
  const rows: Person[] = (await (state.bootstrapped
    ? db.prepare(`SELECT c.id,c.public_id,c.email,${emailProjection} FROM contacts c WHERE c.workspace_id = ? AND c.public_id IN(SELECT value FROM json_each(?)) ORDER BY c.public_id`).bind(actor.workspaceId, JSON.stringify(pending.map((row) => row.contact_public_id)))
    : db.prepare(`SELECT c.id,c.public_id,c.email,${emailProjection} FROM contacts c WHERE c.workspace_id = ? AND c.id > ? ORDER BY c.id LIMIT 100`).bind(actor.workspaceId, state.cursor_id)).all<Person>()).results;
  const records: Array<{ public_id: string; emails: string[] }> = []; let bytes = 2;
  for (const row of rows) {
    if (!isSyncUuid(row.public_id)) throw new ProviderConnectionError('A contact identity needs review before matching.');
    const record = { public_id: row.public_id, emails: gmailPersonAddresses(row.email, row.emails) };
    const size = new TextEncoder().encode(JSON.stringify(record)).byteLength + 1;
    if (records.length && bytes + size > 900000) break;
    records.push(record); bytes += size;
  }
  const usedRows = rows.slice(0, records.length), usedPending = state.bootstrapped
    ? pending.filter((item) => !rows.some((row) => row.public_id === item.contact_public_id) || records.some((row) => row.public_id === item.contact_public_id)).map((item) => item.contact_public_id)
    : records.map((row) => row.public_id);
  const encoded = JSON.stringify(records), selected = JSON.stringify(usedPending), guard = crypto.randomUUID();
  await db.batch([
    maintenanceGuard(db, guard, `EXISTS(SELECT 1 FROM gmail_contact_directory d JOIN workspace_sync_state s ON s.workspace_id=d.workspace_id
      JOIN workspaces w ON w.id=d.workspace_id JOIN workspace_members m ON m.workspace_id=d.workspace_id
      WHERE d.workspace_id=? AND d.revision=? AND d.progress_revision=? AND s.epoch=? AND s.paused=0 AND w.lifecycle='active' AND m.user_id=? AND m.role='owner')`,
    [actor.workspaceId, state.revision, state.progress_revision, epoch.epoch, actor.userId]),
    db.prepare('DELETE FROM gmail_contact_directory_entries WHERE workspace_id=? AND contact_public_id IN(SELECT value FROM json_each(?))').bind(actor.workspaceId, selected),
    db.prepare(`INSERT INTO gmail_contact_directory_entries(workspace_id,email,contact_public_id)
      SELECT ?,address.value,json_extract(person.value,'$.public_id') FROM json_each(?) person,json_each(person.value,'$.emails') address`).bind(actor.workspaceId, encoded),
    db.prepare('DELETE FROM gmail_contact_directory_pending WHERE workspace_id=? AND contact_public_id IN(SELECT value FROM json_each(?))').bind(actor.workspaceId, selected),
    db.prepare('UPDATE gmail_contact_directory SET cursor_id=?,bootstrapped=?,progress_revision=progress_revision+1 WHERE workspace_id=?')
      .bind(state.bootstrapped ? state.cursor_id : usedRows.at(-1)?.id ?? state.cursor_id, state.bootstrapped || rows.length < 100 && records.length === rows.length ? 1 : 0, actor.workspaceId),
    removeGuard(db, guard),
  ]);
  return gmailDirectoryState(db, actor);
}
