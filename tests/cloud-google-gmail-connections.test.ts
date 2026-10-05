import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';

const metadata = 'https://www.googleapis.com/auth/gmail.metadata';
const contacts = 'https://www.googleapis.com/auth/contacts.readonly';
const actor = { workspaceId: 'test', userId: 'owner', authMethod: 'web' as const };
const environment = { BETTER_AUTH_URL: 'https://test.invalid', GOOGLE_CLIENT_ID: 'login-client',
  GOOGLE_CONNECTOR_CLIENT_ID: 'contacts-client', GOOGLE_CONNECTOR_CLIENT_SECRET: 'fixture-contacts-secret',
  GOOGLE_GMAIL_CLIENT_ID: 'gmail-client', GOOGLE_GMAIL_CLIENT_SECRET: 'fixture-gmail-secret',
  CONNECTOR_TOKEN_KEYRING: JSON.stringify({ active: 'v1', keys: { v1: Buffer.alloc(32, 19).toString('base64url') } }) };
type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
type Purpose = 'gmail' | 'contacts';
async function setup() {
  const h = await createCloudHarness();
  await h.db.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@example.test', 1, 1, 1), ('second', 'Second', 'second@example.test', 1, 1, 1)").run();
  await h.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner'), ('other', 'second', 'owner')").run();
  Object.assign(h.emailEnv, environment);
  return h;
}
async function epoch(h: Harness) { return (await h.db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'test'").first<{ epoch: string }>())!.epoch; }
function google(options: { purpose?: Purpose; scopes?: string; sub?: string; email?: string; mailbox?: string; verified?: boolean; expires?: number; labelStatus?: number } = {}) {
  const calls: Array<{ url: string; request: RequestInit }> = [];
  const fetcher = async (url: string, request: RequestInit) => {
    calls.push({ url, request }); assert.equal(request.redirect, 'error'); assert.ok(request.signal);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer',
      expires_in: options.expires ?? 3600, scope: options.scopes ?? 'openid email profile ' + (options.purpose === 'contacts' ? contacts : metadata) });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: options.sub ?? 'owner-google', email: options.email ?? 'owner@example.test', email_verified: options.verified ?? true, name: 'Mailbox Owner' });
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response(null, { status: 200 });
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, 'https://gmail.googleapis.com');
    assert.equal(request.method, 'GET'); assert.equal(new Headers(request.headers).get('authorization'), 'Bearer fixture-access');
    if (endpoint.pathname.endsWith('/profile')) return Response.json({ emailAddress: options.mailbox ?? options.email ?? 'owner@example.test', historyId: '9007199254740993', messagesTotal: 12 });
    if (endpoint.pathname.endsWith('/labels')) return options.labelStatus
      ? Response.json({ error: { message: 'fixture-access must never appear in the error' } }, { status: options.labelStatus })
      : Response.json({ labels: [{ id: 'INBOX', name: 'Inbox', type: 'system', threadsTotal: 99 }, { id: 'Label_1', name: 'Friends · relações', type: 'user', messagesTotal: 55 }] });
    throw new Error('Unexpected fixture provider endpoint');
  };
  return { calls, fetcher };
}
async function start(h: Harness, extra: Record<string, unknown> = {}) {
  const result = await h.providers.beginGoogleConnection(h.db, actor, environment, { purpose: 'gmail', expected_epoch: await epoch(h), ...extra }, environment.BETTER_AUTH_URL);
  const url = new URL(result.authorization_url);
  return { url, parameters: new URLSearchParams({ state: url.searchParams.get('state')!, code: 'fixture-code' }) };
}
async function connect(h: Harness, options: Parameters<typeof google>[0] = {}) {
  const pending = await start(h, { purpose: options.purpose ?? 'gmail' }), provider = google(options);
  return { connection: await h.providers.completeGoogleConnection(h.db, actor, environment, pending.parameters, provider.fetcher), pending, provider };
}
async function row(h: Harness, id: string) { return (await h.db.prepare('SELECT * FROM provider_connections WHERE id = ?').bind(id).first())!; }
async function api(h: Harness, endpoint: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return h.providerApi.handleProviderConnections(new Request(environment.BETTER_AUTH_URL + '/api/' + endpoint, {
    method: options.method ?? 'GET', headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), actor, endpoint.split('?')[0].split('/'));
}
async function preview(h: Harness, id: string, provider = google()) {
  const opening = await h.gmailConnection.reviewGmailConnection(h.db, actor, id);
  return h.gmailConnection.previewGmailMailbox(h.db, actor, environment, id, { expected_epoch: opening.epoch, expected_authorization_revision: opening.connection.authorization_revision }, provider.fetcher);
}

test('Gmail uses a separate metadata-only PKCE consent and verified mailbox, preserving existing Contacts and notes', async () => {
  const h = await setup(); try {
    await h.call('contacts', { method: 'POST', body: { name: 'Existing person', notes: 'Private relationship history' } });
    const contact = await connect(h, { purpose: 'contacts' }), original = await row(h, contact.connection.id);
    const { connection, pending, provider } = await connect(h);
    assert.notEqual(connection.id, contact.connection.id); assert.equal(connection.purpose, 'gmail');
    assert.equal(pending.url.searchParams.get('client_id'), 'gmail-client');
    assert.equal(pending.url.searchParams.get('scope'), 'openid email profile ' + metadata);
    assert.equal(pending.url.searchParams.get('include_granted_scopes'), 'false');
    assert.equal(pending.url.searchParams.get('redirect_uri'), environment.BETTER_AUTH_URL + '/api/connections/google/callback');
    const token = provider.calls.find((call) => call.url.endsWith('/token'))!.request.body as URLSearchParams;
    assert.equal(token.get('client_secret'), 'fixture-gmail-secret');
    assert.equal(await h.providerVault.providerDigest(token.get('code_verifier')!), pending.url.searchParams.get('code_challenge'));
    assert.deepEqual(await row(h, contact.connection.id), original);
    const stored = await row(h, connection.id); assert.equal(stored.status, 'connected');
    assert.equal(String(stored.credentials).includes('fixture-refresh'), false); assert.equal(String(stored.credentials).includes('fixture-access'), false);
    assert.equal((await h.db.prepare('SELECT notes FROM contacts').first())!.notes, 'Private relationship history');
    assert.equal(await h.providers.googleAuthorizationPurpose(h.db, actor, pending.parameters), null);
    await assert.rejects(h.providers.completeGoogleConnection(h.db, actor, environment, pending.parameters, provider.fetcher), /already used/);
    const listing = await h.providers.listProviderConnections(h.db, actor, environment);
    assert.deepEqual(listing.configured_purposes, { contacts: true, calendar: false, 'calendar-publish': false, gmail: true });
    assert.equal(JSON.stringify(listing).includes('fixture-access'), false);
  } finally { await h.close(); }
});

test('Gmail rejects missing or broader permissions, unverified identity and a mismatched mailbox before storing grants', async () => {
  const h = await setup(); try {
    for (const options of [
      { scopes: 'openid email profile' }, { scopes: 'openid email profile ' + contacts },
      { scopes: 'openid email profile ' + metadata + ' https://www.googleapis.com/auth/gmail.readonly' },
      { scopes: 'openid email profile ' + metadata + ' ' + contacts }, { verified: false }, { mailbox: 'other@example.test' },
    ]) await assert.rejects(connect(h, options), /Gmail metadata|unverified|mailbox does not match/);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM provider_connections').first())!.n, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM provider_authorization_attempts').first())!.n, 0);
    for (const other of ['login-client', 'contacts-client', 'calendar-client', 'publisher-client']) {
      const env = { ...environment, GOOGLE_GMAIL_CLIENT_ID: other, GOOGLE_CALENDAR_CLIENT_ID: 'calendar-client', GOOGLE_CALENDAR_PUBLISH_CLIENT_ID: 'publisher-client' };
      await assert.rejects(h.providers.beginGoogleConnection(h.db, actor, env, { purpose: 'gmail', expected_epoch: await epoch(h) }, environment.BETTER_AUTH_URL), /separate OAuth client/);
    }
  } finally { await h.close(); }
});

