import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
const environment = { BETTER_AUTH_URL: 'https://test.invalid', GOOGLE_CLIENT_ID: 'login-client', GOOGLE_CONNECTOR_CLIENT_ID: 'contact-client',
  GOOGLE_CONNECTOR_CLIENT_SECRET: 'test-only-client-secret', CONNECTOR_TOKEN_KEYRING: JSON.stringify({ active: 'v1', keys: { v1: Buffer.alloc(32, 13).toString('base64url') } }) };
const actor = { workspaceId: 'test', userId: 'owner', authMethod: 'web' as const };
async function epoch(h: Harness) { return (await h.db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'test'").first<{ epoch: string }>())!.epoch; }
async function setup(expires = 3600) {
  const h = await createCloudHarness();
  await h.db.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@test.invalid', 1, 1, 1), ('second', 'Second', 'second@test.invalid', 1, 1, 1)").run();
  await h.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner'), ('other', 'second', 'owner')").run();
  const e = await epoch(h);
  const begin = await h.providers.beginGoogleConnection(h.db, actor, environment, { purpose: 'contacts', expected_epoch: e }, environment.BETTER_AUTH_URL);
  const params = new URLSearchParams({ code: 'test-only-code', state: new URL(begin.authorization_url).searchParams.get('state')! });
  const fetcher = async (url: string) => url.endsWith('/userinfo') ? Response.json({ sub: 'google-owner', name: 'Owner', email: 'owner@example.test', email_verified: true })
    : Response.json({ access_token: 'test-only-access-secret', refresh_token: 'test-only-refresh-secret', expires_in: expires, token_type: 'Bearer', scope: 'openid email profile https://www.googleapis.com/auth/contacts.readonly' });
  const c = await h.providers.completeGoogleConnection(h.db, actor, environment, params, fetcher);
  Object.assign(h.emailEnv, environment);
  return { h, c, e, fetcher };
}
function person(sourceId: string, name = sourceId, resourceName = 'people/' + sourceId) {
  const metadata = { sourcePrimary: true, primary: true, source: { type: 'CONTACT', id: sourceId } };
  return { resourceName, metadata: { sources: [{ type: 'CONTACT', id: sourceId, etag: 'version-1' }] }, names: [{ displayName: name, metadata }],
    emailAddresses: [{ value: sourceId + '@example.test', type: 'work', metadata }], phoneNumbers: [{ value: '+351 912 345 678', canonicalForm: '+351912345678', type: 'mobile', metadata }],
    organizations: [{ name: 'Company', title: 'Engineer', metadata }], addresses: [{ city: 'Lisbon', country: 'Portugal', streetAddress: 'Do not keep this', metadata }],
    biographies: [{ value: 'Provider private note must not be copied' }], photos: [{ url: 'https://untrusted.invalid/photo' }] };
}
async function start(h: Harness, c: { id: string; authorization_revision: number }, full = false, operationId = crypto.randomUUID()) {
  return h.contactDownloads.startGoogleContactsDownload(h.db, actor, environment, c.id,
    { operation_id: operationId, expected_epoch: await epoch(h), expected_authorization_revision: c.authorization_revision, full });
}
function input(c: { id: string }, run: { id: string }) {
  return { kind: 'google-contacts' as const, version: 1 as const, workspaceId: 'test', connectionId: c.id, runId: run.id };
}
async function step(h: Harness, c: { id: string }, run: { id: string }, fetcher: (url: string, options: RequestInit) => Promise<Response>) {
  return h.contactDownloads.advanceGoogleContactsDownload(h.db, environment, input(c, run), fetcher);
}
async function review(h: Harness, c: { id: string }, query?: URLSearchParams) { return h.contactDownloads.reviewGoogleContacts(h.db, actor, c.id, query); }
async function complete(h: Harness, c: { id: string; authorization_revision: number }, people = [person('a', 'Ana')]) {
  const run = await start(h, c); await step(h, c, run, async () => Response.json({ connections: people, nextSyncToken: 'test-only-cursor' })); return run;
}

test('People API requests are fixed and bounded; source facts belong to each CONTACT identity', async () => {
  const { h } = await setup(); try {
    const calls: URL[] = [];
    await h.googleContacts.googleContactsPage('test-only-access', { pageToken: 'page-2', syncToken: 'cursor' }, async (url, options) => {
      calls.push(new URL(url)); assert.equal(options.redirect, 'error'); assert.ok(options.signal); assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer test-only-access');
      return Response.json({ connections: [person('a')], nextSyncToken: 'next-cursor' });
    });
    assert.equal(calls[0].origin, 'https://people.googleapis.com'); assert.equal(calls[0].pathname, '/v1/people/me/connections');
    assert.equal(calls[0].searchParams.get('sources'), 'READ_SOURCE_TYPE_CONTACT'); assert.equal(calls[0].searchParams.get('pageSize'), '50');
    assert.equal(calls[0].searchParams.get('requestSyncToken'), 'true'); assert.ok(!calls[0].searchParams.get('personFields')!.includes('biographies'));
    const p = person('a', 'Ana'); p.metadata.sources.push({ type: 'CONTACT', id: 'b', etag: 'version-2' });
    p.names.push({ displayName: 'Beatriz', metadata: { sourcePrimary: true, primary: false, source: { type: 'CONTACT', id: 'b' } } });
    const change = h.googleContacts.readGoogleContactChange(p);
    assert.deepEqual(change.contacts.map((c) => [c.sourceId, c.name]), [['a', 'Ana'], ['b', 'Beatriz']]);
    assert.deepEqual(change.contacts[1].emails, []); assert.equal(change.contacts[0].location, 'Lisbon, Portugal');
    assert.ok(!JSON.stringify(change).includes('Do not keep')); assert.ok(!JSON.stringify(change).includes('Provider private note')); assert.ok(!JSON.stringify(change).includes('untrusted.invalid'));
    assert.throws(() => h.googleContacts.readGoogleContactChange({ ...p, metadata: { sources: [{ type: 'PROFILE', id: 'x' }] } }), /unsupported/);
    const invalid = person('a'); invalid.names[0].displayName = 'x'.repeat(201); assert.throws(() => h.googleContacts.readGoogleContactChange(invalid), /unsupported/);
    await assert.rejects(h.googleContacts.googleContactsPage('access', { pageToken: null, syncToken: null }, async () => new Response('x'.repeat(1024 * 1024 + 1))), /unsupported/);
    await assert.rejects(h.googleContacts.googleContactsPage('access', { pageToken: 'repeat', syncToken: null }, async () => Response.json({ nextPageToken: 'repeat' })), /unsupported/);
  } finally { await h.close(); }
});

test('full downloads publish only after the last page; a failed refresh keeps the old address book and CRM', async () => {
  const { h, c } = await setup(); try {
    const saved = await h.call('contacts', { method: 'POST', body: { name: 'Private relationship', notes: 'Private CRM history' } }); assert.equal(saved.status, 201);
    const run = await start(h, c);
    await step(h, c, run, async () => Response.json({ connections: [person('a', 'Ana')], nextPageToken: 'page-2' }));
    assert.equal((await review(h, c)).count, 0); assert.equal((await review(h, c)).generation, null);
    await step(h, c, run, async (url) => { assert.equal(new URL(url).searchParams.get('pageToken'), 'page-2'); return Response.json({ connections: [person('b', 'Beatriz')], nextSyncToken: 'complete-cursor' }); });
    const before = await review(h, c); assert.equal(before.count, 2); assert.equal(before.run!.status, 'complete');
    let unexpected = false; await step(h, c, run, async () => { unexpected = true; throw new Error(); }); assert.equal(unexpected, false);
    const refresh = await start(h, c, true);
    await step(h, c, refresh, async () => Response.json({ connections: [person('a', 'New Google name')], nextPageToken: 'later' }));
    assert.equal((await review(h, c)).items[0].name, 'Ana');
    const fail = await step(h, c, refresh, async () => Response.json({ connections: [{ resourceName: 'people/b', metadata: {} }], nextSyncToken: 'bad' }));
    assert.equal(fail.status, 'failed'); assert.equal((await review(h, c)).generation, before.generation); assert.equal((await review(h, c)).count, 2);
    const people = (await h.db.prepare("SELECT name, notes FROM contacts WHERE workspace_id = 'test'").all<{ name: string; notes: string }>()).results;
    assert.equal(people.length, 1); assert.equal(people[0].notes, 'Private CRM history');
    assert.ok(!JSON.stringify(before).includes('cursor')); assert.ok(!JSON.stringify(before).includes('access-secret'));
  } finally { await h.close(); }
});

test('incremental downloads stage a copy, follow changed resource names by source ID and apply provider tombstones only to the preview', async () => {
  const { h, c } = await setup(); try {
    await complete(h, c, [person('a', 'Ana'), person('b', 'Beatriz')]); const original = await review(h, c);
    const run = await start(h, c); assert.equal(run.mode, 'delta'); assert.equal(run.phase, 'copy');
    await step(h, c, run, async () => { throw new Error('copy must not fetch Google'); });
    assert.equal((await review(h, c)).generation, original.generation);
    const changed = { ...person('a', 'Ana updated', 'people/new-a'), metadata: { sources: [{ type: 'CONTACT', id: 'a', etag: 'version-2' }], previousResourceNames: ['people/a'] } };
    await step(h, c, run, async (url) => { assert.equal(new URL(url).searchParams.get('syncToken'), 'test-only-cursor');
      return Response.json({ connections: [changed, { resourceName: 'people/b', metadata: { deleted: true } }, person('c', 'Carla')], nextSyncToken: 'incremental-cursor' }); });
    const result = await review(h, c); assert.equal(result.count, 2); assert.deepEqual(result.items.map((p) => [p.sourceId, p.name]), [['a', 'Ana updated'], ['c', 'Carla']]);
    assert.equal(result.items[0].resourceName, 'people/new-a');
    const next = await start(h, c); await step(h, c, next, async () => { throw new Error(); });
    await step(h, c, next, async () => Response.json({ connections: [{ resourceName: 'people/a', metadata: { deleted: true } }], nextSyncToken: 'another-cursor' }));
    assert.equal((await review(h, c)).count, 2, 'an old resource-name tombstone must not remove the newer source record');
  } finally { await h.close(); }
});

test('expired cursors restart a staged full download without replacing the last complete preview', async () => {
  const { h, c } = await setup(); try {
    await complete(h, c); const old = await review(h, c), run = await start(h, c);
    await step(h, c, run, async () => { throw new Error(); });
    const restarted = await step(h, c, run, async () => Response.json({ error: { details: [{ reason: 'EXPIRED_SYNC_TOKEN' }] } }, { status: 400 }));
    assert.equal(restarted.status, 'active'); assert.equal((await review(h, c)).generation, old.generation);
    await step(h, c, run, async (url) => { assert.equal(new URL(url).searchParams.has('syncToken'), false); return Response.json({ connections: [], nextSyncToken: 'fresh' }); });
    assert.equal((await review(h, c)).count, 0); assert.equal((await review(h, c)).run!.mode, 'full');
    await h.db.prepare('UPDATE provider_contact_resources SET cursor_issued_at = ? WHERE connection_id = ?').bind(Date.now() - 6 * 86400_000, c.id).run();
    assert.equal((await start(h, c)).mode, 'full');
  } finally { await h.close(); }
});

test('credential refresh does not invalidate a contact run; explicit reauthorization does', async () => {
  const { h, c, fetcher } = await setup(1); try {
    const run = await start(h, c);
    await step(h, c, run, async (url) => url.startsWith('https://oauth2.googleapis.com') ? fetcher(url) : Response.json({ connections: [person('a')], nextPageToken: 'later' }));
    const refreshed = (await h.db.prepare('SELECT revision, authorization_revision FROM provider_connections WHERE id = ?').bind(c.id).first())!;
    assert.equal(refreshed.revision, 2); assert.equal(refreshed.authorization_revision, 1); assert.equal((await review(h, c)).run!.status, 'active');
    const pending = await h.providers.beginGoogleConnection(h.db, actor, environment, { purpose: 'contacts', expected_epoch: await epoch(h), connection_id: c.id, expected_revision: 2 }, environment.BETTER_AUTH_URL);
    const reauthorized = await h.providers.completeGoogleConnection(h.db, actor, environment, new URLSearchParams({ state: new URL(pending.authorization_url).searchParams.get('state')!, code: 'new-code' }), fetcher);
    assert.equal(reauthorized.authorization_revision, 2); assert.equal((await review(h, c)).run!.status, 'cancelled');
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_contact_index').first())!.n, 0);
    let called = false; await step(h, c, run, async () => { called = true; throw new Error(); }); assert.equal(called, false);
  } finally { await h.close(); }
});

test('disconnect and restore fence in-flight pages; concurrent deliveries cannot fetch the same checkpoint', async () => {
  for (const boundary of ['disconnect', 'restore', 'owner'] as const) {
    const { h, c } = await setup(); try {
      await complete(h, c); const run = await start(h, c, true);
      let release!: () => void, entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }), began = new Promise<void>((resolve) => { entered = resolve; });
      const pending = step(h, c, run, async () => { entered(); await gate; return Response.json({ connections: [person('new', 'Late source')], nextSyncToken: 'late' }); });
      await began; let duplicate = false;
      const second = await step(h, c, run, async () => { duplicate = true; throw new Error(); }); assert.equal(duplicate, false); assert.equal(second.advanced, false);
      if (boundary === 'disconnect') await h.providers.disconnectGoogleConnection(h.db, actor, environment, c.id, c.revision, async () => new Response(null, { status: 200 }));
      else if (boundary === 'restore') await h.db.prepare("UPDATE workspace_sync_state SET epoch = ?, paused = 1 WHERE workspace_id = 'test'").bind(crypto.randomUUID()).run();
      else await h.db.prepare("DELETE FROM workspace_members WHERE workspace_id = 'test' AND user_id = 'owner'").run();
      release(); await pending;
      assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM provider_contact_index WHERE source_id = 'new'").first())!.n, 0);
      await assert.rejects(review(h, c), /Reconnect|owner/);
      if (boundary !== 'owner') assert.equal((await h.db.prepare('SELECT status FROM provider_contact_runs WHERE id = ?').bind(run.id).first())!.status, 'cancelled');
    } finally { await h.close(); }
  }
});

