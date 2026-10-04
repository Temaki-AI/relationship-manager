import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { googleActor as actor, googleEnvironment, stagedGoogleContact } from './helpers/google-contact-fixture.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';
const environment = { ...googleEnvironment, GOOGLE_CALENDAR_CLIENT_ID: 'calendar-client', GOOGLE_CALENDAR_CLIENT_SECRET: 'calendar-test-secret' };
const CALENDAR = 'openid email profile https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly';
type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
const item = (id = 'personal@example.test', summary = 'Personal calendar', role = 'owner') => ({ id, summary, timeZone: 'Europe/Lisbon', accessRole: role, primary: id === 'personal@example.test', hidden: false, description: 'Never store the calendar description' });
async function connect(h: Harness, options: { expires?: number; scopes?: string; account?: string } = {}) {
  await h.db.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@test.invalid', 1, 1, 1)").run();
  await h.db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner')").run();
  Object.assign(h.emailEnv, environment);
  const epoch = (await h.db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'test'").first<{ epoch: string }>())!.epoch;
  const start = await h.providers.beginGoogleConnection(h.db, actor, environment, { purpose: 'calendar', expected_epoch: epoch }, environment.BETTER_AUTH_URL), url = new URL(start.authorization_url);
  const connection = await h.providers.completeGoogleConnection(h.db, actor, environment, new URLSearchParams({ state: url.searchParams.get('state')!, code: 'calendar-code' }), async (address, request) => {
    if (address.endsWith('/userinfo')) return Response.json({ sub: options.account ?? 'google-owner', email: 'owner@example.test', email_verified: true, name: 'Calendar Owner' });
    assert.equal((request.body as URLSearchParams).get('client_id'), 'calendar-client');
    assert.equal((request.body as URLSearchParams).get('client_secret'), 'calendar-test-secret');
    return Response.json({ access_token: 'calendar-access', refresh_token: 'calendar-refresh', token_type: 'Bearer', expires_in: options.expires ?? 3600, scope: options.scopes ?? CALENDAR });
  });
  return { connection, epoch, url };
}
async function start(h: Harness, c: Awaited<ReturnType<typeof connect>>) {
  const body = { operation_id: crypto.randomUUID(), expected_epoch: c.epoch, expected_authorization_revision: c.connection.authorization_revision };
  const run = await h.googleCalendarResources.startCalendarDiscovery(h.db, actor, environment, c.connection.id, body); return { body, run };
}
async function complete(h: Harness, c: Awaited<ReturnType<typeof connect>>, items = [item()]) {
  const s = await start(h, c); await h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, s.run.id, async () => Response.json({ items }));
  return h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id);
}
function choices(review: Awaited<ReturnType<Harness['googleCalendarResources']['reviewCalendars']>>, ids = ['personal@example.test']) {
  return { operation_id: crypto.randomUUID(), expected_epoch: review.epoch, expected_authorization_revision: review.authorization_revision,
    expected_generation: review.generation, expected_selection_revision: review.selection_revision, selected_ids: ids };
}
async function count(h: Harness, table: string) { return (await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n; }
test('Calendar consent and refresh retain separate records for the same Google subject without replacing Contacts credentials', async () => {
  const h = await createCloudHarness(); try {
    const contacts = await stagedGoogleContact(h), calendar = await connect(h, { expires: 1 });
    assert.notEqual(calendar.connection.id, contacts.connection.id); assert.equal(calendar.connection.purpose, 'calendar'); assert.equal(contacts.connection.purpose, 'contacts');
    assert.equal(calendar.url.searchParams.get('scope'), CALENDAR); assert.equal(calendar.url.searchParams.get('client_id'), 'calendar-client');
    assert.equal(calendar.url.searchParams.get('redirect_uri'), 'https://test.invalid/api/connections/google/callback');
    const available = await h.providers.listProviderConnections(h.db, actor, environment); assert.deepEqual(available.configured_purposes, { contacts: true, calendar: true, 'calendar-publish': false });
    await assert.rejects(h.providers.googleConnectionAccess(h.db, actor, environment, calendar.connection.id, calendar.epoch), /requested Google resource/);
    await assert.rejects(h.providers.beginGoogleConnection(h.db, actor, environment, { purpose: 'calendar', expected_epoch: calendar.epoch, connection_id: contacts.connection.id, expected_revision: 1 }, environment.BETTER_AUTH_URL), /connection changed/);
    const grant = await h.providers.googleConnectionAccess(h.db, actor, environment, calendar.connection.id, calendar.epoch, async (_url, request) => {
      assert.equal((request.body as URLSearchParams).get('client_id'), 'calendar-client'); assert.equal((request.body as URLSearchParams).get('refresh_token'), 'calendar-refresh');
      return Response.json({ access_token: 'renewed-calendar', expires_in: 3600, token_type: 'Bearer' });
    }, 'calendar'); assert.equal(grant.purpose, 'calendar'); assert.equal(grant.accessToken, 'renewed-calendar');
    const pending = await h.providers.beginGoogleConnection(h.db, actor, environment, { purpose: 'contacts', expected_epoch: calendar.epoch }, environment.BETTER_AUTH_URL);
    await h.providers.disconnectGoogleConnection(h.db, actor, environment, calendar.connection.id, grant.revision, async () => new Response(null, { status: 200 }));
    assert.equal((await h.db.prepare('SELECT status FROM provider_connections WHERE id = ?').bind(contacts.connection.id).first())!.status, 'connected');
    assert.equal((await h.contactDownloads.reviewGoogleContacts(h.db, actor, contacts.connection.id)).items.length, 1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_authorization_attempts WHERE state_hash = ?').bind(await h.providerVault.providerDigest(new URL(pending.authorization_url).searchParams.get('state')!)).first())!.n, 1);
  } finally { await h.close(); }
});
test('Calendar cannot reuse sign-in or Contacts clients and rejects missing, excess or changed resource scopes', async () => {
  const h = await createCloudHarness(); try {
    const c = await connect(h);
    for (const id of ['contacts-client', 'login-client']) await assert.rejects(h.providers.beginGoogleConnection(h.db, actor, { ...environment, GOOGLE_CALENDAR_CLIENT_ID: id }, { purpose: 'calendar', expected_epoch: c.epoch }, environment.BETTER_AUTH_URL), /separate OAuth client/);
    for (const scopes of ['openid email profile https://www.googleapis.com/auth/contacts.readonly', CALENDAR + ' https://www.googleapis.com/auth/calendar.events', 'openid email profile https://www.googleapis.com/auth/calendar.events.readonly']) await assert.rejects(connect(h, { scopes }), /read-only Calendar/);
    await assert.rejects(h.contactDownloads.reviewGoogleContacts(h.db, actor, c.connection.id), /Reconnect/);
    await assert.rejects(h.db.prepare("UPDATE provider_connections SET purpose = 'contacts' WHERE id = ?").bind(c.connection.id).run(), /PROVIDER_CONNECTION_INVALID/);
    assert.equal((await h.providers.googleConnectionAccess(h.db, actor, environment, c.connection.id, c.epoch, undefined, 'calendar')).accessToken, 'calendar-access');
  } finally { await h.close(); }
});
test('Calendar discovery normalizes supported metadata and bounds provider responses without reading events or private descriptions', async () => {
  const h = await createCloudHarness(); try {
    const page = await h.googleCalendars.googleCalendarsPage('secret', null, async (address, request) => {
      const url = new URL(address); assert.equal(url.pathname, '/calendar/v3/users/me/calendarList'); assert.equal(url.searchParams.get('maxResults'), '50');
      assert.equal(url.searchParams.get('showHidden'), 'true'); assert.ok(!url.searchParams.get('fields')?.includes('description')); assert.equal(request.redirect, 'error'); assert.ok(request.signal);
      return Response.json({ items: [{ ...item(), summaryOverride: 'My label', hidden: true }, { id: 'removed', deleted: true }], nextPageToken: 'next-token' });
    }); assert.equal(page.calendars.length, 1); assert.equal(page.calendars[0].summary, 'My label'); assert.equal(page.calendars[0].hidden, true); assert.equal(page.next, 'next-token'); assert.ok(!JSON.stringify(page).includes('description'));
    for (const items of [[{ ...item(), timeZone: 'Not/A_Zone' }], [item(), item()], [{ ...item(), id: 'bad\nidentity' }], Array.from({ length: 51 }, (_, i) => item(String(i)))]) await assert.rejects(h.googleCalendars.googleCalendarsPage('secret', null, async () => Response.json({ items })), /unsupported calendar/);
    await assert.rejects(h.googleCalendars.googleCalendarsPage('secret', null, async () => new Response(' '.repeat(512 * 1024 + 1))), /unsupported calendar/);
    await assert.rejects(h.googleCalendars.googleCalendarsPage('secret', null, async () => Response.json({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, { status: 403, headers: { 'Retry-After': '5' } })), (error: Error & { reason: string; retryAfter: number }) => error.reason === 'retry' && error.retryAfter === 5);
    await assert.rejects(h.googleCalendars.googleCalendarsPage('secret', null, async () => Response.json({ error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, { status: 403 })), (error: Error & { reason: string }) => error.reason === 'permission');
  } finally { await h.close(); }
});
test('multi-page discovery stages a complete generation, serializes delivery and publishes without selecting calendars', async () => {
  const h = await createCloudHarness(); try {
    const c = await connect(h), previous = await complete(h, c), s = await start(h, c);
    assert.deepEqual(await h.googleCalendarResources.startCalendarDiscovery(h.db, actor, environment, c.connection.id, s.body), s.run);
    let release!: () => void, entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }), began = new Promise<void>((resolve) => { entered = resolve; });
    const first = h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, s.run.id, async () => { entered(); await gate; return Response.json({ items: [item('team@example.test', 'Team')], nextPageToken: 'second-page' }); }); await began;
    await assert.rejects(h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, s.run.id), /already running/);
    release(); assert.equal((await first).status, 'active');
    assert.equal((await h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id)).generation, previous.generation);
    const last = await h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, s.run.id, async (address) => { assert.equal(new URL(address).searchParams.get('pageToken'), 'second-page'); return Response.json({ items: [item('hidden@example.test', 'Hidden')] }); });
    assert.equal(last.status, 'complete'); const review = await h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id);
    assert.notEqual(review.generation, previous.generation); assert.deepEqual(review.selected_ids, []); assert.equal(review.calendars.length, 2); assert.equal(await count(h, 'contacts'), 0);
    await h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, s.run.id, async () => { throw new Error('Completed discovery cannot refetch'); });
    assert.equal(await count(h, 'provider_calendar_catalog'), 0);
  } finally { await h.close(); }
});
test('explicit calendar choices commit once, preserve missing selected calendars and reject stale or unsupported choices', async () => {
  const h = await createCloudHarness(); try {
    const c = await connect(h), review = await complete(h, c, [item(), item('busy@example.test', 'Busy only', 'freeBusyReader')]), body = choices(review);
    const replies = await Promise.all([h.googleCalendarResources.selectCalendars(h.db, actor, c.connection.id, body), h.googleCalendarResources.selectCalendars(h.db, actor, c.connection.id, body)]);
    assert.equal(replies.filter((reply) => reply.replayed).length, 1); assert.equal(await count(h, 'provider_calendar_selection_receipts'), 1);
    await assert.rejects(h.googleCalendarResources.selectCalendars(h.db, actor, c.connection.id, { ...body, selected_ids: [] }), /different calendar choices/);
    await assert.rejects(h.googleCalendarResources.selectCalendars(h.db, actor, c.connection.id, { ...body, operation_id: crypto.randomUUID() }), /choices changed/);
    const fresh = await h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id);
    await assert.rejects(h.googleCalendarResources.selectCalendars(h.db, actor, c.connection.id, choices(fresh, ['busy@example.test'])), /event read access/);
    await assert.rejects(h.googleCalendarResources.selectCalendars(h.db, actor, c.connection.id, choices(fresh, ['unowned'])), /available calendar/);
    const missing = await complete(h, c, [item('team@example.test', 'Team')]); assert.deepEqual(missing.selected_ids, ['personal@example.test']);
    assert.equal(missing.selected_calendars[0].availability, 'unavailable'); assert.equal(missing.selected_calendars[0].facts.summary, 'Personal calendar');
    assert.equal((await h.googleCalendarResources.selectCalendars(h.db, actor, c.connection.id, body)).replayed, true);
    await h.googleCalendarResources.selectCalendars(h.db, actor, c.connection.id, choices(missing, [])); assert.deepEqual((await h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id)).selected_ids, []);
  } finally { await h.close(); }
});
test('partial failures and capacity overflow retain the last complete list rather than publishing truncated calendars', async () => {
  const h = await createCloudHarness(); try {
    const c = await connect(h), previous = await complete(h, c), s = await start(h, c);
    const retry = await h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, s.run.id, async () => Response.json({ error: {} }, { status: 429, headers: { 'Retry-After': '5' } })); assert.ok(retry.retry_at > Date.now());
    await h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, s.run.id, async () => { throw new Error('Retry deadline not reached'); });
    await h.db.prepare('UPDATE provider_calendar_runs SET retry_at = 0 WHERE id = ?').bind(s.run.id).run();
    for (let page = 0; page < 10; page++) { const reply = await h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, s.run.id, async () => Response.json({ items: Array.from({ length: 50 }, (_, i) => item(`calendar-${page * 50 + i}`)), nextPageToken: 'page-' + page })); assert.equal(reply.status, 'active'); }
    const overflow = await h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, s.run.id, async () => Response.json({ items: [item('overflow')]})); assert.equal(overflow.status, 'failed');
    const kept = await h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id); assert.equal(kept.generation, previous.generation); assert.equal(kept.calendars[0].facts.summary, 'Personal calendar');
    await start(h, c); assert.equal(await count(h, 'provider_calendar_catalog'), 0);
  } finally { await h.close(); }
});
test('late Calendar responses cannot commit after disconnect, recovery or owner membership loss', async () => {
  for (const stop of ['disconnect', 'restore', 'membership']) {
    const h = await createCloudHarness(); try {
      const c = await connect(h), s = await start(h, c); await h.call('contacts', { method: 'POST', body: { name: 'Kept', notes: 'Private history' } });
      let release!: () => void, entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }), began = new Promise<void>((resolve) => { entered = resolve; });
      const pending = h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, s.run.id, async () => { entered(); await gate; return Response.json({ items: [item()] }); }); const settled = pending.then(() => null, (error) => error); await began;
      if (stop === 'disconnect') await h.providers.disconnectGoogleConnection(h.db, actor, environment, c.connection.id, 1, async () => new Response(null, { status: 200 }));
      else if (stop === 'restore') await h.db.prepare("UPDATE workspace_sync_state SET epoch = ? WHERE workspace_id = 'test'").bind(crypto.randomUUID()).run();
      else await h.db.prepare("DELETE FROM workspace_members WHERE workspace_id = 'test' AND user_id = 'owner'").run();
      release(); assert.match(String(await settled), /CLOUD_RECOVERY_CONFLICT/); assert.equal(await count(h, 'provider_calendars'), 0);
      assert.equal((await h.db.prepare('SELECT notes FROM contacts').first())!.notes, 'Private history');
    } finally { await h.close(); }
  }
});
test('Calendar operational selections are excluded from CRM recovery and cleared by restore and erasure', async () => {
  const h = await createCloudHarness(); try {
    const c = await connect(h), review = await complete(h, c); await h.googleCalendarResources.selectCalendars(h.db, actor, c.connection.id, choices(review));
    await h.call('contacts', { method: 'POST', body: { name: 'Private person' } });
    const backup = await h.call('settings/backups', { method: 'POST' }), filename = backup.body.backups[0].filename;
    const snapshot = await h.call('settings/backups/' + filename); assert.ok(!JSON.stringify(snapshot.body).includes('provider_calendar')); assert.ok(!JSON.stringify(snapshot.body).includes('calendar-refresh'));
    const restored = await h.call('settings/restore', { method: 'POST', body: { filename, confirmation: 'RESTORE' } }); assert.equal(restored.status, 200);
    for (const table of ['provider_calendars', 'provider_calendar_resources', 'provider_calendar_selection_receipts', 'provider_calendar_catalog']) assert.equal(await count(h, table), 0);
    assert.equal((await h.providers.listProviderConnections(h.db, actor, environment)).connections[0].status, 'dataset_review_required');
    const erased = await h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } }); assert.equal(erased.status, 200); assert.equal(await count(h, 'provider_calendar_runs'), 0);
  } finally { await h.close(); }
});
test('Calendar HTTP routes enforce owner, resource purpose, origin and reviewed selection before any external read', async () => {
  const h = await createCloudHarness(); try {
    const c = await connect(h); await complete(h, c);
    const path = ['connections', c.connection.id, 'calendars'];
    const handle = (suffix: string[], method: string, body?: unknown, origin = environment.BETTER_AUTH_URL, who: Parameters<typeof h.providerApi.handleProviderConnections>[1] = actor) => h.providerApi.handleProviderConnections(new Request('https://test.invalid/api/' + [...path, ...suffix].join('/'), { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), who, [...path, ...suffix]);
    assert.equal((await handle([], 'GET')).status, 200);
    assert.equal((await handle([], 'POST', {}, 'https://attacker.invalid')).status, 403);
    assert.equal((await handle([], 'GET', undefined, environment.BETTER_AUTH_URL, { ...actor, authMethod: 'device' })).status, 403);
    const review = await h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id); const save = await handle(['selection'], 'PATCH', choices(review)); assert.equal(save.status, 200);
    for (const suffix of ['', '/step', '/selection']) assert.equal(getCloudApiRewrite('/api/' + path.join('/') + suffix), '/api/cloud/' + path.join('/') + suffix);
    assert.equal(getCloudApiRewrite('/api/' + path.join('/') + '/unknown'), null);
    assert.ok(!JSON.stringify(await h.providers.listProviderConnections(h.db, actor, environment)).includes('calendar-access'));
  } finally { await h.close(); }
});
test('genuine pre-Calendar migrations preserve Contacts credentials, identities and pending consent while adding resource identity', () => {
  const db = new Database(':memory:'); try {
    db.pragma('foreign_keys = ON');
    const directory = new URL('../drizzle/', import.meta.url);
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '0038_').sort()) db.exec(readFileSync(new URL(name, directory), 'utf8'));
    db.exec("INSERT INTO workspaces (id, name) VALUES ('upgrade', 'Upgrade'); INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@test.invalid', 1, 1, 1); INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('upgrade', 'owner', 'owner');");
    const epoch = (db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'upgrade'").get() as { epoch: string }).epoch, id = crypto.randomUUID();
    db.prepare("INSERT INTO provider_connections (id, workspace_id, user_id, provider, account_id, email, display_name, granted_scopes, status, dataset_epoch, credentials, revision, created_at, updated_at) VALUES (?, 'upgrade', 'owner', 'google', 'same-subject', 'owner@test.invalid', 'Original', '[]', 'connected', ?, 'unchanged-ciphertext', 7, '2026-10-03', '2026-10-03')").run(id, epoch);
    db.prepare("INSERT INTO provider_authorization_attempts (state_hash, workspace_id, user_id, dataset_epoch, connection_id, connection_revision, verifier, expires_at) VALUES ('state-hash', 'upgrade', 'owner', ?, ?, 7, 'unchanged-verifier', 9999999999999)").run(epoch, id);
    db.exec(readFileSync(new URL('0038_google_calendar_resources.sql', directory), 'utf8'));
    const original = db.prepare('SELECT purpose, credentials, revision FROM provider_connections WHERE id = ?').get(id); assert.deepEqual(original, { purpose: 'contacts', credentials: 'unchanged-ciphertext', revision: 7 });
    assert.equal((db.prepare('SELECT purpose FROM provider_authorization_attempts').get() as { purpose: string }).purpose, 'contacts');
    db.prepare("INSERT INTO provider_connections (id, workspace_id, user_id, provider, purpose, account_id, email, display_name, granted_scopes, status, dataset_epoch, credentials, created_at, updated_at) VALUES (?, 'upgrade', 'owner', 'google', 'calendar', 'same-subject', 'owner@test.invalid', 'Calendar', '[]', 'connected', ?, 'calendar-ciphertext', '2026-10-04', '2026-10-04')").run(crypto.randomUUID(), epoch);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM provider_connections').get() as { n: number }).n, 2);
  } finally { db.close(); }
});
test('lost Calendar scope cancels only its discovery and choices while retaining the Contacts record', async () => {
  const h = await createCloudHarness(); try {
    const contacts = await stagedGoogleContact(h), c = await connect(h), review = await complete(h, c); await h.googleCalendarResources.selectCalendars(h.db, actor, c.connection.id, choices(review));
    const s = await start(h, c);
    await assert.rejects(h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, s.run.id, async () => Response.json({ error: { errors: [{ reason: 'insufficientPermissions' }] } }, { status: 403 })), /authorization is unavailable/);
    assert.equal((await h.db.prepare('SELECT status, issue FROM provider_connections WHERE id = ?').bind(c.connection.id).first())!.issue, 'calendar_permission_unavailable');
    assert.equal((await h.db.prepare('SELECT status FROM provider_calendar_runs WHERE id = ?').bind(s.run.id).first())!.status, 'cancelled');
    assert.equal(await count(h, 'provider_calendar_resources'), 0);
    assert.equal((await h.providers.googleConnectionAccess(h.db, actor, environment, contacts.connection.id, c.epoch)).purpose, 'contacts');
    assert.equal((await h.contactDownloads.reviewGoogleContacts(h.db, actor, contacts.connection.id)).items.length, 1);
  } finally { await h.close(); }
});
test('generation-bound calendar pages and search retain selected entries outside the current page', async () => {
  const h = await createCloudHarness(); try {
    const c = await connect(h), s = await start(h, c);
    await h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, s.run.id, async () => Response.json({ items: Array.from({ length: 50 }, (_, i) => item(`calendar-${String(i).padStart(3, '0')}`, `Calendar ${i}`)), nextPageToken: 'last' }));
    await h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, s.run.id, async () => Response.json({ items: Array.from({ length: 10 }, (_, i) => item(`calendar-${i + 50}`, `Calendar ${i + 50}`)) }));
    const first = await h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id); assert.equal(first.calendars.length, 50); assert.equal(first.more, true);
    const second = await h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id, new URLSearchParams({ after: first.next!, generation: first.generation! })); assert.equal(second.calendars.length, 10); assert.equal(second.more, false);
    const chosen = second.calendars[9].facts.id; await h.googleCalendarResources.selectCalendars(h.db, actor, c.connection.id, choices(second, [chosen]));
    const fresh = await h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id); assert.equal(fresh.calendars.some((calendar) => calendar.selected), false); assert.equal(fresh.selected_calendars[0].facts.id, chosen);
    const search = await h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id, new URLSearchParams({ search: 'Calendar 59' })); assert.equal(search.calendars[0].facts.id, chosen);
    await complete(h, c);
    await assert.rejects(h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id, new URLSearchParams({ after: first.next!, generation: first.generation! })), /list changed/);
  } finally { await h.close(); }
});
test('another grant invalidated by project-wide Google revocation requires reconnection without removing CRM people', async () => {
  const h = await createCloudHarness(); try {
    const contacts = await stagedGoogleContact(h), c = await connect(h);
    await h.call('contacts', { method: 'POST', body: { name: 'Preserved person', notes: 'Private relationship notes' } });
    const begin = await h.providers.beginGoogleConnection(h.db, actor, environment, { purpose: 'contacts', expected_epoch: c.epoch, connection_id: contacts.connection.id, expected_revision: 1 }, environment.BETTER_AUTH_URL);
    await h.providers.completeGoogleConnection(h.db, actor, environment, new URLSearchParams({ state: new URL(begin.authorization_url).searchParams.get('state')!, code: 'expiring-contacts' }), async (address) => address.endsWith('/userinfo')
      ? Response.json({ sub: 'google-owner', email: 'owner@example.test', name: 'Owner', email_verified: true })
      : Response.json({ access_token: 'short-contacts', refresh_token: 'contacts-refresh', expires_in: 1, token_type: 'Bearer', scope: 'openid email profile https://www.googleapis.com/auth/contacts.readonly' }));
    await h.providers.disconnectGoogleConnection(h.db, actor, environment, c.connection.id, 1, async () => new Response(null, { status: 200 }));
    await assert.rejects(h.providers.googleConnectionAccess(h.db, actor, environment, contacts.connection.id, c.epoch, async () => Response.json({ error: 'invalid_grant' }, { status: 400 })), /expired or was revoked/);
    assert.equal((await h.db.prepare('SELECT status FROM provider_connections WHERE id = ?').bind(contacts.connection.id).first())!.status, 'reconnect_required');
    assert.equal((await h.db.prepare('SELECT notes FROM contacts').first())!.notes, 'Private relationship notes');
  } finally { await h.close(); }
});
