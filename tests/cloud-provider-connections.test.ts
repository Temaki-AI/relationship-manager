import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';
import { cloudWorkspaceMaintenanceResponse } from '../lib/cloud/workspace-access.ts';

const CONTACTS = 'https://www.googleapis.com/auth/contacts.readonly';
const environment = { BETTER_AUTH_URL: 'https://test.invalid', GOOGLE_CLIENT_ID: 'login-client', GOOGLE_CONNECTOR_CLIENT_ID: 'contact-client',
  GOOGLE_CONNECTOR_CLIENT_SECRET: 'test-only-client-secret', CONNECTOR_TOKEN_KEYRING: JSON.stringify({ active: 'v1', keys: { v1: Buffer.alloc(32, 13).toString('base64url') } }) };
const actor = { workspaceId: 'test', userId: 'owner', authMethod: 'web' as const };
type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
async function setup() {
  const h = await createCloudHarness();
  await h.db.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@test.invalid', 1, 1, 1), ('second', 'Second', 'second@test.invalid', 1, 1, 1)").run();
  await h.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner'), ('other', 'second', 'owner')").run();
  return h;
}
async function epoch(h: Harness) { return (await h.db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'test'").first<{ epoch: string }>())!.epoch; }
function google(options: { account?: string; expires?: number; scopes?: string; verified?: boolean; refreshToken?: string } = {}) {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const fetcher = async (url: string, request: RequestInit) => {
    calls.push({ url, options: request });
    assert.equal(request.redirect, 'error'); assert.ok(request.signal);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'test-only-access-secret', refresh_token: options.refreshToken || 'test-only-refresh-secret',
      token_type: 'Bearer', expires_in: options.expires || 3600, scope: options.scopes ?? `openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile ${CONTACTS}` });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: options.account || 'google-owner', email: (options.account || 'owner') + '@example.test', email_verified: options.verified ?? true, name: 'Google Person' });
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response(null, { status: 200 });
    throw new Error('Unexpected provider endpoint');
  };
  return { calls, fetcher };
}
async function start(h: Harness, extra: Record<string, unknown> = {}) {
  const result = await h.providers.beginGoogleConnection(h.db, actor, environment, { purpose: 'contacts', expected_epoch: await epoch(h), ...extra }, environment.BETTER_AUTH_URL);
  const url = new URL(result.authorization_url), parameters = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'test-only-code' });
  return { url, parameters };
}
async function connect(h: Harness, options: Parameters<typeof google>[0] = {}) {
  const pending = await start(h), provider = google(options);
  const connection = await h.providers.completeGoogleConnection(h.db, actor, environment, pending.parameters, provider.fetcher);
  return { connection, provider, pending };
}
async function row(h: Harness, id: string) { return (await h.db.prepare('SELECT * FROM provider_connections WHERE id = ?').bind(id).first())!; }
function binding(id: string) { return { purpose: 'credential' as const, workspaceId: 'test', userId: 'owner', id }; }