test('download receipts, owner boundaries, generation paging and literal searches are enforced', async () => {
  const { h, c } = await setup(); try {
    const operation = crypto.randomUUID(), run = await start(h, c, false, operation);
    assert.equal((await start(h, c, false, operation)).id, run.id); await assert.rejects(start(h, c, true, operation), /new download/);
    await assert.rejects(start(h, c), /CLOUD_RECOVERY_CONFLICT/);
    await assert.rejects(h.contactDownloads.reviewGoogleContacts(h.db, { ...actor, workspaceId: 'other', userId: 'second' }, c.id), /Reconnect/);
    await assert.rejects(h.contactDownloads.reviewGoogleContacts(h.db, { ...actor, authMethod: 'device' }, c.id), /web app/);
    const people = Array.from({ length: 51 }, (_, i) => person('id' + String(i).padStart(3, '0'), i === 0 ? '100%_match' : 'Name ' + i));
    await step(h, c, run, async () => Response.json({ connections: people.slice(0, 50), nextPageToken: 'last' }));
    await step(h, c, run, async () => Response.json({ connections: people.slice(50), nextSyncToken: 'cursor' }));
    const first = await review(h, c); assert.equal(first.items.length, 50); assert.equal(first.next_after, 'id049');
    const second = await review(h, c, new URLSearchParams({ generation: first.generation!, after: first.next_after! })); assert.equal(second.items.length, 1);
    const search = await review(h, c, new URLSearchParams({ q: '%_' })); assert.equal(search.items.length, 1); assert.equal(search.items[0].name, '100%_match');
    const stale = first.generation!, refresh = await start(h, c, true); await step(h, c, refresh, async () => Response.json({ connections: [], nextSyncToken: 'new' }));
    await assert.rejects(review(h, c, new URLSearchParams({ generation: stale, after: 'id049' })), /changed/);
  } finally { await h.close(); }
});

