import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import { selectedCalendar, calendarEvent, calendarEnvironment as environment, calendarId } from './helpers/google-calendar-fixture.ts';
import { googleActor as actor } from './helpers/google-contact-fixture.ts';
import { DEVICE_TOKEN_PREFIX, parseDeviceCallback, readNativeAccount } from '../packages/domain/src/devices.ts';

async function fixture() {
  const cloud = await createCloudHarness(), c = await selectedCalendar(cloud);
  const verifier = randomBytes(32).toString('hex'), state = randomBytes(32).toString('hex');
  const approval = await cloud.authorizeDevice({ challenge: createHash('sha256').update(verifier).digest('base64url'), state, deviceName: 'Calendar iPhone' });
  const code = parseDeviceCallback((await approval.json()).callback, state), token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const exchange = await cloud.exchangeDevice({ code, state, verifier, token });
  const account = readNativeAccount({ ...(await exchange.json()).identity, token, origin: 'https://everclosecrm.com' }), phone = await createMobileHarness(account);
  const requests: { path: string; body?: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${account.token}`); assert.equal(init?.credentials, 'omit');
    await cloud.deviceWorkspace(token);
    const url = new URL(String(input)), path = url.pathname.slice(5) + url.search, body = init?.body as string | undefined;
    requests.push({ path, body }); const r = await cloud.call(path, { method: init?.method ?? 'GET', ...(body ? { body: JSON.parse(body) } : {}) });
    return Response.json(r.body, { status: r.status });
  };
  async function download(items: unknown[] = [calendarEvent()]) {
    const run = await cloud.eventDownloads.startEventDownload(cloud.db, actor, environment, c.connection.id, { ...c.body, operation_id: crypto.randomUUID() });
    await cloud.eventDownloads.advanceEventDownload(cloud.db, actor, environment, c.connection.id, run.id, async () => Response.json({ items }));
  }
  await download();
  const person = async (name = 'Ana') => (await cloud.call('contacts', { method: 'POST', body: { name, email: 'ana@example.test', notes: 'My private notes' } })).body.contact;
  async function save(contact_ids: number[] = [], plan_ids: number[] = []) {
    const p = await cloud.eventLinks.eventLinkPreview(cloud.db, actor, c.connection.id, new URLSearchParams({ calendar_id: calendarId, event_id: 'meeting1' }));
    return (await cloud.eventLinks.linkCalendarEvent(cloud.db, actor, c.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: p.epoch, expected_authorization_revision: p.authorization_revision,
      expected_selection_revision: p.selection_revision, expected_generation: p.generation, calendar_id: calendarId, event_id: 'meeting1', expected_event_revision: p.saved?.revision ?? null, contact_ids, plan_ids })).event!;
  }
  return { cloud, c, account, phone, requests, fetcher, download, person, save,
    run: (transport: typeof fetch = fetcher) => phone.sync.syncWorkspace(phone.db, account, { fetcher: transport }),
    close: async () => { phone.close(); await cloud.close(); } };
}

test('phone sync retains source-first meetings, links later to people/plans and reads the same context after restart', async () => {
  const f = await fixture(); try {
    const saved = await f.save(); await f.run();
    assert.equal((await f.phone.calendarEvents.getCalendarEvent(f.phone.db, saved.public_id))!.people.length, 0);
    const p = await f.person(), plan = (await f.cloud.call('plans', { method: 'POST', body: { contact_id: p.id, type: 'meetup', planned_date: '2026-10-05', summary: 'My plan' } })).body.plan;
    await f.save([p.id], [plan.id]); await f.run();
    const context = (await f.phone.calendarEvents.listCalendarEvents(f.phone.db, p.public_id)).events;
    assert.equal(context.length, 1); assert.equal(context[0].id, saved.public_id); assert.equal(context[0].facts.title, 'Lunch with Ana');
    assert.deepEqual(context[0].people, [{ id: p.public_id, name: 'Ana' }]); assert.equal(context[0].plans[0].id, plan.public_id);
    const agenda = await f.phone.calendarEvents.listAgendaEntries(f.phone.db); assert.deepEqual(agenda.entries.map((e) => e.kind), ['source_event', 'plan']);
    assert.equal((await f.phone.contacts.getContact(f.phone.db, p.public_id))!.notes, 'My private notes');
    assert.equal((await f.phone.contacts.listContactInteractions(f.phone.db, p.public_id)).length, 0);
    const restarted = await createMobileHarness(f.account, f.phone.sqlite);
    assert.equal((await restarted.calendarEvents.getCalendarEvent(restarted.db, saved.public_id))!.facts.title, 'Lunch with Ana');
    assert.equal(f.requests[0].path, 'v4/sync/bootstrap'); assert.equal(f.phone.sqlite.pragma('user_version', { simple: true }), 17);
  } finally { await f.close(); }
});

test('interrupted or locally failed event bootstrap retains the visible cache, cursor and offline edits', async () => {
  const f = await fixture(); try {
    const p = await f.person(), saved = await f.save([p.id]); await f.run();
    const local = await f.phone.contacts.getContactForEditing(f.phone.db, p.public_id); await f.phone.contacts.updateContact(f.phone.db, local!, { ...local!, contactFrequency: local!.contact_frequency, notes: 'Offline note' });
    for (let i = 0; i < 11; i++) await f.person('Another ' + i);
    await f.download([{ ...calendarEvent(), summary: 'Updated meeting' }]);
    f.phone.sqlite.prepare("DELETE FROM app_metadata WHERE key = 'sync-cursor-v4'").run(); let page = 0;
    await assert.rejects(f.run(async (input, init) => { if (String(input).includes('/bootstrap') && ++page === 2) throw new Error('Interrupted'); return f.fetcher(input, init); }));
    assert.equal((await f.phone.calendarEvents.getCalendarEvent(f.phone.db, saved.public_id))!.facts.title, 'Lunch with Ana');
    assert.equal((await f.phone.contacts.getContact(f.phone.db, p.public_id))!.notes, 'Offline note');
    f.phone.faults.sqlContains = 'INSERT INTO calendar_events'; await assert.rejects(f.run()); f.phone.faults.sqlContains = undefined;
    assert.equal((await f.phone.calendarEvents.getCalendarEvent(f.phone.db, saved.public_id))!.facts.title, 'Lunch with Ana');
    assert.equal(f.phone.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'").get(), undefined);
    await f.run(); assert.equal((await f.phone.calendarEvents.getCalendarEvent(f.phone.db, saved.public_id))!.facts.title, 'Updated meeting');
    assert.equal((await f.cloud.call('contacts/' + p.id)).body.contact.notes, 'Offline note');
  } finally { await f.close(); }
});

test('phone event privacy, cancellation and disconnect preserve links and never fabricate interactions', async () => {
  const f = await fixture(); try {
    const p = await f.person(), saved = await f.save([p.id]); await f.run();
    await f.download([{ ...calendarEvent(), visibility: 'private', summary: 'Hidden details' }]); await f.run();
    const privateEvent = (await f.phone.calendarEvents.getCalendarEvent(f.phone.db, saved.public_id))!;
    assert.equal(privateEvent.facts.title, 'Busy'); assert.deepEqual(privateEvent.facts.attendees, []); assert.doesNotMatch(JSON.stringify(privateEvent), /Hidden details|ana@example/);
    await f.download([{ ...calendarEvent(), status: 'cancelled' }]); await f.run(); assert.equal((await f.phone.calendarEvents.getCalendarEvent(f.phone.db, saved.public_id))!.facts.status, 'cancelled');
    await f.cloud.providers.disconnectGoogleConnection(f.cloud.db, actor, environment, f.c.connection.id, f.c.connection.revision, async () => new Response(null, { status: 200 })); await f.run();
    assert.equal((await f.phone.calendarEvents.getCalendarEvent(f.phone.db, saved.public_id))!.sourceStatus, 'review_required');
    assert.equal((await f.phone.contacts.listContactInteractions(f.phone.db, p.public_id)).length, 0);
  } finally { await f.close(); }
});

test('current plan ownership and merged aliases route saved context to the surviving person', async () => {
  const f = await fixture(); try {
    const a = await f.person(), b = await f.person('Work Ana'), plan = (await f.cloud.call('plans', { method: 'POST', body: { contact_id: b.id, type: 'call', planned_date: '2026-10-05' } })).body.plan;
    const saved = await f.save([a.id, b.id], [plan.id]); await f.run();
    const review = await f.cloud.call('contacts/duplicates'); assert.equal((await f.cloud.call('contacts/duplicates', { method: 'POST', body: { primaryId: a.id, duplicateIds: [b.id], expectedRevision: review.body.revision } })).status, 200); await f.run();
    const context = (await f.phone.calendarEvents.listCalendarEvents(f.phone.db, b.public_id)).events[0]; assert.equal(context.id, saved.public_id);
    assert.deepEqual(context.people, [{ id: a.public_id, name: 'Ana' }]); assert.equal(context.plans[0].contactId, a.public_id);
    const other = await f.person('Other'); await f.save([], [plan.id]); await f.cloud.db.prepare("UPDATE plans SET contact_id = ? WHERE workspace_id = 'test' AND id = ?").bind(other.id, plan.id).run(); await f.run();
    assert.equal((await f.phone.calendarEvents.listCalendarEvents(f.phone.db, a.public_id)).events.length, 0);
    assert.equal((await f.phone.calendarEvents.listCalendarEvents(f.phone.db, other.public_id)).events[0].id, saved.public_id);
  } finally { await f.close(); }
});

test('event removal and restore reconcile the phone cache under fresh epochs; another account cannot access it', async () => {
  const f = await fixture(); try {
    const p = await f.person(), saved = await f.save([p.id]); await f.run();
    const backup = (await f.cloud.call('settings/backups', { method: 'POST' })).body.backup;
    await f.cloud.eventLinks.removeSavedCalendarEvent(f.cloud.db, actor, saved.public_id, { operation_id: crypto.randomUUID(), expected_epoch: f.c.epoch, expected_revision: saved.revision }); await f.run();
    assert.equal(await f.phone.calendarEvents.getCalendarEvent(f.phone.db, saved.public_id), null);
    assert.equal((await f.cloud.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200); await f.run();
    assert.equal((await f.phone.calendarEvents.getCalendarEvent(f.phone.db, saved.public_id))!.sourceStatus, 'review_required');
    await assert.rejects(f.phone.sync.syncWorkspace(f.phone.db, { ...f.account, userId: 'another' }, { fetcher: f.fetcher }), /another account/);
    const another = await createMobileHarness({ ...f.account, userId: 'another' }); try { assert.deepEqual((await another.calendarEvents.listCalendarEvents(another.db)).events, []); } finally { another.close(); }
  } finally { await f.close(); }
});

test('new phone transport replays an older frozen v3 write byte for byte instead of changing its protocol', async () => {
  const f = await fixture(); try {
    const p = await f.person(); await f.save(); await f.run();
    const local = await f.phone.contacts.getContactForEditing(f.phone.db, p.public_id); await f.phone.contacts.updateContact(f.phone.db, local!, { ...local!, contactFrequency: local!.contact_frequency, name: 'Ana changed' });
    const row = f.phone.sqlite.prepare('SELECT * FROM sync_queue').get() as { id: string; base_revision: number };
    const body = JSON.stringify({ version: 3, epoch: f.c.epoch, mutation: { operationId: row.id, entity: 'contact', entityId: p.public_id, type: 'update', baseRevision: row.base_revision, base: { name: 'Ana' }, patch: { name: 'Ana changed' } } });
    f.phone.sqlite.prepare('UPDATE sync_queue SET request_json = ?, epoch = ? WHERE id = ?').run(body, f.c.epoch, row.id);
    assert.equal((await f.cloud.call('v3/sync/push', { method: 'POST', body: JSON.parse(body) })).status, 200); await f.run();
    assert.equal(f.requests.find((r) => r.path === 'v3/sync/push')!.body, body);
    assert.equal((await f.phone.sync.syncSummary(f.phone.db)).pending, 0); assert.equal((await f.phone.contacts.getContact(f.phone.db, p.public_id))!.name, 'Ana changed');
  } finally { await f.close(); }
});