test('reauthorization preserves Gmail identity while Contacts and Calendar cannot consume its grant', async () => {
  const h = await setup(); try {
    const { connection } = await connect(h);
    await assert.rejects(h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, await epoch(h), google().fetcher, 'contacts'), /does not authorize/);
    await assert.rejects(h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, await epoch(h), google().fetcher, 'calendar'), /does not authorize/);
    const wrong = await start(h, { connection_id: connection.id, expected_revision: 1 });
    await assert.rejects(h.providers.completeGoogleConnection(h.db, actor, environment, wrong.parameters, google({ sub: 'another', email: 'other@example.test' }).fetcher), /same Google account/);
    assert.equal((await row(h, connection.id)).authorization_revision, 1);
    const correct = await start(h, { connection_id: connection.id, expected_revision: 1 });
    const updated = await h.providers.completeGoogleConnection(h.db, actor, environment, correct.parameters, google().fetcher);
    assert.equal(updated.id, connection.id); assert.equal(updated.authorization_revision, 2);
    await assert.rejects(h.providers.beginGoogleConnection(h.db, actor, environment, { purpose: 'contacts', expected_epoch: await epoch(h), connection_id: connection.id, expected_revision: 2 }, environment.BETTER_AUTH_URL), /changed/);
    await assert.rejects(h.gmailConnection.reviewGmailConnection(h.db, { workspaceId: 'other', userId: 'second' }, connection.id), /not found/);
    await assert.rejects(h.gmailConnection.reviewGmailConnection(h.db, { ...actor, authMethod: 'device' }, connection.id), /web app/);
  } finally { await h.close(); }
});

