import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { googleActor as actor, googleEnvironment, stagedGoogleContact } from './helpers/google-contact-fixture.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';
type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
const environment = { ...googleEnvironment, GOOGLE_CALENDAR_CLIENT_ID: 'calendar-reader', GOOGLE_CALENDAR_CLIENT_SECRET: 'reader-secret',
  GOOGLE_CALENDAR_PUBLISH_CLIENT_ID: 'calendar-publisher', GOOGLE_CALENDAR_PUBLISH_CLIENT_SECRET: 'publisher-secret' };
const publishScopes = 'openid email profile https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.app.created';
const readScopes = 'openid email profile https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly';
async function connect(h: Harness, purpose: 'calendar-publish' | 'calendar' = 'calendar-publish', existing?: string, scopes?: string, expires = 3600) {
  Object.assign(h.emailEnv, environment);
  await h.db.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@test.invalid', 1, 1, 1)").run();
  await h.db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner')").run();
  const epoch = (await h.db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'test'").first<{ epoch: string }>())!.epoch;
  const prior = existing ? await h.db.prepare('SELECT revision FROM provider_connections WHERE id = ?').bind(existing).first<{ revision: number }>() : null;
  const started = await h.providers.beginGoogleConnection(h.db, actor, environment, { purpose, expected_epoch: epoch,
    ...(prior ? { connection_id: existing, expected_revision: prior.revision } : {}) }, environment.BETTER_AUTH_URL);
  const url = new URL(started.authorization_url);
  assert.equal(url.searchParams.get('scope'), purpose === 'calendar-publish' ? publishScopes : readScopes);
  const connection = await h.providers.completeGoogleConnection(h.db, actor, environment, new URLSearchParams({ state: url.searchParams.get('state')!, code: 'test-code' }), async (address, request) => {
    if (address.endsWith('/userinfo')) return Response.json({ sub: 'google-owner', email: 'owner@example.test', email_verified: true, name: 'Calendar Owner' });
    assert.equal((request.body as URLSearchParams).get('client_id'), purpose === 'calendar-publish' ? 'calendar-publisher' : 'calendar-reader');
    return Response.json({ access_token: 'publishing-access', refresh_token: 'publishing-refresh', token_type: 'Bearer', expires_in: expires, scope: scopes ?? (purpose === 'calendar-publish' ? publishScopes : readScopes) });
  });
  return { connection, epoch };
}
type Connected = Awaited<ReturnType<typeof connect>>;
async function start(h: Harness, c: Connected, zone = 'Europe/Lisbon') {
  const body = { operation_id: crypto.randomUUID(), expected_epoch: c.epoch, expected_authorization_revision: c.connection.authorization_revision, time_zone: zone };
  const setup = await h.ownedCalendar.startOwnedCalendar(h.db, actor, environment, c.connection.id, body); return { body, setup };
}
async function step(h: Harness, c: Connected, fetcher: Parameters<Harness['ownedCalendar']['advanceOwnedCalendar']>[5], db = h.db) {
  const review = await h.ownedCalendar.reviewOwnedCalendar(db, actor, c.connection.id);
  return h.ownedCalendar.advanceOwnedCalendar(db, actor, environment, c.connection.id, { operation_id: review.setup!.operation_id, expected_revision: review.setup!.revision,
    expected_epoch: review.epoch, expected_authorization_revision: review.authorization_revision }, fetcher);
}
async function marker(h: Harness, c: Connected) {
  const row = await h.db.prepare('SELECT request_json FROM provider_owned_calendars WHERE connection_id = ?').bind(c.connection.id).first<{ request_json: string }>();
  return (JSON.parse(row!.request_json) as { calendar: { summary: string; timeZone: string; description: string } }).calendar;
}
const calendar = (body: object, id = 'app-created@example.test') => ({ ...body, id, accessRole: 'owner', primary: false, hidden: true });
async function count(h: Harness, table: string) { return (await h.db.prepare('SELECT COUNT(*) AS n FROM ' + table).first<{ n: number }>())!.n; }

test('publishing consent is isolated from reading and Contacts, rejects broad grants and shares no credentials', async () => {
  const h = await createCloudHarness();
  try {
    const contacts = await stagedGoogleContact(h), reader = await connect(h, 'calendar'), writer = await connect(h);
    assert.equal(await count(h, 'provider_connections'), 3); assert.notEqual(reader.connection.id, writer.connection.id);
    assert.equal((await h.providers.listProviderConnections(h.db, actor, environment)).configured_purposes['calendar-publish'], true);
    const invalid = { ...environment, GOOGLE_CALENDAR_PUBLISH_CLIENT_ID: environment.GOOGLE_CALENDAR_CLIENT_ID };
    await assert.rejects(h.providers.beginGoogleConnection(h.db, actor, invalid, { purpose: 'calendar-publish', expected_epoch: writer.epoch }, environment.BETTER_AUTH_URL), /separate OAuth client/);
    await assert.rejects(connect(h, 'calendar-publish', writer.connection.id, publishScopes + ' https://www.googleapis.com/auth/calendar.events'), /dedicated Google connection client/);
    assert.equal((await h.ownedCalendar.reviewOwnedCalendar(h.db, actor, writer.connection.id)).can_continue, true);
    await assert.rejects(h.ownedCalendar.reviewOwnedCalendar(h.db, actor, reader.connection.id), /not found/);
    assert.equal((await h.contactDownloads.reviewGoogleContacts(h.db, actor, contacts.connection.id)).count, 1);
    assert.equal(await count(h, 'provider_owned_calendars'), 0);
  } finally { await h.close(); }
});

test('setup is local until creation, freezes the review and enforces web owner, origin, exact routes and epochs', async () => {
  const h = await createCloudHarness();
  try {
    const c = await connect(h);
    for (const zone of ['+01:00', 'Broken/Zone']) await assert.rejects(start(h, c, zone), /timezone name/);
    assert.equal(await count(h, 'provider_owned_calendars'), 0);
    const s = await start(h, c);
    assert.equal(s.setup.attempted, false); assert.equal(s.setup.status, 'pending');
    assert.deepEqual(await h.ownedCalendar.startOwnedCalendar(h.db, actor, environment, c.connection.id, s.body), s.setup);
    await assert.rejects(h.ownedCalendar.startOwnedCalendar(h.db, actor, environment, c.connection.id, { ...s.body, time_zone: 'UTC' }), /already has a calendar setup/);
    await assert.rejects(h.ownedCalendar.startOwnedCalendar(h.db, actor, environment, c.connection.id, { ...s.body, expected_epoch: crypto.randomUUID() }), /Review/);
    await assert.rejects(h.ownedCalendar.reviewOwnedCalendar(h.db, { ...actor, authMethod: 'device' }, c.connection.id), /web/);
    await assert.rejects(h.ownedCalendar.reviewOwnedCalendar(h.db, { ...actor, userId: 'stranger' }, c.connection.id), /owner/);
    const endpoint = '/api/connections/' + c.connection.id + '/owned-calendar';
    assert.ok(getCloudApiRewrite(endpoint)); assert.ok(getCloudApiRewrite(endpoint + '/step'));
    assert.equal(getCloudApiRewrite(endpoint + '/delete-all'), null);
    const denied = await h.providerApi.handleProviderConnections(new Request(environment.BETTER_AUTH_URL + endpoint, { method: 'POST', headers: { Origin: 'https://wrong.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify(s.body) }), actor, ['connections', c.connection.id, 'owned-calendar']);
    assert.equal(denied.status, 403);
    const review = await h.providerApi.handleProviderConnections(new Request(environment.BETTER_AUTH_URL + endpoint), actor, ['connections', c.connection.id, 'owned-calendar']);
    assert.equal(review.status, 200); assert.equal(review.headers.get('Cache-Control'), 'no-store');
    await assert.rejects(h.db.prepare("UPDATE provider_owned_calendars SET request_json = '{}' WHERE connection_id = ?").bind(c.connection.id).run(), /INVALID/);
    await assert.rejects(h.db.prepare('UPDATE provider_owned_calendars SET revision = 1.5 WHERE connection_id = ?').bind(c.connection.id).run(), /INVALID/);
    await h.ownedCalendar.discardUnsentOwnedCalendar(h.db, actor, c.connection.id, { operation_id: s.body.operation_id, expected_revision: s.setup.revision });
    const normalized = await start(h, c, 'PST');
    assert.equal(normalized.setup.chosen_time_zone, 'America/Los_Angeles');
    assert.equal((await marker(h, c)).timeZone, 'America/Los_Angeles');
  } finally { await h.close(); }
});

test('creation marks the attempt before Google and subsequent checks only verify the original calendar', async () => {
  const h = await createCloudHarness();
  try {
    const c = await connect(h); await start(h, c);
    const request = await marker(h, c); let posts = 0, reads = 0;
    const ready = await step(h, c, async (address, init) => {
      assert.equal(new URL(address).pathname, '/calendar/v3/calendars'); assert.equal(init.method, 'POST'); posts++;
      assert.deepEqual(JSON.parse(init.body as string), request);
      assert.equal((await h.ownedCalendar.reviewOwnedCalendar(h.db, actor, c.connection.id)).setup!.attempted, true);
      return Response.json(calendar(request));
    });
    assert.equal(ready.status, 'ready'); assert.equal(ready.calendar_id, 'app-created@example.test');
    const verified = await step(h, c, async (address, init) => { assert.equal(init.method, 'GET'); reads++; assert.ok(address.includes('/calendarList/app-created%40example.test')); return Response.json(calendar({ ...request, summary: 'Renamed in Google', timeZone: 'UTC' })); });
    assert.equal(verified.status, 'ready'); assert.equal(verified.chosen_time_zone, 'Europe/Lisbon'); assert.deepEqual([posts, reads], [1, 1]);
    await assert.rejects(h.db.prepare('UPDATE provider_owned_calendars SET attempted = 0 WHERE connection_id = ?').bind(c.connection.id).run(), /INVALID/);
    await assert.rejects(h.ownedCalendar.discardUnsentOwnedCalendar(h.db, actor, c.connection.id, { operation_id: ready.operation_id, expected_revision: verified.revision }), /may have reached Google/);
    for (const table of ['contacts', 'plans', 'interactions', 'provider_calendar_runs']) assert.equal(await count(h, table), 0);
  } finally { await h.close(); }
});

test('lost creation replies reconcile all list pages including hidden calendars, without repeating creation', async () => {
  const h = await createCloudHarness();
  try {
    const c = await connect(h); await start(h, c); const request = await marker(h, c); let posts = 0;
    const lost = await step(h, c, async (_, init) => { assert.equal(init.method, 'POST'); posts++; throw new Error('Reply lost'); });
    assert.equal(lost.status, 'unknown'); assert.equal(lost.issue, 'retry');
    let pages = 0;
    const found = await step(h, c, async (address, init) => {
      assert.equal(init.method, 'GET'); const url = new URL(address); pages++;
      assert.equal(url.searchParams.get('showHidden'), 'true'); assert.equal(url.searchParams.get('minAccessRole'), 'owner');
      return Response.json(pages === 1 ? { items: [calendar({ ...request, description: 'Other calendar' }, 'other@example.test')], nextPageToken: 'second' }
        : { items: [calendar(request)] });
    });
    assert.deepEqual([found.status, posts, pages], ['ready', 1, 2]);
  } finally { await h.close(); }
});

test('empty, ambiguous, malformed and cyclic discovery remain unconfirmed and never resend creation', async () => {
  for (const scenario of ['empty', 'ambiguous', 'malformed', 'cycle', 'too-many']) {
    const h = await createCloudHarness();
    try {
      const c = await connect(h); await start(h, c); const request = await marker(h, c);
      await step(h, c, async () => Response.json({ id: 'bad-ack' }));
      let reads = 0;
      const result = await step(h, c, async (_, init) => {
        assert.equal(init.method, 'GET'); reads++;
        return Response.json(scenario === 'empty' ? { items: [] } : scenario === 'ambiguous' ? { items: [calendar(request), calendar(request, 'second@example.test')] }
          : scenario === 'malformed' ? { items: [calendar({ ...request, summary: '', timeZone: 'Broken/Zone' })] }
            : scenario === 'cycle' ? { items: [], nextPageToken: 'same' } : { items: Array.from({ length: 251 }, () => calendar(request)) });
      });
      assert.equal(result.status, 'unknown'); assert.equal(result.calendar_id, null);
      assert.equal(result.issue, scenario === 'empty' ? 'not_visible' : scenario === 'ambiguous' ? 'ambiguous' : 'invalid');
      assert.equal(reads, scenario === 'cycle' ? 2 : 1);
    } finally { await h.close(); }
  }
});

test('a real completion transaction failure retains the attempt and repairs by discovery', async () => {
  const h = await createCloudHarness();
  try {
    const c = await connect(h); await start(h, c); const request = await marker(h, c); let armed = false;
    const db = new Proxy(h.db, { get(target, key) {
      if (key === 'batch') return async (statements: Parameters<typeof h.db.batch>[0]) => {
        if (armed) { armed = false; return target.batch([...statements, target.prepare('INSERT INTO provider_owned_calendars SELECT * FROM provider_owned_calendars WHERE connection_id = ?').bind(c.connection.id)]); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await assert.rejects(step(h, c, async () => { armed = true; return Response.json(calendar(request)); }, db), /INVALID|UNIQUE|constraint/);
    assert.equal(armed, false);
    const retained = await h.ownedCalendar.reviewOwnedCalendar(h.db, actor, c.connection.id);
    assert.equal(retained.setup!.attempted, true); assert.equal(retained.setup!.calendar_id, null); assert.equal(retained.setup!.status, 'unknown');
    const repaired = await step(h, c, async (_, init) => { assert.equal(init.method, 'GET'); return Response.json({ items: [calendar(request)] }); });
    assert.equal(repaired.status, 'ready');
  } finally { await h.close(); }
});

test('late replies cannot publish across authorization, epoch, expiry, owner or lease changes; attempted setup survives new consent', async () => {
  for (const change of ['authorization', 'epoch', 'expiry', 'owner', 'lease']) {
    const h = await createCloudHarness();
    try {
      const c = await connect(h); await start(h, c); const request = await marker(h, c); let posts = 0;
      await assert.rejects(step(h, c, async (_, init) => {
        assert.equal(init.method, 'POST'); posts++;
        if (change === 'authorization') await h.db.prepare("UPDATE provider_connections SET authorization_revision = authorization_revision + 1, status = 'reconnect_required', credentials = NULL WHERE id = ?").bind(c.connection.id).run();
        if (change === 'epoch') await h.db.prepare("UPDATE workspace_sync_state SET epoch = ? WHERE workspace_id = 'test'").bind(crypto.randomUUID()).run();
        if (change === 'expiry') await h.db.prepare('UPDATE provider_connections SET refresh_expires_at = ? WHERE id = ?').bind(Date.now() - 1, c.connection.id).run();
        if (change === 'owner') await h.db.prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = 'test' AND user_id = 'owner'").run();
        if (change === 'lease') await h.db.prepare('UPDATE provider_owned_calendars SET lease_until = ? WHERE connection_id = ?').bind(Date.now() - 1, c.connection.id).run();
        return Response.json(calendar(request));
      }));
      const retained = await h.db.prepare('SELECT attempted, status, calendar_id FROM provider_owned_calendars WHERE connection_id = ?').bind(c.connection.id).first<{ attempted: number; status: string; calendar_id: string | null }>();
      assert.equal(retained!.attempted, 1); assert.notEqual(retained!.status, 'ready'); assert.equal(retained!.calendar_id, null);
      if (change === 'owner') await h.db.prepare("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = 'test' AND user_id = 'owner'").run();
      const renewed = change === 'lease' || change === 'owner' ? c : await connect(h, 'calendar-publish', c.connection.id);
      const verified = await step(h, renewed, async (_, init) => { assert.equal(init.method, 'GET'); return Response.json({ items: [calendar(request)] }); });
      assert.equal(verified.status, 'ready'); assert.equal(posts, 1);
    } finally { await h.close(); }
  }
});

test('overlapping creation has one sender and permission loss retains the attempt for reconnection', async () => {
  const h = await createCloudHarness();
  try {
    const c = await connect(h); await start(h, c);
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; }), releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const first = step(h, c, async () => { entered(); await releasePromise; return new Response(null, { status: 401 }); });
    await enteredPromise;
    await assert.rejects(step(h, c, async () => { assert.fail('Second creation'); }), /being verified/); release();
    assert.equal((await first).status, 'held');
    const row = await h.db.prepare('SELECT status, credentials FROM provider_connections WHERE id = ?').bind(c.connection.id).first<{ status: string; credentials: string | null }>();
    assert.deepEqual(row, { status: 'reconnect_required', credentials: null });
    const renewed = await connect(h, 'calendar-publish', c.connection.id), request = await marker(h, c);
    assert.equal((await step(h, renewed, async (_, init) => { assert.equal(init.method, 'GET'); return Response.json({ items: [calendar(request)] }); })).status, 'ready');
  } finally { await h.close(); }
});

test('CRM restoration excludes operational setup but holds both unsent and attempted requests; erasure cascades', async () => {
  const h = await createCloudHarness();
  try {
    const c = await connect(h), s = await start(h, c);
    const backup = await h.call('settings/backups', { method: 'POST' }), filename = backup.body.backups[0].filename;
    const snapshot = await h.call('settings/backups/' + filename);
    assert.equal(snapshot.status, 200); assert.doesNotMatch(JSON.stringify(snapshot.body), /provider_owned_calendars|publishing-refresh|Everclose calendar recovery/);
    assert.equal((await h.call('settings/restore', { method: 'POST', body: { filename, confirmation: 'RESTORE' } })).status, 200);
    const renewed = await connect(h, 'calendar-publish', c.connection.id), review = await h.ownedCalendar.reviewOwnedCalendar(h.db, actor, c.connection.id);
    assert.equal(review.setup!.status, 'held'); assert.equal(review.unsent_access_changed, true);
    await assert.rejects(step(h, renewed, async () => { assert.fail('Old unsent request'); }), /earlier consent/);
    await h.ownedCalendar.discardUnsentOwnedCalendar(h.db, actor, c.connection.id, { operation_id: s.body.operation_id, expected_revision: review.setup!.revision });
    await start(h, renewed, 'UTC'); const request = await marker(h, c);
    const ready = await step(h, renewed, async () => Response.json(calendar(request)));
    assert.equal((await h.call('settings/restore', { method: 'POST', body: { filename, confirmation: 'RESTORE' } })).status, 200);
    const held = await h.ownedCalendar.reviewOwnedCalendar(h.db, actor, c.connection.id);
    assert.equal(held.setup!.status, 'held'); assert.equal(held.setup!.calendar_id, ready.calendar_id); assert.equal(held.setup!.attempted, true);
    assert.equal((await h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } })).status, 200);
    assert.equal(await count(h, 'provider_owned_calendars'), 0); assert.equal(await count(h, 'provider_connections'), 0);
  } finally { await h.close(); }
});

test('publishing token refresh uses only its dedicated client and project revocation retains the calendar identity', async () => {
  const h = await createCloudHarness();
  try {
    const c = await connect(h, 'calendar-publish', undefined, undefined, 1); await start(h, c);
    const request = await marker(h, c); let tokens = 0, posts = 0;
    const ready = await step(h, c, async (address, init) => {
      if (address.includes('oauth2.googleapis.com/token')) {
        tokens++; assert.equal((init.body as URLSearchParams).get('client_id'), environment.GOOGLE_CALENDAR_PUBLISH_CLIENT_ID);
        assert.equal((init.body as URLSearchParams).get('grant_type'), 'refresh_token');
        return Response.json({ access_token: 'refreshed-publishing', token_type: 'Bearer', expires_in: 3600, scope: publishScopes });
      }
      posts++; assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer refreshed-publishing');
      return Response.json(calendar(request));
    });
    assert.deepEqual([ready.status, tokens, posts], ['ready', 1, 1]);
    const current = (await h.providers.listProviderConnections(h.db, actor, environment)).connections.find((row) => row.id === c.connection.id)!;
    await h.providers.disconnectGoogleConnection(h.db, actor, environment, c.connection.id, current.revision, async () => new Response(null, { status: 200 }));
    const retained = await h.ownedCalendar.reviewOwnedCalendar(h.db, actor, c.connection.id);
    assert.equal(retained.can_continue, false); assert.equal(retained.setup!.status, 'held'); assert.equal(retained.setup!.calendar_id, ready.calendar_id);
  } finally { await h.close(); }
});

test('changing the OAuth publishing client cannot send an unsent review created for the previous app', async () => {
  const h = await createCloudHarness();
  try {
    const c = await connect(h); await start(h, c);
    const review = await h.ownedCalendar.reviewOwnedCalendar(h.db, actor, c.connection.id), rotated = { ...environment, GOOGLE_CALENDAR_PUBLISH_CLIENT_ID: 'new-publishing-app' };
    await assert.rejects(h.ownedCalendar.advanceOwnedCalendar(h.db, actor, rotated, c.connection.id, {
      operation_id: review.setup!.operation_id, expected_revision: review.setup!.revision, expected_epoch: c.epoch, expected_authorization_revision: c.connection.authorization_revision,
    }, async () => { assert.fail('Old review must not create a calendar under a new app'); }), /different publishing app/);
    assert.equal((await h.ownedCalendar.reviewOwnedCalendar(h.db, actor, c.connection.id)).setup!.attempted, false);
    const raw = await h.db.prepare('SELECT request_json FROM provider_owned_calendars WHERE connection_id = ?').bind(c.connection.id).first<{ request_json: string }>();
    assert.equal(JSON.parse(raw!.request_json).client_id, environment.GOOGLE_CALENDAR_PUBLISH_CLIENT_ID);
  } finally { await h.close(); }
});

test('migration 43 preserves genuine prior grants and consent attempts while retaining schedule columns and extending the purpose guard', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON'); const directory = new URL('../drizzle/', import.meta.url);
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '0043_').sort()) db.exec(readFileSync(new URL(name, directory), 'utf8'));
    db.exec("INSERT INTO workspaces (id, name) VALUES ('upgrade', 'Upgrade'); INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@test.invalid', 1, 1, 1); INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('upgrade', 'owner', 'owner');");
    const epoch = (db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'upgrade'").get() as { epoch: string }).epoch, id = crypto.randomUUID();
    db.prepare("INSERT INTO provider_connections (id, workspace_id, user_id, provider, purpose, account_id, email, display_name, granted_scopes, status, dataset_epoch, credentials, revision, created_at, updated_at) VALUES (?, 'upgrade', 'owner', 'google', 'calendar', 'same-subject', 'owner@test.invalid', 'Original', '[]', 'connected', ?, 'unchanged-ciphertext', 7, '2026-10-03', '2026-10-03')").run(id, epoch);
    db.prepare("INSERT INTO provider_authorization_attempts (state_hash, workspace_id, user_id, dataset_epoch, connection_id, connection_revision, verifier, expires_at, purpose) VALUES ('state-hash', 'upgrade', 'owner', ?, ?, 7, 'unchanged-verifier', 9999999999999, 'calendar')").run(epoch, id);
    const before = db.prepare('SELECT * FROM provider_connections').get(), attempt = db.prepare('SELECT * FROM provider_authorization_attempts').get();
    db.exec(readFileSync(new URL('0043_owned_calendar_setup.sql', directory), 'utf8'));
    assert.deepEqual(db.prepare('SELECT * FROM provider_connections').get(), before); assert.deepEqual(db.prepare('SELECT * FROM provider_authorization_attempts').get(), attempt);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM provider_owned_calendars').get() as { n: number }).n, 0);
    assert.throws(() => db.prepare("UPDATE provider_connections SET purpose = 'calendar-publish' WHERE id = ?").run(id), /INVALID/);
    assert.ok(db.prepare("PRAGMA table_info(provider_event_resources)").all().some((row) => (row as { name: string }).name === 'sync_enabled'));
  } finally { db.close(); }
});