test('rate limits use durable retry deadlines and stop after repeated failures; queue loss can be reconciled', async () => {
  const { h, c } = await setup(); try {
    await complete(h, c); const old = await review(h, c), run = await start(h, c, true);
    const messages: unknown[] = [], queue = { send: async (value: unknown) => { messages.push(value); } };
    await h.contactDownloads.reconcileGoogleContactsDownloads(h.db, queue); assert.equal(messages.length, 1);
    for (let i = 0; i < 9; i++) {
      await h.db.prepare('UPDATE provider_contact_runs SET next_attempt_at = 0 WHERE id = ?').bind(run.id).run();
      const result = await step(h, c, run, async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }));
      assert.equal(result.status, i === 8 ? 'failed' : 'active'); if (i < 8) assert.equal(result.retryAfter, 120);
      let premature = false; if (i < 8) await step(h, c, run, async () => { premature = true; throw new Error(); }); assert.equal(premature, false);
    }
    assert.equal((await review(h, c)).run!.issue, 'retry_exhausted'); assert.equal((await review(h, c)).generation, old.generation);
    assert.equal(h.contactDownloads.readGoogleContactsQueueMessage({ kind: 'google-contacts', version: 2, workspaceId: 'test', connectionId: c.id, runId: run.id }), null);
    let acknowledged = false;
    await h.contactDownloads.processGoogleContactsMessage({ body: input(c, run), attempts: 1, ack: () => { acknowledged = true; }, retry: () => { throw new Error('terminal work must not retry'); } }, h.emailEnv as unknown as CloudflareEnv);
    assert.equal(acknowledged, true);
  } finally { await h.close(); }
});