test('Google consent is separate, bounded, one-use and bound to the signed-in owner, workspace and PKCE verifier', async () => {
  const h = await setup(); try {
    const { url, parameters } = await start(h);
    assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.searchParams.get('client_id'), 'contact-client');
    assert.equal(url.searchParams.get('scope'), `openid email profile ${CONTACTS}`);
    assert.equal(url.searchParams.get('include_granted_scopes'), 'false'); assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://test.invalid/api/connections/google/callback');
    const attempt = (await h.db.prepare('SELECT * FROM provider_authorization_attempts').first())!;
    assert.notEqual(attempt.state_hash, parameters.get('state')); assert.ok(!String(attempt.verifier).includes('verifier'));
    const provider = google();
    await assert.rejects(h.providers.completeGoogleConnection(h.db, { workspaceId: 'other', userId: 'second' }, environment, parameters, provider.fetcher), /expired/);
    assert.equal(provider.calls.length, 0);
    await assert.rejects(h.providers.beginGoogleConnection(h.db, actor, environment, { purpose: 'contacts', expected_epoch: await epoch(h) }, 'https://attacker.invalid'), /Open the connection/);
    await assert.rejects(h.providers.beginGoogleConnection(h.db, { ...actor, authMethod: 'device' }, environment, { purpose: 'contacts' }, environment.BETTER_AUTH_URL), /web app/);
    const connection = await h.providers.completeGoogleConnection(h.db, actor, environment, parameters, provider.fetcher);
    const exchange = provider.calls.find((call) => call.url.endsWith('/token'))!;
    const sent = exchange.options.body as URLSearchParams;
    assert.equal(await h.providerVault.providerDigest(sent.get('code_verifier')!), url.searchParams.get('code_challenge'));
    assert.equal(sent.get('client_secret'), environment.GOOGLE_CONNECTOR_CLIENT_SECRET);
    const stored = await row(h, connection.id);
    assert.equal(stored.account_id, 'google-owner'); assert.equal(stored.status, 'connected');
    assert.ok(!String(stored.credentials).includes('test-only-refresh-secret')); assert.ok(!String(stored.credentials).includes('test-only-access-secret'));
    const listing = await h.providers.listProviderConnections(h.db, actor, environment);
    assert.equal(listing.connections[0].status, 'connected'); assert.ok(!JSON.stringify(listing).includes('credentials')); assert.ok(!JSON.stringify(listing).includes('secret'));
    await assert.rejects(h.providers.completeGoogleConnection(h.db, actor, environment, parameters, provider.fetcher), /already used/);
    const before = (await h.db.prepare('SELECT COUNT(*) AS n FROM provider_connections').first())!.n;
    await assert.rejects(connect(h, { scopes: 'openid email profile' }), /read-only Contacts/);
    await assert.rejects(connect(h, { verified: false }), /unverified/);
    await assert.rejects(connect(h, { scopes: `openid email profile ${CONTACTS} https://www.googleapis.com/auth/gmail.metadata` }), /read-only Contacts/);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_connections').first())!.n, before);
    for (let i = 0; i < 5; i++) await start(h);
    await assert.rejects(start(h), /CLOUD_RECOVERY_CONFLICT/);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_authorization_attempts').first())!.n, 5);
  } finally { await h.close(); }
});

test('multiple Google accounts retain separate identities and reauthorization must select the original account', async () => {
  const h = await setup(); try {
    const first = await connect(h), second = await connect(h, { account: 'work-account' });
    assert.notEqual(first.connection.id, second.connection.id);
    const wrong = await start(h, { connection_id: first.connection.id, expected_revision: first.connection.revision });
    await assert.rejects(h.providers.completeGoogleConnection(h.db, actor, environment, wrong.parameters, google({ account: 'wrong-account' }).fetcher), /same Google account/);
    assert.equal((await row(h, first.connection.id)).revision, 1);
    const correct = await start(h, { connection_id: first.connection.id, expected_revision: first.connection.revision });
    const reauthorized = await h.providers.completeGoogleConnection(h.db, actor, environment, correct.parameters, google().fetcher);
    assert.equal(reauthorized.id, first.connection.id); assert.equal(reauthorized.revision, 2);
    assert.equal((await h.providers.listProviderConnections(h.db, actor, environment)).connections.length, 2);
    assert.equal((await h.providers.listProviderConnections(h.db, { workspaceId: 'other', userId: 'second' }, environment)).connections.length, 0);
    await assert.rejects(h.providers.googleConnectionAccess(h.db, { workspaceId: 'other', userId: 'second' }, environment, first.connection.id, await epoch(h)), /dataset changed|not found/);
    await assert.rejects(h.providers.beginGoogleConnection(h.db, actor, { ...environment, GOOGLE_CONNECTOR_CLIENT_ID: 'login-client' }, { purpose: 'contacts', expected_epoch: await epoch(h) }, environment.BETTER_AUTH_URL), /separate OAuth client/);
  } finally { await h.close(); }
});

