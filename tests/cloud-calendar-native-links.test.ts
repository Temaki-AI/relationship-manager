import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { selectedCalendar, calendarEvent, calendarEnvironment as environment, calendarId } from './helpers/google-calendar-fixture.ts';
import { googleActor as actor } from './helpers/google-contact-fixture.ts';
import { DEVICE_TOKEN_PREFIX, parseDeviceCallback } from '../packages/domain/src/devices.ts';
import { calendarLinksFingerprintInput, readCalendarLinkMutation, readCalendarLinkAcknowledgement, type CalendarLinkMutation } from '../packages/domain/src/calendar-event-links.ts';
import { readSyncV4Record } from '../packages/domain/src/sync-v4-client.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';
const endpoint = 'v1/calendar-event-links/push';
const hash = (record: unknown) => createHash('sha256').update(JSON.stringify(calendarLinksFingerprintInput(record))).digest('hex');
async function fixture() {
  const h = await createCloudHarness(), c = await selectedCalendar(h);
  const verifier = randomBytes(32).toString('hex'), state = randomBytes(32).toString('hex');
  const approval = await h.authorizeDevice({ challenge: createHash('sha256').update(verifier).digest('base64url'), state, deviceName: 'Meeting links iPhone' });
  const code = parseDeviceCallback((await approval.json()).callback, state), token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const exchange = await h.exchangeDevice({ code, state, verifier, token });
  assert.equal(exchange.status, 200);
  const identity = (await exchange.json()).identity, headers = { Authorization: `Bearer ${token}` };
  async function download(items: unknown[] = [calendarEvent()]) {
    const run = await h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, { ...c.body, operation_id: crypto.randomUUID() });
    await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, run.id, async () => Response.json({ items }));
  }
  await download();
  const preview = await h.eventLinks.eventLinkPreview(h.db, actor, c.connection.id, new URLSearchParams({ calendar_id: calendarId, event_id: 'meeting1' }));
  const saved = (await h.eventLinks.linkCalendarEvent(h.db, actor, c.connection.id, {
    operation_id: crypto.randomUUID(), expected_epoch: preview.epoch, expected_authorization_revision: preview.authorization_revision,
    expected_selection_revision: preview.selection_revision, expected_generation: preview.generation, calendar_id: calendarId, event_id: 'meeting1',
    expected_event_revision: null, contact_ids: [], plan_ids: [],
  })).event!;
  async function record() {
    const bootstrap = await h.call('v4/sync/bootstrap');
    assert.equal(bootstrap.status, 200);
    return readSyncV4Record(bootstrap.body.records.find((r: { entity: string; id: string }) => r.entity === 'source_event' && r.id === saved.public_id));
  }
  async function body(contactIds: string[] = [], planIds: string[] = []): Promise<CalendarLinkMutation> {
    const current = await record();
    return { version: 1, operationId: crypto.randomUUID(), epoch: preview.epoch, eventId: current.id, baseFingerprint: hash(current), contactIds, planIds };
  }
  const push = (value: unknown) => h.call(endpoint, { method: 'POST', body: value, headers });
  async function person(name = 'Ana', workspace = 'test') {
    const contact = (await h.call('contacts', { workspace, method: 'POST', body: { name, email: 'ana@example.test', notes: 'My private notes' } })).body.contact;
    const row = await h.db.prepare('SELECT public_id FROM contacts WHERE workspace_id = ? AND id = ?').bind(workspace, contact.id).first<{ public_id: string }>();
    return { ...contact, publicId: row!.public_id };
  }
  async function plan(personId: number) {
    const plan = (await h.call('plans', { method: 'POST', body: { contact_id: personId, type: 'meetup', summary: 'My plan', notes: 'My own plan notes', planned_date: '2026-11-03' } })).body.plan;
    const row = await h.db.prepare('SELECT public_id FROM plans WHERE id = ? AND workspace_id = ?').bind(plan.id, 'test').first<{ public_id: string }>();
    return { ...plan, publicId: row!.public_id };
  }
  return { h, c, identity, headers, saved, record, body, push, person, plan, download };
}