test('Google contact HTTP routes require the owner and exact origin and never expose cursors or credentials', async () => {
  const { h, c, e } = await setup(); try {
    const path = ['connections', c.id, 'contacts'];
    for (const suffix of ['/contacts', '/contacts/step']) assert.equal(getCloudApiRewrite('/api/connections/' + c.id + suffix), '/api/cloud/connections/' + c.id + suffix);
    assert.equal(getCloudApiRewrite('/api/connections/' + c.id + '/contacts/unsafe'), null);
    h.emailEnv.GOOGLE_CONTACTS_QUEUE = { send: async () => {} };
    const body = { operation_id: crypto.randomUUID(), expected_epoch: e, expected_authorization_revision: c.authorization_revision };
    const request = (origin: string, data = body) => new Request('https://test.invalid/api/' + path.join('/'), { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await h.providerApi.handleProviderConnections(request('https://attacker.invalid'), actor, path)).status, 403);
    const response = await h.providerApi.handleProviderConnections(request('https://test.invalid'), actor, path); assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const read = await h.providerApi.handleProviderConnections(new Request('https://test.invalid/api/' + path.join('/')), actor, path);
    const projection = await read.json(); assert.equal(projection.run.status, 'active'); assert.ok(!JSON.stringify(projection).includes('test-only-cursor')); assert.ok(!JSON.stringify(projection).includes('secret'));
    const denied = await h.providerApi.handleProviderConnections(new Request('https://test.invalid/api/' + path.join('/')), { ...actor, authMethod: 'device' }, path); assert.equal(denied.status, 403);
    const empty = await h.providerApi.handleProviderConnections(new Request('https://test.invalid/api/' + path.join('/') + '/step', { method: 'POST', headers: { Origin: 'https://test.invalid', 'Content-Type': 'application/json' }, body: '{}' }), actor, [...path, 'step']); assert.equal(empty.status, 409);
  } finally { await h.close(); }
});