test('vault authentication prevents credential swaps and key rotation keeps an older connection readable', async () => {
  const h = await setup(); try {
    const { connection } = await connect(h);
    const stored = await row(h, connection.id), keyring = h.providerVault.providerKeyring(environment.CONNECTOR_TOKEN_KEYRING);
    await assert.rejects(h.providerVault.openProviderValue(String(stored.credentials), { ...binding(connection.id), workspaceId: 'other' }, keyring), /Stored authorization/);
    await assert.rejects(h.providerVault.openProviderValue(String(stored.credentials), binding(crypto.randomUUID()), keyring), /Stored authorization/);
    const envelope = JSON.parse(String(stored.credentials)); envelope.data = (envelope.data[0] === 'A' ? 'B' : 'A') + envelope.data.slice(1);
    await assert.rejects(h.providerVault.openProviderValue(JSON.stringify(envelope), binding(connection.id), keyring), /Stored authorization/);
    const rotated = { ...environment, CONNECTOR_TOKEN_KEYRING: JSON.stringify({ active: 'v2', keys: { ...keyring.keys, v2: Buffer.alloc(32, 22).toString('base64url') } }) };
    const grant = await h.providers.googleConnectionAccess(h.db, actor, rotated, connection.id, await epoch(h));
    assert.equal(grant.accessToken, 'test-only-access-secret');
    await assert.rejects(h.providers.googleConnectionAccess(h.db, actor, { ...rotated, CONNECTOR_TOKEN_KEYRING: JSON.stringify({ active: 'v2', keys: { v2: Buffer.alloc(32, 22).toString('base64url') } }) }, connection.id, await epoch(h)), /Stored authorization/);
    await assert.rejects(h.providers.googleConnectionAccess(h.db, actor, { ...environment, GOOGLE_CONNECTOR_CLIENT_ID: 'replacement-client' }, connection.id, await epoch(h)), /client changed/);
  } finally { await h.close(); }
});

test('refresh is serialized, rotates or retains the refresh token and marks invalid grants for reconnect', async () => {
  const h = await setup(); try {
    const { connection } = await connect(h, { expires: 1 });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), began = new Promise<void>((resolve) => { entered = resolve; });
    let refreshes = 0;
    const fetcher = async (url: string, options: RequestInit) => { assert.equal(url, 'https://oauth2.googleapis.com/token'); assert.equal((options.body as URLSearchParams).get('refresh_token'), 'test-only-refresh-secret');
      refreshes++; entered(); await gate; return Response.json({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 1, token_type: 'Bearer' }); };
    const refresh = h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, await epoch(h), fetcher); await began;
    await assert.rejects(h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, await epoch(h), fetcher), /refreshing/);
    release(); const grant = await refresh; assert.equal(grant.revision, 2); assert.equal(refreshes, 1);
    await h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, await epoch(h), async (_url, options) => {
      assert.equal((options.body as URLSearchParams).get('refresh_token'), 'rotated-refresh'); return Response.json({ access_token: 'third-access', expires_in: 1, token_type: 'Bearer' });
    });
    const stored = await row(h, connection.id);
    const credentials = await h.providerVault.openProviderValue<{ refreshToken: string }>(String(stored.credentials), binding(connection.id), h.providerVault.providerKeyring(environment.CONNECTOR_TOKEN_KEYRING));
    assert.equal(credentials.refreshToken, 'rotated-refresh'); assert.equal(stored.lease_token, null);
    await assert.rejects(h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, await epoch(h), async () => Response.json({ error: 'invalid_grant', error_description: 'do not log test-only-secret' }, { status: 400 })), /expired or was revoked/);
    assert.equal((await row(h, connection.id)).status, 'reconnect_required'); assert.equal((await row(h, connection.id)).credentials, null);
  } finally { await h.close(); }
});