test('Native meeting links use public identities, support disconnected source-first context and preserve provider facts and CRM history', async () => {
  const f = await fixture(); try {
    const person = await f.person(), plan = await f.plan(person.id), body = await f.body([person.publicId], [plan.publicId]);
    const facts = (await f.record()).data!.facts, before = await f.h.db.prepare('SELECT * FROM plans WHERE id = ?').bind(plan.id).first();
    await f.h.providers.disconnectGoogleConnection(f.h.db, actor, environment, f.c.connection.id, f.c.connection.revision, async () => new Response(null, { status: 200 }));
    const result = await f.push(body); assert.equal(result.status, 200, JSON.stringify(result.body));
    const ack = readCalendarLinkAcknowledgement(result.body, body);
    assert.deepEqual(JSON.parse(String(ack.event!.data!.contact_ids)), [person.publicId]);
    assert.deepEqual(JSON.parse(String(ack.event!.data!.plan_ids)), [plan.publicId]);
    assert.equal(ack.event!.data!.facts, facts); assert.equal(ack.event!.data!.source_status, 'review_required');
    assert.deepEqual(await f.h.db.prepare('SELECT * FROM plans WHERE id = ?').bind(plan.id).first(), before);
    assert.equal((await f.h.call('contacts/' + person.id)).body.contact.notes, 'My private notes');
    assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM interactions').first<{ n: number }>())!.n, 0);
    assert.doesNotMatch(JSON.stringify(ack), /My private notes|My own plan notes|calendar-refresh|calendar-access/);
  } finally { await f.h.close(); }
});

test('Semantic link fingerprints ignore observation metadata and participant ordering but reject changed dates, privacy and graph choices', async () => {
  const f = await fixture(); try {
    const original = await f.record(), changed = structuredClone(original), facts = JSON.parse(String(changed.data!.facts));
    changed.revision += 100; changed.data!.observed_at = '2026-10-05T00:00:00Z'; changed.data!.source_status = 'review_required';
    changed.data!.calendar_label = 'Renamed calendar'; changed.data!.account_email = 'new@example.test';
    facts.updated = '2026-10-05T00:00:00Z'; facts.etag = 'new-etag'; facts.attendees.reverse(); changed.data!.facts = JSON.stringify(facts);
    assert.equal(hash(original), hash(changed));
    const reordered = structuredClone(changed), participants = JSON.parse(String(reordered.data!.facts));
    participants.attendees.push({ ...participants.attendees[0], email: 'second@example.test' }); reordered.data!.facts = JSON.stringify(participants);
    const opposite = structuredClone(reordered); participants.attendees.reverse(); opposite.data!.facts = JSON.stringify(participants);
    assert.equal(hash(reordered), hash(opposite));
    participants.end.date_time = '2026-10-04T14:00:00+01:00'; participants.end.instant = '2026-10-04T13:00:00.000Z';
    opposite.data!.facts = JSON.stringify(participants); assert.notEqual(hash(reordered), hash(opposite));
    facts.location = 'Changed location'; changed.data!.facts = JSON.stringify(facts); assert.notEqual(hash(original), hash(changed));
    const person = await f.person(), body = await f.body([person.publicId]);
    await f.h.db.prepare("UPDATE calendar_events SET observed_at = '2026-10-05T00:00:00Z', revision = revision + 1").run();
    assert.equal((await f.push(body)).status, 200);
    const privacyBody = await f.body([]);
    await f.download([{ ...calendarEvent(), visibility: 'private', summary: 'Do not retain this title' }]);
    const refused = await f.push(privacyBody); assert.equal(refused.status, 409); assert.equal(refused.body.code, 'event_changed');
    assert.doesNotMatch(JSON.stringify(refused.body), /Do not retain this title/);
    const latest = await f.record(); assert.equal(JSON.parse(String(latest.data!.facts)).title, 'Busy');
    assert.equal((await f.push(await f.body([]))).status, 200);
  } finally { await f.h.close(); }
});

test('Exact native retries confirm one graph mutation after concurrent requests, privacy updates and eventual source removal', async () => {
  const f = await fixture(); try {
    const person = await f.person(), body = await f.body([person.publicId]);
    const responses = await Promise.all([f.push(body), f.push(body)]);
    assert.deepEqual(responses.map((r) => r.status), [200, 200]);
    const savedRevision = (await f.h.db.prepare('SELECT revision FROM calendar_events WHERE public_id = ?').bind(body.eventId).first<{ revision: number }>())!.revision;
    assert.equal((await f.push(body)).status, 200);
    assert.equal((await f.h.db.prepare('SELECT revision FROM calendar_events WHERE public_id = ?').bind(body.eventId).first<{ revision: number }>())!.revision, savedRevision);
    const mismatch = await f.push({ ...body, contactIds: [] }); assert.equal(mismatch.status, 409); assert.equal(mismatch.body.code, 'receipt_mismatch');
    await f.download([{ ...calendarEvent(), visibility: 'confidential' }]);
    const replay = await f.push(body); assert.equal(replay.status, 200); assert.equal(JSON.parse(replay.body.event.data.facts).title, 'Busy');
    await f.h.db.prepare('DELETE FROM calendar_events WHERE public_id = ? AND workspace_id = ?').bind(body.eventId, 'test').run();
    const removed = await f.push(body); assert.equal(removed.status, 200); assert.equal(removed.body.event, null); readCalendarLinkAcknowledgement(removed.body, body);
    assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM calendar_events').first<{ n: number }>())!.n, 0);
  } finally { await f.h.close(); }
});