test('provider previews and download checkpoints stay outside portable recovery and are removed on restore and erasure', async () => {
  const { h, c } = await setup(); try {
    await complete(h, c, [person('provider-only-identity', 'SourceNameNotCRM')]);
    const backup = await h.call('settings/backups', { method: 'POST' }); assert.equal(backup.status, 201);
    const file = backup.body.backups[0].filename, snapshot = await h.call('settings/backups/' + file); assert.equal(snapshot.status, 200);
    for (const value of ['provider_contact_resources', 'provider_contact_runs', 'provider_contact_index', 'SourceNameNotCRM', 'test-only-cursor', 'test-only-refresh-secret']) assert.ok(!JSON.stringify(snapshot.body).includes(value));
    const pending = await start(h, c, true);
    assert.equal((await h.call('settings/restore', { method: 'POST', body: { filename: file, confirmation: 'RESTORE' } })).status, 200);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_contact_index').first())!.n, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_contact_resources').first())!.n, 0);
    assert.equal((await h.db.prepare('SELECT status FROM provider_contact_runs WHERE id = ?').bind(pending.id).first())!.status, 'cancelled');
    const erased = await h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } }); assert.equal(erased.status, 200);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_contact_runs').first())!.n, 0);
  } finally { await h.close(); }
});

test('queue checkpoints can be redelivered after publication without another provider fetch', async () => {
  const { h, c } = await setup(); try {
    const run = await start(h, c), sent: unknown[] = [];
    h.emailEnv.GOOGLE_CONTACTS_QUEUE = { send: async (body: unknown) => { sent.push(body); } };
    const env = h.emailEnv as unknown as CloudflareEnv;
    let ack = 0, calls = 0;
    const delivery = { body: input(c, run), attempts: 1, ack: () => { ack++; }, retry: () => { throw new Error('healthy page must not retry'); } };
    await h.contactDownloads.processGoogleContactsMessage(delivery, env, async () => { calls++; return Response.json({ connections: [person('a')], nextPageToken: 'last' }); });
    assert.equal(sent.length, 1); assert.equal(ack, 1); assert.equal((await review(h, c)).generation, null);
    await h.contactDownloads.processGoogleContactsMessage(delivery, env, async () => { calls++; return Response.json({ connections: [person('b')], nextSyncToken: 'complete' }); });
    assert.equal(ack, 2); assert.equal((await review(h, c)).count, 2); assert.equal(sent.length, 1);
    await h.contactDownloads.processGoogleContactsMessage(delivery, env, async () => { throw new Error('must not fetch a terminal run'); });
    assert.equal(ack, 3); assert.equal(calls, 2);
  } finally { await h.close(); }
});

