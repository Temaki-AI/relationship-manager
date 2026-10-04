import { maintenanceGuard, removeGuard } from './recovery-storage';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { exchangeGoogleCode, googleAccount, googleConfiguration, googleConnectionScopes, googlePurpose, refreshGoogleCredentials,
  revokeGoogleCredentials, GoogleGrantError, GooglePermissionError, type GoogleCredentials, type ProviderEnvironment, type ProviderFetch, type GoogleConnectionPurpose } from './google-provider';
import { ProviderConnectionError, providerDigest, providerKeyring, randomProviderSecret, openProviderValue, sealProviderValue, type VaultBinding } from './provider-vault';

type DB = CloudflareEnv['DB'];
export type ConnectionActor = { workspaceId: string; userId: string; authMethod?: 'web' | 'device' };
type ConnectionRow = { id: string; workspace_id: string; user_id: string; provider: string; purpose: GoogleConnectionPurpose; account_id: string; email: string; display_name: string;
  granted_scopes: string; status: string; dataset_epoch: string; revision: number; authorization_revision: number; credentials: string | null;
  access_expires_at: number | null; refresh_expires_at: number | null; lease_token: string | null; lease_until: number | null;
  issue: string | null; created_at: string; updated_at: string };
type AuthorizationAttempt = { purpose: GoogleConnectionPurpose; state_hash: string; workspace_id: string; user_id: string; dataset_epoch: string;
  connection_id: string | null; connection_revision: number | null; verifier: string; claim_token: string | null; expires_at: number };