test('disconnect stops access during an in-flight refresh and keeps notes while pending revocation is retryable', async () => {
  const h = await setup(); try {
    await h.call('contacts', { method: 'POST', body: { name: 'Kept person', notes: 'Private notes remain' } });
    const { connection } = await connect(h, { expires: 1 });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), began = new Promise<void>((resolve) => { entered = resolve; });
    const refresh = h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, await epoch(h), async (url) => {
      if (url.endsWith('/revoke')) return new Response(null, { status: 503 });
      entered(); await gate; return Response.json({ access_token: 'late-access', refresh_token: 'late-rotated-refresh', expires_in: 3600, token_type: 'Bearer' });
    });
    const settled = refresh.then(() => null, (error) => error);
    await began;
    const pending = await h.providers.disconnectGoogleConnection(h.db, actor, environment, connection.id, 1, async () => new Response(null, { status: 503 }));
    assert.equal(pending.revocation_pending, true); release(); assert.match(String(await settled), /CLOUD_RECOVERY_CONFLICT/);
    assert.equal((await row(h, connection.id)).status, 'revocation_pending');
    const late = await row(h, connection.id);
    const lateCredentials = await h.providerVault.openProviderValue<{ refreshToken: string }>(String(late.credentials), binding(connection.id), h.providerVault.providerKeyring(environment.CONNECTOR_TOKEN_KEYRING));
    assert.equal(lateCredentials.refreshToken, 'late-rotated-refresh');
    await assert.rejects(h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, await epoch(h)), /Reconnect/);
    const revision = (await row(h, connection.id)).revision;
    const stopped = await h.providers.disconnectGoogleConnection(h.db, actor, { ...environment, GOOGLE_CONNECTOR_CLIENT_ID: '' }, connection.id, revision, google().fetcher);
    assert.equal(stopped.revocation_pending, false); assert.equal((await row(h, connection.id)).credentials, null);
    assert.equal((await h.db.prepare('SELECT notes FROM contacts').first())!.notes, 'Private notes remain');
  } finally { await h.close(); }
});

test('restore fences old grants and callbacks without exporting or restoring credentials; erasure clears them', async () => {
  const h = await setup(); try {
    const { connection } = await connect(h), originalEpoch = await epoch(h);
    const grant = await h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, originalEpoch);
    const pending = await start(h);
    const backup = await h.call('settings/backups', { method: 'POST' }); assert.equal(backup.status, 201);
    const file = backup.body.backups[0].filename;
    const snapshot = await h.call('settings/backups/' + file); assert.equal(snapshot.status, 200);
    assert.ok(!JSON.stringify(snapshot.body).includes('provider_connections')); assert.ok(!JSON.stringify(snapshot.body).includes('test-only-refresh-secret'));
    const restored = await h.call('settings/restore', { method: 'POST', body: { filename: file, confirmation: 'RESTORE' } }); assert.equal(restored.status, 200);
    assert.notEqual(await epoch(h), originalEpoch);
    assert.equal((await h.providers.listProviderConnections(h.db, actor, environment)).connections[0].status, 'dataset_review_required');
    await assert.rejects(h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, originalEpoch), /dataset changed/);
    await assert.rejects(h.providers.completeGoogleConnection(h.db, actor, environment, pending.parameters, google().fetcher), /expired/);
    await assert.rejects(h.db.batch([h.providers.providerWriteGuard(h.db, grant, 'old-provider-job'), h.db.prepare("INSERT INTO contacts (workspace_id, name) VALUES ('test', 'Stale import')")]), /CLOUD_RECOVERY_CONFLICT/);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM contacts').first())!.n, 0);
    const erased = await h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } }); assert.equal(erased.status, 200);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_connections').first())!.n, 0);
  } finally { await h.close(); }
});

test('connection routes keep web-only authorization and allow security revocation during maintenance', () => {
  const id = crypto.randomUUID();
  for (const route of ['/api/connections', '/api/connections/google/authorize', '/api/connections/google/callback', '/api/connections/' + id]) assert.equal(getCloudApiRewrite(route), route.replace('/api/', '/api/cloud/'));
  assert.equal(getCloudApiRewrite('/api/connections/not-a-uuid'), null); assert.equal(getCloudApiRewrite('/api/connections/google/unexpected'), null);
  for (const lifecycle of ['restoring', 'erasing']) {
    assert.equal(cloudWorkspaceMaintenanceResponse(lifecycle, ['connections'], 'GET'), null);
    assert.equal(cloudWorkspaceMaintenanceResponse(lifecycle, ['connections', id], 'DELETE'), null);
    assert.equal(cloudWorkspaceMaintenanceResponse(lifecycle, ['connections', 'google', 'authorize'], 'POST')?.status, 423);
    assert.equal(cloudWorkspaceMaintenanceResponse(lifecycle, ['connections', 'google', 'callback'], 'GET')?.status, 423);
  }
});