test('explicit mailbox preview exposes only label identities and does not alter CRM rows or persist private metadata', async () => {
  const h = await setup(); try {
    await h.call('contacts', { method: 'POST', body: { name: 'Kept person', notes: 'Kept note' } });
    const { connection } = await connect(h), original = await h.db.prepare('SELECT * FROM contacts').all();
    const provider = google(), review = await h.gmailConnection.reviewGmailConnection(h.db, actor, connection.id);
    assert.equal(review.can_preview, true); assert.equal(provider.calls.length, 0);
    const labels = await preview(h, connection.id, provider);
    assert.deepEqual(labels, { email: 'owner@example.test', labels: [{ id: 'INBOX', name: 'Inbox', type: 'system' }, { id: 'Label_1', name: 'Friends · relações', type: 'user' }] });
    assert.equal(provider.calls.length, 2); assert.equal(JSON.stringify(labels).includes('historyId'), false);
    assert.deepEqual(await h.db.prepare('SELECT * FROM contacts').all(), original);
    await assert.rejects(h.gmailConnection.previewGmailMailbox(h.db, actor, environment, connection.id, { expected_epoch: review.epoch, expected_authorization_revision: 0 }, provider.fetcher), /changed/);
    await assert.rejects(h.gmailConnection.previewGmailMailbox(h.db, actor, environment, connection.id, { expected_epoch: review.epoch, expected_authorization_revision: 1, import: true }, provider.fetcher), /changed/);
    assert.equal(provider.calls.length, 2);
    const get = await api(h, 'connections/' + connection.id + '/gmail'); assert.equal(get.status, 200); assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.equal((await api(h, 'connections/' + connection.id + '/gmail?token=untrusted')).status, 400);
    assert.equal((await api(h, 'connections/' + connection.id + '/gmail', { method: 'POST', body: {}, headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await api(h, 'connections/' + connection.id + '/gmail', { method: 'POST', body: { oversized: 'x'.repeat(5000) }, headers: { Origin: environment.BETTER_AUTH_URL } })).status, 413);
    const path = '/api/connections/' + connection.id + '/gmail';
    assert.equal(getCloudApiRewrite(path), path.replace('/api/', '/api/cloud/'));
    assert.equal(getCloudApiRewrite(path + '/messages'), null); assert.equal(getCloudApiRewrite('/api/connections/not-a-uuid/gmail'), null);
  } finally { await h.close(); }
});

test('loss of ownership, recovery, disconnect and reauthorization during mailbox reads suppress the fetched labels', async () => {
  for (const change of ['owner', 'epoch', 'disconnect', 'reauthorize'] as const) {
    const h = await setup(); try {
      const { connection } = await connect(h), provider = google();
      const opening = await h.gmailConnection.reviewGmailConnection(h.db, actor, connection.id);
      await assert.rejects(h.gmailConnection.previewGmailMailbox(h.db, actor, environment, connection.id,
        { expected_epoch: opening.epoch, expected_authorization_revision: 1 }, async (url, request) => {
          const response = await provider.fetcher(url, request);
          if (new URL(url).pathname.endsWith('/labels')) {
            if (change === 'owner') await h.db.prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = 'test' AND user_id = 'owner'").run();
            if (change === 'epoch') await h.db.prepare("UPDATE workspace_sync_state SET epoch = ? WHERE workspace_id = 'test'").bind(crypto.randomUUID()).run();
            if (change === 'disconnect') await h.providers.disconnectGoogleConnection(h.db, actor, environment, connection.id, 1, google().fetcher);
            if (change === 'reauthorize') {
              const pending = await start(h, { connection_id: connection.id, expected_revision: 1 });
              await h.providers.completeGoogleConnection(h.db, actor, environment, pending.parameters, google().fetcher);
            }
          }
          return response;
        }), /CLOUD_RECOVERY_CONFLICT/);
      assert.equal(provider.calls.length, 2);
    } finally { await h.close(); }
  }
});

test('provider permission loss clears the grant; retry failures preserve it; mailbox mismatch returns no labels', async () => {
  const h = await setup(); try {
    const { connection } = await connect(h);
    await assert.rejects(preview(h, connection.id, google({ labelStatus: 429 })), /limiting requests/);
    assert.equal((await row(h, connection.id)).status, 'connected'); assert.ok((await row(h, connection.id)).credentials);
    const mismatch = google({ mailbox: 'wrong@example.test' }); await assert.rejects(preview(h, connection.id, mismatch), /identity changed/);
    assert.equal(mismatch.calls.length, 1);
    await assert.rejects(preview(h, connection.id, google({ labelStatus: 403 })), /access is unavailable/);
    assert.equal((await row(h, connection.id)).status, 'reconnect_required'); assert.equal((await row(h, connection.id)).credentials, null);
    assert.equal((await h.gmailConnection.reviewGmailConnection(h.db, actor, connection.id)).can_preview, false);
    await assert.rejects(preview(h, connection.id), /Reconnect/);
  } finally { await h.close(); }
});

test('Gmail refresh uses its dedicated client, stays serialized and cannot restore a disconnected grant', async () => {
  const h = await setup(); try {
    const { connection } = await connect(h, { expires: 1 });
    let entered!: () => void, release!: () => void;
    const began = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    const refresh = h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, await epoch(h), async (url, request) => {
      if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
      const body = request.body as URLSearchParams;
      assert.equal(body.get('client_id'), 'gmail-client'); assert.equal(body.get('refresh_token'), 'fixture-refresh'); entered(); await gate;
      return Response.json({ token_type: 'Bearer', access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600 });
    }, 'gmail');
    const settled = refresh.then(() => null, (error: unknown) => error); await began;
    await assert.rejects(h.providers.googleConnectionAccess(h.db, actor, environment, connection.id, await epoch(h), google().fetcher, 'gmail'), /refreshing/);
    await h.providers.disconnectGoogleConnection(h.db, actor, environment, connection.id, 1, google().fetcher); release();
    assert.match(String(await settled), /CLOUD_RECOVERY_CONFLICT/);
    assert.equal((await row(h, connection.id)).status, 'disconnected'); assert.equal((await row(h, connection.id)).credentials, null);
  } finally { await h.close(); }
});

test('cancelled consent returns to the trusted Gmail page, consumes state and ignores untrusted redirect purposes', async () => {
  const h = await setup(); try {
    const pending = await start(h); pending.parameters.delete('code'); pending.parameters.set('error', 'access_denied');
    pending.parameters.set('purpose', 'https://attacker.invalid');
    assert.equal(await h.providers.googleAuthorizationPurpose(h.db, actor, pending.parameters), 'gmail');
    assert.equal(await h.providers.googleAuthorizationPurpose(h.db, { workspaceId: 'other', userId: 'second' }, pending.parameters), null);
    const reply = await api(h, 'connections/google/callback?' + pending.parameters);
    assert.equal(reply.status, 303); assert.equal(reply.headers.get('location'), '/connections/google/gmail?result=failed');
    assert.equal(reply.headers.get('referrer-policy'), 'no-referrer'); assert.equal(reply.headers.get('cache-control'), 'no-store');
    assert.equal((await api(h, 'connections/google/callback?' + pending.parameters)).headers.get('location'), '/connections/google?result=failed');
    const duplicate = await start(h); duplicate.parameters.append('state', duplicate.parameters.get('state')!);
    assert.equal(await h.providers.googleAuthorizationPurpose(h.db, actor, duplicate.parameters), null);
  } finally { await h.close(); }
});

test('migration 45 preserves every prior table and field and permits only an immutable, separately authorized Gmail purpose', () => {
  const db = new Database(':memory:'); try {
    db.pragma('foreign_keys = ON'); const directory = new URL('../drizzle/', import.meta.url);
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '0045_').sort()) db.exec(readFileSync(new URL(name, directory), 'utf8'));
    db.exec("INSERT INTO workspaces (id, name) VALUES ('upgrade', 'Upgrade'); INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@example.test', 1, 1, 1); INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('upgrade', 'owner', 'owner');");
    const savedEpoch = (db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'upgrade'").get() as { epoch: string }).epoch;
    const insert = db.prepare("INSERT INTO provider_connections (id, workspace_id, user_id, provider, purpose, account_id, email, display_name, granted_scopes, status, dataset_epoch, credentials, revision, created_at, updated_at) VALUES (?, 'upgrade', 'owner', 'google', ?, 'subject', 'owner@example.test', 'Original', '[]', 'connected', ?, 'unchanged-ciphertext', 7, '2026-10-03', '2026-10-03')");
    for (const purpose of ['contacts', 'calendar', 'calendar-publish']) insert.run(crypto.randomUUID(), purpose, savedEpoch);
    db.prepare("INSERT INTO contacts (workspace_id, name, notes) VALUES ('upgrade', 'Original person', 'Original private history')").run();
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    const before = tables.map((name) => ({ name, rows: db.prepare('SELECT * FROM "' + name + '"').all() }));
    assert.throws(() => insert.run(crypto.randomUUID(), 'gmail', savedEpoch), /PROVIDER_CONNECTION_INVALID/);
    db.exec(readFileSync(new URL('0045_google_gmail_consent.sql', directory), 'utf8'));
    assert.deepEqual(tables.map((name) => ({ name, rows: db.prepare('SELECT * FROM "' + name + '"').all() })), before);
    const id = crypto.randomUUID(); insert.run(id, 'gmail', savedEpoch);
    assert.throws(() => insert.run(crypto.randomUUID(), 'gmail-modify', savedEpoch), /PROVIDER_CONNECTION_INVALID/);
    assert.throws(() => db.prepare("UPDATE provider_connections SET purpose = 'contacts' WHERE id = ?").run(id), /PROVIDER_CONNECTION_INVALID/);
    const attempt = db.prepare("INSERT INTO provider_authorization_attempts (state_hash, workspace_id, user_id, dataset_epoch, connection_id, connection_revision, verifier, expires_at, purpose) VALUES (?, 'upgrade', 'owner', ?, ?, 7, 'unchanged-verifier', ?, ?)");
    attempt.run('g'.repeat(43), savedEpoch, id, Date.now() + 60000, 'gmail');
    assert.throws(() => attempt.run('h'.repeat(43), savedEpoch, id, Date.now() + 60000, 'contacts'), /PROVIDER_CONNECTION_INVALID/);
    assert.deepEqual(db.pragma('foreign_key_check'), []); assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally { db.close(); }
});