export type GoogleAccessGrant = { purpose?: GoogleConnectionPurpose; connectionId: string; workspaceId: string; userId: string; epoch: string; revision: number; authorizationRevision: number; accessToken: string };
const OWNER = "EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'owner')";
const ACTIVE = "EXISTS (SELECT 1 FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id WHERE s.workspace_id = ? AND s.epoch = ? AND s.paused = 0 AND w.lifecycle = 'active')";
function credentialBinding(row: Pick<ConnectionRow, 'id' | 'workspace_id' | 'user_id'>): VaultBinding {
  return { purpose: 'credential', id: row.id, workspaceId: row.workspace_id, userId: row.user_id };
}
function attemptBinding(row: Pick<AuthorizationAttempt, 'state_hash' | 'workspace_id' | 'user_id'>): VaultBinding {
  return { purpose: 'authorization', id: row.state_hash, workspaceId: row.workspace_id, userId: row.user_id };
}
export async function requireProviderOwner(db: DB, actor: ConnectionActor) {
  if (actor.authMethod === 'device') throw new ProviderConnectionError('Manage provider permissions in the web app.', 403);
  const member = await db.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?").bind(actor.workspaceId, actor.userId).first<{ role: string }>();
  if (member?.role !== 'owner') throw new ProviderConnectionError('Only this workspace owner can manage Google connections.', 403);
}
async function activeEpoch(db: DB, actor: ConnectionActor) {
  const state = await db.prepare("SELECT s.epoch FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id WHERE s.workspace_id = ? AND s.paused = 0 AND w.lifecycle = 'active'").bind(actor.workspaceId).first<{ epoch: string }>();
  if (!state) throw new ProviderConnectionError('Workspace maintenance is in progress. Try again after recovery.', 423);
  return state.epoch;
}
async function ownedConnection(db: DB, actor: ConnectionActor, id: string): Promise<ConnectionRow> {
  if (!isSyncUuid(id)) throw new ProviderConnectionError('Connection not found.', 404);
  const row = await db.prepare('SELECT * FROM provider_connections WHERE id = ? AND workspace_id = ? AND user_id = ?').bind(id, actor.workspaceId, actor.userId).first<ConnectionRow>();
  if (!row) throw new ProviderConnectionError('Connection not found.', 404);
  return row;
}
function publicConnection(row: ConnectionRow, epoch: string | null) {
  const status = row.status === 'connected' && row.dataset_epoch !== epoch ? 'dataset_review_required'
    : row.status === 'connected' && row.refresh_expires_at !== null && row.refresh_expires_at <= Date.now() ? 'reconnect_required' : row.status;
  return { id: row.id, provider: row.provider, purpose: row.purpose, email: row.email, display_name: row.display_name, scopes: JSON.parse(row.granted_scopes) as string[],
    status, revision: row.revision, authorization_revision: row.authorization_revision, issue: row.issue, connected_at: row.created_at, updated_at: row.updated_at };
}
export async function listProviderConnections(db: DB, actor: ConnectionActor, environment: ProviderEnvironment) {
  await requireProviderOwner(db, actor);
  const state = await db.prepare('SELECT epoch FROM workspace_sync_state WHERE workspace_id = ?').bind(actor.workspaceId).first<{ epoch: string }>();
  const rows = (await db.prepare('SELECT * FROM provider_connections WHERE workspace_id = ? AND user_id = ? ORDER BY created_at, id').bind(actor.workspaceId, actor.userId).all<ConnectionRow>()).results;
  const configured_purposes = { contacts: false, calendar: false, 'calendar-publish': false };
  for (const purpose of ['contacts', 'calendar', 'calendar-publish'] as const) try { googleConfiguration(environment, purpose); configured_purposes[purpose] = true; } catch { /* Missing configuration is public capability state. */ }
  const configured = configured_purposes.contacts;
  return { mode: 'cloud', configured, configured_purposes, epoch: state?.epoch ?? null, connections: rows.map((row: ConnectionRow) => publicConnection(row, state?.epoch ?? null)), automatic_sync: false };
}
export async function beginGoogleConnection(db: DB, actor: ConnectionActor, environment: ProviderEnvironment, body: Record<string, unknown>, origin: string | null) {
  await requireProviderOwner(db, actor);
  const purpose = googlePurpose(body.purpose), configuration = googleConfiguration(environment, purpose);
  if (origin !== configuration.origin) throw new ProviderConnectionError('Open the connection flow from this Everclose app.', 403);
  const epoch = await activeEpoch(db, actor);
  if (body.expected_epoch !== epoch) throw new ProviderConnectionError('Refresh before connecting a Google Contacts account.');
  const target = body.connection_id === undefined || body.connection_id === null ? null : await ownedConnection(db, actor, String(body.connection_id));
  if (target && (target.purpose !== purpose || target.revision !== body.expected_revision || target.status === 'revocation_pending')) throw new ProviderConnectionError('This connection changed. Refresh before reconnecting.');
  const state = randomProviderSecret(), stateHash = await providerDigest(state), verifier = randomProviderSecret(), now = Date.now();
  const encrypted = await sealProviderValue({ verifier }, attemptBinding({ state_hash: stateHash, workspace_id: actor.workspaceId, user_id: actor.userId }), configuration.keyring);
  const guard = crypto.randomUUID();
  await db.batch([
    db.prepare('DELETE FROM provider_authorization_attempts WHERE workspace_id = ? AND user_id = ? AND expires_at <= ?').bind(actor.workspaceId, actor.userId, now),
    maintenanceGuard(db, guard, ACTIVE + ' AND ' + OWNER + ' AND (SELECT COUNT(*) FROM provider_authorization_attempts WHERE workspace_id = ? AND user_id = ?) < 5', [actor.workspaceId, epoch, actor.workspaceId, actor.userId, actor.workspaceId, actor.userId]),
    db.prepare('INSERT INTO provider_authorization_attempts (state_hash, workspace_id, user_id, dataset_epoch, connection_id, connection_revision, verifier, expires_at, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(stateHash, actor.workspaceId, actor.userId, epoch, target?.id ?? null, target?.revision ?? null, encrypted, now + 10 * 60_000, purpose),
    removeGuard(db, guard),
  ]);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [name, value] of Object.entries({ client_id: configuration.clientId, redirect_uri: configuration.redirectUri, response_type: 'code',
    scope: googleConnectionScopes(purpose).join(' '), access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false',
    state, code_challenge: await providerDigest(verifier), code_challenge_method: 'S256' })) url.searchParams.set(name, value);
  return { authorization_url: url.href };
}
export async function completeGoogleConnection(db: DB, actor: ConnectionActor, environment: ProviderEnvironment, parameters: URLSearchParams, fetcher: ProviderFetch = fetch) {
  await requireProviderOwner(db, actor);
  const state = parameters.get('state');
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || parameters.getAll('state').length !== 1) throw new ProviderConnectionError('This connection request expired. Start again.');
  const hash = await providerDigest(state), claim = crypto.randomUUID();
  const attempt = await db.prepare(`UPDATE provider_authorization_attempts SET claim_token = ? WHERE state_hash = ? AND workspace_id = ? AND user_id = ?
    AND claim_token IS NULL AND expires_at > ? AND ${OWNER}
    AND EXISTS (SELECT 1 FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id WHERE s.workspace_id = provider_authorization_attempts.workspace_id AND s.epoch = provider_authorization_attempts.dataset_epoch AND s.paused = 0 AND w.lifecycle = 'active') RETURNING *`)
    .bind(claim, hash, actor.workspaceId, actor.userId, Date.now(), actor.workspaceId, actor.userId).first<AuthorizationAttempt>();
  if (!attempt) throw new ProviderConnectionError('This connection request expired or was already used. Start again.');
  try {
    const configuration = googleConfiguration(environment, googlePurpose(attempt.purpose));
    if (parameters.has('error')) throw new ProviderConnectionError('Google connection was cancelled. Your existing people were kept.');
    const code = parameters.get('code');
    if (!code || code.length > 4096 || /[\u0000-\u001f\u007f]/.test(code) || parameters.getAll('code').length !== 1) throw new ProviderConnectionError('Google did not return a valid authorization code.');
    const sealed = await openProviderValue<{ verifier: string }>(attempt.verifier, attemptBinding(attempt), configuration.keyring);
    if (!/^[A-Za-z0-9_-]{43}$/.test(sealed.verifier)) throw new ProviderConnectionError('This connection request is invalid. Start again.');
    const credentials = await exchangeGoogleCode(code, sealed.verifier, configuration, fetcher), account = await googleAccount(credentials, fetcher);
    const existing = await db.prepare("SELECT * FROM provider_connections WHERE workspace_id = ? AND provider = 'google' AND account_id = ? AND purpose = ?")
      .bind(actor.workspaceId, account.accountId, attempt.purpose).first<ConnectionRow>();
    if (existing && (existing.user_id !== actor.userId || existing.status === 'revocation_pending')) throw new ProviderConnectionError('This Google account is already connected or awaiting disconnection.');
    if (attempt.connection_id && (!existing || existing.id !== attempt.connection_id || existing.revision !== attempt.connection_revision)) throw new ProviderConnectionError('Choose the same Google account when reconnecting. Refresh if its authorization changed.');
    const id = existing?.id ?? crypto.randomUUID(), now = new Date().toISOString();
    const ciphertext = await sealProviderValue(credentials, credentialBinding({ id, workspace_id: actor.workspaceId, user_id: actor.userId }), configuration.keyring);
    const guard = crypto.randomUUID();
    const conditions = ACTIVE + ' AND ' + OWNER + ' AND EXISTS (SELECT 1 FROM provider_authorization_attempts WHERE state_hash = ? AND claim_token = ? AND expires_at > ?)'
      + (existing ? ' AND EXISTS (SELECT 1 FROM provider_connections WHERE id = ? AND revision = ? AND status != \'revocation_pending\')'
        : ' AND (SELECT COUNT(*) FROM provider_connections WHERE workspace_id = ?) < 10');
    await db.batch([
      maintenanceGuard(db, guard, conditions, [actor.workspaceId, attempt.dataset_epoch, actor.workspaceId, actor.userId, hash, claim, Date.now(), ...(existing ? [existing.id, existing.revision] : [actor.workspaceId])]),
      db.prepare(`INSERT INTO provider_connections (id, workspace_id, user_id, provider, purpose, account_id, email, display_name, granted_scopes, status, dataset_epoch, revision, authorization_revision, credentials, access_expires_at, refresh_expires_at, created_at, updated_at)
        VALUES (?, ?, ?, 'google', ?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        email = excluded.email, display_name = excluded.display_name, granted_scopes = excluded.granted_scopes, status = 'connected', dataset_epoch = excluded.dataset_epoch,
        revision = excluded.revision, authorization_revision = excluded.authorization_revision, credentials = excluded.credentials, access_expires_at = excluded.access_expires_at, refresh_expires_at = excluded.refresh_expires_at, lease_token = NULL, lease_until = NULL, issue = NULL, updated_at = excluded.updated_at`)
        .bind(id, actor.workspaceId, actor.userId, attempt.purpose, account.accountId, account.email, account.displayName, JSON.stringify(credentials.scopes), attempt.dataset_epoch,
          (existing?.revision ?? 0) + 1, (existing?.authorization_revision ?? 0) + 1, ciphertext, credentials.accessExpiresAt, credentials.refreshExpiresAt, existing?.created_at ?? now, now),
      db.prepare('DELETE FROM provider_authorization_attempts WHERE state_hash = ? AND claim_token = ?').bind(hash, claim), removeGuard(db, guard),
    ]);
    return publicConnection(await ownedConnection(db, actor, id), attempt.dataset_epoch);
  } finally {
    await db.prepare('DELETE FROM provider_authorization_attempts WHERE state_hash = ? AND claim_token = ?').bind(hash, claim).run();
  }
}
function assertUsable(row: ConnectionRow, epoch: string) {
  if (row.status !== 'connected' || row.dataset_epoch !== epoch || !row.credentials) throw new ProviderConnectionError('Reconnect this account before using its data.');
  if (row.refresh_expires_at !== null && row.refresh_expires_at <= Date.now()) throw new GoogleGrantError();
}
async function openCredentials(row: ConnectionRow, environment: ProviderEnvironment) {
  const configuration = googleConfiguration(environment, googlePurpose(row.purpose));
  const credentials = await openProviderValue<GoogleCredentials>(row.credentials!, credentialBinding(row), configuration.keyring);
  if (credentials.clientId !== configuration.clientId || typeof credentials.refreshToken !== 'string' || typeof credentials.accessToken !== 'string'
    || !Array.isArray(credentials.scopes) || JSON.stringify(credentials.scopes) !== row.granted_scopes
    || credentials.accessExpiresAt !== row.access_expires_at || credentials.refreshExpiresAt !== row.refresh_expires_at) throw new ProviderConnectionError('The Google client changed or credentials are unavailable. Reconnect this account.');
  return { configuration, credentials };
}
// Provider jobs must include this guard in the same transaction as their CRM writes.
export function providerWriteGuard(db: DB, grant: Omit<GoogleAccessGrant, 'accessToken'>, token: string) {
  const predicate = providerGrantCondition(grant);
  return maintenanceGuard(db, token, predicate.condition, predicate.values);
}
export function providerGrantCondition(grant: Omit<GoogleAccessGrant, 'accessToken'>) {
  return { condition: ACTIVE + ' AND ' + OWNER + " AND EXISTS (SELECT 1 FROM provider_connections WHERE id = ? AND workspace_id = ? AND user_id = ? AND dataset_epoch = ? AND revision = ? AND authorization_revision = ? AND purpose = ? AND status = 'connected')",
    values: [grant.workspaceId, grant.epoch, grant.workspaceId, grant.userId, grant.connectionId, grant.workspaceId, grant.userId, grant.epoch, grant.revision, grant.authorizationRevision, grant.purpose ?? 'contacts'] };
}
export async function googleConnectionAccess(db: DB, actor: ConnectionActor, environment: ProviderEnvironment, id: string, expectedEpoch: string, fetcher: ProviderFetch = fetch, purpose: GoogleConnectionPurpose = 'contacts'): Promise<GoogleAccessGrant> {
  await requireProviderOwner(db, actor);
  const epoch = await activeEpoch(db, actor);
  if (epoch !== expectedEpoch) throw new ProviderConnectionError('The dataset changed. Review the connection before syncing.');
  const row = await ownedConnection(db, actor, id);
  if (row.purpose !== purpose) throw new ProviderConnectionError('This connection does not authorize the requested Google resource.', 403);
  assertUsable(row, epoch);
  const { configuration, credentials } = await openCredentials(row, environment);
  const grant = { purpose: row.purpose, connectionId: id, workspaceId: actor.workspaceId, userId: actor.userId, epoch, revision: row.revision, authorizationRevision: row.authorization_revision, accessToken: credentials.accessToken };
  if (credentials.accessExpiresAt > Date.now() + 60_000) {
    const guard = crypto.randomUUID(); await db.batch([providerWriteGuard(db, grant, guard), removeGuard(db, guard)]); return grant;
  }
  const lease = crypto.randomUUID(), now = Date.now();
  const claimed = await db.prepare(`UPDATE provider_connections SET lease_token = ?, lease_until = ? WHERE id = ? AND workspace_id = ? AND user_id = ? AND revision = ? AND status = 'connected'
    AND (lease_token IS NULL OR lease_until < ?) AND ${ACTIVE} AND ${OWNER} RETURNING id`)
    .bind(lease, now + 45_000, id, actor.workspaceId, actor.userId, row.revision, now, actor.workspaceId, epoch, actor.workspaceId, actor.userId).first();
  if (!claimed) throw new ProviderConnectionError('This Google account is refreshing or changed. Try again shortly.', 503);
  let refreshed: GoogleCredentials | undefined;
  try {
    refreshed = await refreshGoogleCredentials(credentials, configuration, fetcher);
    const ciphertext = await sealProviderValue(refreshed, credentialBinding(row), configuration.keyring), guard = crypto.randomUUID();
    await db.batch([
      providerWriteGuard(db, grant, guard),
      maintenanceGuard(db, guard + '-lease', 'EXISTS (SELECT 1 FROM provider_connections WHERE id = ? AND lease_token = ? AND lease_until >= ?)', [id, lease, Date.now()]),
      db.prepare('UPDATE provider_connections SET credentials = ?, access_expires_at = ?, refresh_expires_at = ?, granted_scopes = ?, revision = revision + 1, lease_token = NULL, lease_until = NULL, issue = NULL, updated_at = ? WHERE id = ?')
        .bind(ciphertext, refreshed.accessExpiresAt, refreshed.refreshExpiresAt, JSON.stringify(refreshed.scopes), new Date().toISOString(), id),
      removeGuard(db, guard), removeGuard(db, guard + '-lease'),
    ]);
    return { ...grant, revision: grant.revision + 1, accessToken: refreshed.accessToken };
  } catch (error) {
    if (error instanceof GoogleGrantError) await db.prepare("UPDATE provider_connections SET status = 'reconnect_required', credentials = NULL, revision = revision + 1, authorization_revision = authorization_revision + 1, issue = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND revision = ? AND lease_token = ?")
      .bind(error instanceof GooglePermissionError ? 'permissions_changed' : 'authorization_expired', new Date().toISOString(), id, row.revision, lease).run();
    if (refreshed) await retainLateRevocation(db, row, refreshed, environment, fetcher);
    throw error;
  } finally {
    await db.prepare('UPDATE provider_connections SET lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ?').bind(id, lease).run();
  }
}
export async function requireGoogleReconnection(db: DB, grant: GoogleAccessGrant) {
  const guard = crypto.randomUUID();
  await db.batch([providerWriteGuard(db, grant, guard), db.prepare(`UPDATE provider_connections SET status = 'reconnect_required', credentials = NULL,
    revision = revision + 1, authorization_revision = authorization_revision + 1, lease_token = NULL, lease_until = NULL,
    issue = ?, updated_at = ? WHERE id = ?`).bind(`${grant.purpose ?? 'contacts'}_permission_unavailable`, new Date().toISOString(), grant.connectionId), removeGuard(db, guard)]);
}
async function retainLateRevocation(db: DB, original: ConnectionRow, credentials: GoogleCredentials, environment: ProviderEnvironment, fetcher: ProviderFetch) {
  // A credential returned after a security stop must never become usable again.
  const current = await db.prepare('SELECT * FROM provider_connections WHERE id = ?').bind(original.id).first<ConnectionRow>();
  if (current?.status === 'connected') return; // A newer explicit authorization owns this grant now.
  if (!current) { try { await revokeGoogleCredentials(credentials, fetcher); } catch { /* Erasure cannot retain credentials for a retry. */ } return; }
  const ciphertext = await sealProviderValue(credentials, credentialBinding(original), providerKeyring(environment.CONNECTOR_TOKEN_KEYRING));
  const staged = await db.prepare("UPDATE provider_connections SET credentials = ?, status = 'revocation_pending', access_expires_at = ?, refresh_expires_at = ?, granted_scopes = ?, revision = revision + 1, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND revision = ? AND status != 'connected' RETURNING id")
    .bind(ciphertext, credentials.accessExpiresAt, credentials.refreshExpiresAt, JSON.stringify(credentials.scopes), new Date().toISOString(), current.id, current.revision).first();
  if (staged) await retryGoogleRevocation(db, current.id, environment, fetcher);
}
export async function retryGoogleRevocation(db: DB, id: string, environment: ProviderEnvironment, fetcher: ProviderFetch = fetch): Promise<boolean> {
  const lease = crypto.randomUUID(), now = Date.now();
  const pending = await db.prepare("UPDATE provider_connections SET lease_token = ?, lease_until = ? WHERE id = ? AND status = 'revocation_pending' AND credentials IS NOT NULL AND (lease_token IS NULL OR lease_until < ?) RETURNING *")
    .bind(lease, now + 45_000, id, now).first<ConnectionRow>();
  if (!pending) return false;
  try {
    const credentials = await openProviderValue<GoogleCredentials>(pending.credentials!, credentialBinding(pending), providerKeyring(environment.CONNECTOR_TOKEN_KEYRING));
    if (await revokeGoogleCredentials(credentials, fetcher)) {
      const saved = await db.prepare("UPDATE provider_connections SET credentials = NULL, status = 'disconnected', access_expires_at = NULL, refresh_expires_at = NULL, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND revision = ? AND lease_token = ? AND lease_until >= ? AND status = 'revocation_pending' RETURNING id")
        .bind(new Date().toISOString(), id, pending.revision, lease, Date.now()).first();
      return Boolean(saved);
    }
  } catch { /* Keep only encrypted material, inaccessible to sync, until another retry. */ }
  finally {
    await db.prepare('UPDATE provider_connections SET lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND lease_token = ?').bind(new Date().toISOString(), id, lease).run();
  }
  return false;
}
export async function maintainProviderConnections(db: DB, environment: ProviderEnvironment, fetcher: ProviderFetch = fetch) {
  await db.prepare('DELETE FROM provider_authorization_attempts WHERE state_hash IN (SELECT state_hash FROM provider_authorization_attempts WHERE expires_at <= ? LIMIT 500)').bind(Date.now()).run();
  const pending = (await db.prepare("SELECT id FROM provider_connections WHERE status = 'revocation_pending' AND (lease_token IS NULL OR lease_until < ?) ORDER BY updated_at, id LIMIT 5").bind(Date.now()).all<{ id: string }>()).results;
  let revoked = 0;
  for (const item of pending) if (await retryGoogleRevocation(db, item.id, environment, fetcher)) revoked++;
  return { attempted: pending.length, revoked, pending: pending.length - revoked };
}
export async function disconnectGoogleConnection(db: DB, actor: ConnectionActor, environment: ProviderEnvironment, id: string, expectedRevision: unknown, fetcher: ProviderFetch = fetch) {
  await requireProviderOwner(db, actor);
  const row = await ownedConnection(db, actor, id);
  if (row.revision !== expectedRevision) throw new ProviderConnectionError('This connection changed. Refresh before disconnecting.');
  if (row.status === 'disconnected') return { disconnected: true, revocation_pending: false };
  const guard = crypto.randomUUID();
  await db.batch([
    maintenanceGuard(db, guard, OWNER + ' AND EXISTS (SELECT 1 FROM provider_connections WHERE id = ? AND revision = ?)', [actor.workspaceId, actor.userId, id, row.revision]),
    db.prepare("UPDATE provider_connections SET status = CASE WHEN credentials IS NULL THEN 'disconnected' ELSE 'revocation_pending' END, revision = revision + 1, authorization_revision = authorization_revision + 1, lease_token = NULL, lease_until = NULL, issue = NULL, updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id),
    db.prepare('DELETE FROM provider_authorization_attempts WHERE workspace_id = ? AND user_id = ? AND purpose = ?').bind(actor.workspaceId, actor.userId, row.purpose), removeGuard(db, guard),
  ]);
  if (!row.credentials) return { disconnected: true, revocation_pending: false };
  await retryGoogleRevocation(db, id, environment, fetcher);
  const current = await ownedConnection(db, actor, id);
  return { disconnected: true, revocation_pending: current.status === 'revocation_pending' };
}