test('lost membership during code exchange cannot attach credentials to a workspace', async () => {
  const h = await setup(); try {
    const pending = await start(h), provider = google();
    await assert.rejects(h.providers.completeGoogleConnection(h.db, actor, environment, pending.parameters, async (url, options) => {
      const response = await provider.fetcher(url, options);
      if (url.endsWith('/userinfo')) await h.db.prepare("DELETE FROM workspace_members WHERE workspace_id = 'test' AND user_id = 'owner'").run();
      return response;
    }), /CLOUD_RECOVERY_CONFLICT/);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_connections').first())!.n, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_authorization_attempts').first())!.n, 0);
  } finally { await h.close(); }
});

test('a transient refresh outage keeps encrypted authorization and a retry uses the same refresh token', async () => {
  const h = await setup(); try {
    const { connection } = await connect(h, { expires: 1 }), before = await row(h, connection.id);
    await assert.rejects(h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, await epoch(h), async () => Response.json({ error: 'temporarily_unavailable', error_description: 'untrusted-provider-details' }, { status: 503 })), /could not be completed/);
    const after = await row(h, connection.id); assert.equal(after.status, 'connected'); assert.equal(after.credentials, before.credentials); assert.equal(after.revision, before.revision); assert.equal(after.lease_token, null);
    const grant = await h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, await epoch(h), async (_url, options) => {
      assert.equal((options.body as URLSearchParams).get('refresh_token'), 'test-only-refresh-secret'); return Response.json({ access_token: 'retried-access', expires_in: 3600, token_type: 'Bearer' });
    });
    assert.equal(grant.accessToken, 'retried-access');
  } finally { await h.close(); }
});

test('scheduled maintenance retries encrypted revocations in bounded batches and clears expired consent attempts', async () => {
  const h = await setup(); try {
    const connections = [];
    for (let i = 0; i < 6; i++) {
      const { connection } = await connect(h, { account: 'account-' + i }); connections.push(connection);
      await h.providers.disconnectGoogleConnection(h.db, actor, environment, connection.id, connection.revision, async () => new Response(null, { status: 503 }));
    }
    await start(h);
    await h.db.prepare('UPDATE provider_authorization_attempts SET expires_at = 1').run();
    const first = await h.providers.maintainProviderConnections(h.db, environment, google().fetcher);
    assert.deepEqual(first, { attempted: 5, revoked: 5, pending: 0 });
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_authorization_attempts').first())!.n, 0);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM provider_connections WHERE credentials IS NOT NULL").first())!.n, 1);
    const second = await h.providers.maintainProviderConnections(h.db, environment, google().fetcher);
    assert.deepEqual(second, { attempted: 1, revoked: 1, pending: 0 });
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM provider_connections WHERE status = 'disconnected'").first())!.n, connections.length);
  } finally { await h.close(); }
});

test('connection HTTP responses redact operational secrets, reject cross-origin revocation and strip failed callback codes', async () => {
  const h = await setup(); try {
    Object.assign(h.emailEnv, environment);
    const { connection } = await connect(h);
    const response = await h.providerApi.handleProviderConnections(new Request('https://test.invalid/api/connections'), actor, ['connections']);
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const text = await response.text(); assert.ok(!text.includes('test-only-access-secret')); assert.ok(!text.includes('test-only-refresh-secret')); assert.ok(!text.includes('credentials'));
    const forbidden = await h.providerApi.handleProviderConnections(new Request('https://test.invalid/api/connections/' + connection.id,
      { method: 'DELETE', headers: { Origin: 'https://unrelated.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: connection.revision }) }), actor, ['connections', connection.id]);
    assert.equal(forbidden.status, 403); assert.equal((await row(h, connection.id)).status, 'connected');
    const callback = await h.providerApi.handleProviderConnections(new Request('https://test.invalid/api/connections/google/callback?state=invalid&code=test-only-private-code'), actor, ['connections', 'google', 'callback']);
    assert.equal(callback.status, 303); assert.equal(callback.headers.get('Location'), '/connections/google?result=failed'); assert.equal(callback.headers.get('Referrer-Policy'), 'no-referrer');
    const oversized = await h.providerApi.handleProviderConnections(new Request('https://test.invalid/api/connections/google/authorize', { method: 'POST', headers: { Origin: environment.BETTER_AUTH_URL }, body: JSON.stringify({ padding: 'x'.repeat(4097) }) }), actor, ['connections', 'google', 'authorize']);
    assert.equal(oversized.status, 413);
  } finally { await h.close(); }
});
