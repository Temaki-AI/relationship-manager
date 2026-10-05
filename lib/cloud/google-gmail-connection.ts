import { isSyncUuid } from '@/packages/domain/src/sync';
import { googleConnectionAccess, providerWriteGuard, requireGoogleReconnection, requireProviderOwner, type ConnectionActor } from './provider-connections';
import { GoogleGmailError, googleGmailLabels, googleGmailProfile } from './google-gmail';
import type { ProviderEnvironment, ProviderFetch } from './google-provider';
import { ProviderConnectionError } from './provider-vault';
import { removeGuard } from './recovery-storage';

type DB = CloudflareEnv['DB'];
type Connection = { id: string; email: string; display_name: string; status: string; revision: number; authorization_revision: number; dataset_epoch: string; refresh_expires_at: number | null };
export type GmailConnectionReview = {
  epoch: string; can_preview: boolean;
  connection: { id: string; email: string; display_name: string; status: string; revision: number; authorization_revision: number };
};
async function connection(db: DB, actor: ConnectionActor, id: string) {
  await requireProviderOwner(db, actor);
  if (!isSyncUuid(id)) throw new ProviderConnectionError('Gmail connection not found.', 404);
  const row = await db.prepare("SELECT id, email, display_name, status, revision, authorization_revision, dataset_epoch, refresh_expires_at FROM provider_connections WHERE id = ? AND workspace_id = ? AND user_id = ? AND purpose = 'gmail'")
    .bind(id, actor.workspaceId, actor.userId).first<Connection>();
  if (!row) throw new ProviderConnectionError('Gmail connection not found.', 404);
  return row;
}
export async function reviewGmailConnection(db: DB, actor: ConnectionActor, id: string): Promise<GmailConnectionReview> {
  const row = await connection(db, actor, id);
  const state = await db.prepare('SELECT s.epoch, s.paused, w.lifecycle FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id WHERE s.workspace_id = ?')
    .bind(actor.workspaceId).first<{ epoch: string; paused: number; lifecycle: string }>();
  if (!state) throw new ProviderConnectionError('Workspace maintenance is in progress.', 423);
  const status = row.status === 'connected' && row.dataset_epoch !== state.epoch ? 'dataset_review_required'
    : row.status === 'connected' && row.refresh_expires_at !== null && row.refresh_expires_at <= Date.now() ? 'reconnect_required' : row.status;
  return { epoch: state.epoch, can_preview: status === 'connected' && state.paused === 0 && state.lifecycle === 'active',
    connection: { id: row.id, email: row.email, display_name: row.display_name, status, revision: row.revision, authorization_revision: row.authorization_revision } };
}
/** Explicit read-only label preview. No message import, source snapshot or CRM write. */
export async function previewGmailMailbox(db: DB, actor: ConnectionActor, environment: ProviderEnvironment, id: string, body: Record<string, unknown>, fetcher: ProviderFetch = fetch) {
  const row = await connection(db, actor, id);
  if (Object.keys(body).sort().join(',') !== 'expected_authorization_revision,expected_epoch'
    || !isSyncUuid(body.expected_epoch) || body.expected_epoch !== row.dataset_epoch
    || body.expected_authorization_revision !== row.authorization_revision) throw new ProviderConnectionError('Gmail authorization changed. Refresh this account before previewing.');
  const grant = await googleConnectionAccess(db, actor, environment, id, body.expected_epoch, fetcher, 'gmail');
  if (grant.authorizationRevision !== body.expected_authorization_revision) throw new ProviderConnectionError('Gmail authorization changed. Refresh this account before previewing.');
  let mailbox, labels;
  try {
    mailbox = await googleGmailProfile(grant.accessToken, fetcher);
    if (mailbox.email !== row.email.normalize('NFC').toLowerCase()) throw new ProviderConnectionError('The Gmail mailbox identity changed. Reauthorize this account before continuing.');
    labels = await googleGmailLabels(grant.accessToken, fetcher);
  } catch (error) {
    if (error instanceof GoogleGmailError && error.reason === 'permission') await requireGoogleReconnection(db, grant);
    throw error;
  }
  // Revocation, recovery, account changes or loss of ownership during either read
  // must prevent returning the newly fetched private mailbox labels.
  const guard = crypto.randomUUID();
  await db.batch([providerWriteGuard(db, grant, guard), removeGuard(db, guard)]);
  return { email: mailbox.email, labels };
}