test('Competing native choices and missing or foreign public targets leave the graph untouched', async () => {
  const f = await fixture(); try {
    const one = await f.person('One'), two = await f.person('Two'), left = await f.body([one.publicId]), right = await f.body([two.publicId]);
    const raced = await Promise.all([f.push(left), f.push(right)]); assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409]);
    const before = JSON.stringify((await f.record()).data!.contact_ids);
    for (const ids of [[crypto.randomUUID()], [one.publicId, crypto.randomUUID()]]) {
      const result = await f.push(await f.body(ids)); assert.equal(result.status, 409); assert.equal(result.body.code, 'target_changed');
      assert.equal(JSON.stringify((await f.record()).data!.contact_ids), before);
    }
    const foreign = await f.person('Foreign', 'other'); assert.equal((await f.push(await f.body([foreign.publicId]))).status, 409);
    const event = await f.h.db.prepare('SELECT facts FROM calendar_events WHERE public_id = ?').bind(left.eventId).first<{ facts: string }>();
    assert.equal(JSON.parse(event!.facts).title, 'Lunch with Ana');
  } finally { await f.h.close(); }
});

test('Native meeting editing requires a current owner device, current epoch and bounded link-only input', async () => {
  const f = await fixture(); try {
    const body = await f.body();
    assert.equal((await f.h.call(endpoint, { method: 'POST', body })).status, 403);
    assert.equal((await f.push({ ...body, facts: {} })).status, 400);
    assert.equal((await f.push({ ...body, contactIds: Array.from({ length: 21 }, () => crypto.randomUUID()) })).status, 400);
    assert.equal((await f.push({ ...body, contactIds: [1] })).status, 400);
    assert.equal((await f.push({ ...body, contactIds: [body.eventId, body.eventId] })).status, 400);
    assert.equal((await f.h.call(endpoint, { method: 'POST', body, headers: { ...f.headers, Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await f.h.call(endpoint, { method: 'GET', headers: f.headers })).status, 404);
    await f.h.db.prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = 'test' AND user_id = 'owner'").run();
    assert.equal((await f.push(body)).status, 403);
    await f.h.db.prepare("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = 'test' AND user_id = 'owner'").run();
    await f.h.db.prepare("UPDATE workspace_sync_state SET paused = 1 WHERE workspace_id = 'test'").run();
    const paused = await f.push(body); assert.equal(paused.status, 423); assert.equal(paused.body.code, 'maintenance');
    await f.h.db.prepare("UPDATE workspace_sync_state SET paused = 0, epoch = ? WHERE workspace_id = 'test'").bind(crypto.randomUUID()).run();
    const restored = await f.push(body); assert.equal(restored.status, 409); assert.equal(restored.body.code, 'epoch_changed');
    await f.h.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), f.identity.deviceId).run();
    assert.equal((await f.push(body)).status, 401);
    assert.equal((await f.h.db.prepare("SELECT COUNT(*) n FROM mutation_receipts WHERE scope = 'native-calendar-links-v1'").first<{ n: number }>())!.n, 0);
  } finally { await f.h.close(); }
});

test('Native link acknowledgement and route contracts reject unrelated or malformed confirmation', async () => {
  const f = await fixture(); try {
    const body = await f.body(), result = await f.push(body); assert.equal(result.status, 200);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal(getCloudApiRewrite('/api/' + endpoint), '/api/cloud/' + endpoint);
    assert.equal(getCloudApiRewrite('/api/' + endpoint + '/extra'), null);
    assert.throws(() => readCalendarLinkAcknowledgement({ ...result.body, epoch: crypto.randomUUID() }, body));
    assert.throws(() => readCalendarLinkAcknowledgement({ ...result.body, event: { ...result.body.event, id: crypto.randomUUID() } }, body));
    assert.throws(() => readCalendarLinkAcknowledgement({ ...result.body, replayed: true }, body));
    assert.throws(() => readCalendarLinkMutation({ ...body, version: 2 }));
    assert.throws(() => readCalendarLinkMutation({ ...body, baseFingerprint: body.baseFingerprint.toUpperCase() }));
  } finally { await f.h.close(); }
});

test('Native choices never steal a linked plan or silently substitute a merged person identity', async () => {
  const f = await fixture(); try {
    const one = await f.person('Ana A'), two = await f.person('Ana B'), plan = await f.plan(one.id);
    await f.download([calendarEvent(), calendarEvent('another')]);
    const preview = await f.h.eventLinks.eventLinkPreview(f.h.db, actor, f.c.connection.id, new URLSearchParams({ calendar_id: calendarId, event_id: 'another' }));
    const other = (await f.h.eventLinks.linkCalendarEvent(f.h.db, actor, f.c.connection.id, {
      operation_id: crypto.randomUUID(), expected_epoch: preview.epoch, expected_authorization_revision: preview.authorization_revision,
      expected_selection_revision: preview.selection_revision, expected_generation: preview.generation, calendar_id: calendarId, event_id: 'another',
      expected_event_revision: null, contact_ids: [], plan_ids: [plan.id],
    })).event!;
    const linked = await f.push(await f.body([], [plan.publicId])); assert.equal(linked.status, 409); assert.equal(linked.body.code, 'plan_linked');
    assert.equal((await f.h.db.prepare('SELECT e.public_id FROM calendar_event_plans link JOIN calendar_events e ON e.id = link.event_id WHERE link.plan_id = ?').bind(plan.id).first<{ public_id: string }>())!.public_id, other.public_id);
    const stalePerson = await f.body([two.publicId]);
    const review = await f.h.call('contacts/duplicates');
    const merged = await f.h.call('contacts/duplicates', { method: 'POST', body: { primaryId: one.id, duplicateIds: [two.id], expectedRevision: review.body.revision } }); assert.equal(merged.status, 200);
    const rejected = await f.push(stalePerson); assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'target_changed');
    assert.deepEqual(JSON.parse(String((await f.record()).data!.contact_ids)), []);
    assert.equal((await f.push(await f.body([one.publicId]))).status, 200);
  } finally { await f.h.close(); }
});