test('the address-book capacity bound rolls back the entire overflowing page and keeps the published generation', async () => {
  const { h, c } = await setup(); try {
    await complete(h, c); const before = await review(h, c), run = await start(h, c, true);
    const row = (await h.db.prepare('SELECT generation FROM provider_contact_runs WHERE id = ?').bind(run.id).first<{ generation: string }>())!;
    const facts = JSON.stringify(h.googleContacts.readGoogleContactChange(person('seed')).contacts[0]);
    await h.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 19999)
      INSERT INTO provider_contact_index (connection_id, generation, source_id, resource_name, facts, observed_at)
      SELECT ?, ?, 'seed' || x, 'people/seed' || x, json_set(?, '$.sourceId', 'seed' || x, '$.resourceName', 'people/seed' || x), ? FROM n`)
      .bind(c.id, row.generation, facts, new Date().toISOString()).run();
    const failed = await step(h, c, run, async () => Response.json({ connections: [person('new-one'), person('new-two')], nextSyncToken: 'overflow' }));
    assert.equal(failed.status, 'failed'); assert.equal((await review(h, c)).run!.issue, 'capacity'); assert.equal((await review(h, c)).generation, before.generation);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_contact_index WHERE connection_id = ? AND generation = ?').bind(c.id, row.generation).first())!.n, 19999);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM provider_contact_index WHERE source_id LIKE 'new-%'").first())!.n, 0);
  } finally { await h.close(); }
});

test('quota errors preserve authorization, while missing Contacts permission cancels work and requires reconnecting', async () => {
  const { h, c } = await setup(); try {
    await complete(h, c); const run = await start(h, c, true);
    const quota = await step(h, c, run, async () => Response.json({ error: { details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] } }, { status: 403 }));
    assert.equal(quota.status, 'active'); assert.equal((await h.providers.listProviderConnections(h.db, actor, environment)).connections[0].status, 'connected');
    await h.db.prepare('UPDATE provider_contact_runs SET next_attempt_at = 0 WHERE id = ?').bind(run.id).run();
    const permission = await step(h, c, run, async () => Response.json({ error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, { status: 403 }));
    assert.equal(permission.status, 'cancelled');
    assert.equal((await h.providers.listProviderConnections(h.db, actor, environment)).connections[0].status, 'reconnect_required');
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_contact_index').first())!.n, 0);
    assert.equal((await h.db.prepare('SELECT credentials FROM provider_connections WHERE id = ?').bind(c.id).first())!.credentials, null);
    await assert.rejects(review(h, c), /Reconnect/);
  } finally { await h.close(); }
});

test('a download cannot start from an address-book generation replaced between its read and commit', async () => {
  const { h, c } = await setup(); try {
    await complete(h, c);
    const stale = await h.db.prepare('SELECT * FROM provider_contact_resources WHERE connection_id = ?').bind(c.id).first();
    const newer = await start(h, c, true); await step(h, c, newer, async () => Response.json({ connections: [person('new', 'New complete source')], nextSyncToken: 'new-cursor' }));
    const published = await review(h, c);
    const racingDb = new Proxy(h.db, { get(target, key) {
      if (key === 'prepare') return (sql: string) => sql === 'SELECT * FROM provider_contact_resources WHERE connection_id = ?'
        ? { bind: () => ({ first: async () => stale }) } : target.prepare(sql);
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await assert.rejects(h.contactDownloads.startGoogleContactsDownload(racingDb, actor, environment, c.id,
      { operation_id: crypto.randomUUID(), expected_epoch: await epoch(h), expected_authorization_revision: c.authorization_revision }), /CLOUD_RECOVERY_CONFLICT/);
    assert.equal((await review(h, c)).generation, published.generation);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM provider_contact_runs WHERE status = 'active'").first())!.n, 0);
  } finally { await h.close(); }
});