test('A lost D1 commit response and a pre-commit device revocation retain exactly one authorized association effect', async () => {
  const f = await fixture(); try {
    const person = await f.person(), body = await f.body([person.publicId]), batch = f.h.db.batch.bind(f.h.db);
    let armed = true;
    const intercept = (callback: typeof f.h.db.batch) => new Proxy(f.h.db, { get(target, property) {
      if (property === 'batch') return callback;
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    // A local facade also intercepts Miniflare's remote binding; assigning its method does not.
    f.h.emailEnv.DB = intercept(async (statements) => {
      // Target lookup is the three-statement batch; the graph commit follows it.
      const result = await batch(statements);
      if (armed && statements.length > 5) { armed = false; throw new Error('Simulated lost commit acknowledgement'); }
      return result;
    });
    const result = await f.push(body); assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(armed, false, 'The commit-response fault must actually execute.');
    assert.equal((await f.h.db.prepare("SELECT COUNT(*) n FROM mutation_receipts WHERE scope = 'native-calendar-links-v1'").first<{ n: number }>())!.n, 1);
    const revision = (await f.record()).revision; assert.equal((await f.push(body)).status, 200); assert.equal((await f.record()).revision, revision);
    f.h.emailEnv.DB = f.h.db;
    const next = await f.body([]); armed = true;
    f.h.emailEnv.DB = intercept(async (statements) => {
      if (armed && statements.length > 5) {
        armed = false; await f.h.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), f.identity.deviceId).run();
      }
      return batch(statements);
    });
    assert.equal((await f.push(next)).status, 401);
    assert.equal(armed, false, 'The pre-commit revocation must actually execute.');
    assert.equal((await f.record()).revision, revision);
    assert.deepEqual(JSON.parse(String((await f.record()).data!.contact_ids)), [person.publicId]);
    assert.equal((await f.h.db.prepare("SELECT COUNT(*) n FROM mutation_receipts WHERE scope = 'native-calendar-links-v1'").first<{ n: number }>())!.n, 1);
  } finally { await f.h.close(); }
});
