import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import { selectedCalendar, calendarEvent, calendarEnvironment as environment, calendarId } from './helpers/google-calendar-fixture.ts';
import { googleActor as actor } from './helpers/google-contact-fixture.ts';
import { DEVICE_TOKEN_PREFIX, parseDeviceCallback, readNativeAccount } from '../packages/domain/src/devices.ts';
import type { CalendarLinkQueueRow } from '../apps/mobile/src/data/calendar-event-links.ts';
import type { AppleCalendarAdapter } from '../apps/mobile/src/data/apple-calendar.ts';
import type { AppleCalendarFacts } from '../packages/domain/src/apple-calendar.ts';

const pushPath = 'v1/calendar-event-links/push';
async function fixture() {
  const cloud = await createCloudHarness(), c = await selectedCalendar(cloud);
  const verifier = randomBytes(32).toString('hex'), state = randomBytes(32).toString('hex');
  const approved = await cloud.authorizeDevice({ challenge: createHash('sha256').update(verifier).digest('base64url'), state, deviceName: 'Offline links iPhone' });
  const code = parseDeviceCallback((await approved.json()).callback, state), token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const exchanged = await cloud.exchangeDevice({ code, state, verifier, token }); assert.equal(exchanged.status, 200);
  const account = readNativeAccount({ ...(await exchanged.json()).identity, token, origin: 'https://everclosecrm.com' });
  const folder = mkdtempSync(path.join(tmpdir(), 'everclose-native-links-')), filename = path.join(folder, 'phone.sqlite');
  let phone = await createMobileHarness(account, new Database(filename));
  const requests: { path: string; body?: string }[] = [];
  const transport: typeof fetch = async (input, init) => {
    assert.ok(new Headers(init?.headers).get('Authorization') === `Bearer ${token}`); await cloud.deviceWorkspace(token);
    const url = new URL(String(input)), route = url.pathname.slice(5) + url.search, body = init?.body as string | undefined;
    requests.push({ path: route, body });
    const response = await cloud.call(route, { method: init?.method ?? 'GET', headers: { Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.parse(body) } : {}) });
    return Response.json(response.body, { status: response.status });
  };
  async function download(items: unknown[] = [calendarEvent()]) {
    const run = await cloud.eventDownloads.startEventDownload(cloud.db, actor, environment, c.connection.id, { ...c.body, operation_id: crypto.randomUUID() });
    await cloud.eventDownloads.advanceEventDownload(cloud.db, actor, environment, c.connection.id, run.id, async () => Response.json({ items }));
  }
  async function saveEvent(eventId = 'meeting1') {
    const preview = await cloud.eventLinks.eventLinkPreview(cloud.db, actor, c.connection.id, new URLSearchParams({ calendar_id: calendarId, event_id: eventId }));
    return (await cloud.eventLinks.linkCalendarEvent(cloud.db, actor, c.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: preview.epoch,
      expected_authorization_revision: preview.authorization_revision, expected_selection_revision: preview.selection_revision, expected_generation: preview.generation,
      calendar_id: calendarId, event_id: eventId, expected_event_revision: preview.saved?.revision ?? null, contact_ids: [], plan_ids: [] })).event!;
  }
  const run = (fetcher = transport, isCurrent = () => true) => phone.sync.syncWorkspace(phone.db, account, { fetcher, isCurrent });
  await download(); const event = await saveEvent(); await run();
  async function person(name = 'Ana') {
    const p = (await cloud.call('contacts', { method: 'POST', body: { name, email: 'ana@example.test', notes: 'Private notes remain mine' } })).body.contact;
    return { ...p, publicId: (await cloud.db.prepare('SELECT public_id FROM contacts WHERE id = ? AND workspace_id = ?').bind(p.id, 'test').first<{ public_id: string }>())!.public_id };
  }
  const review = () => phone.calendarLinks.getCalendarLinkReview(phone.db, event.public_id);
  async function saveChoices(contactIds: string[], planIds: string[] = []) {
    const base = await review();
    return phone.calendarLinks.saveCalendarLinks(phone.db, account, { eventId: event.public_id, epoch: base.epoch!, fingerprint: base.currentFingerprint!, queueId: base.queue?.id ?? null }, contactIds, planIds);
  }
  return { cloud, c, account, event, requests, transport, run, review, saveChoices, person, download, saveEvent,
    get phone() { return phone; }, queue: () => phone.db.getFirstAsync<CalendarLinkQueueRow>('SELECT * FROM calendar_event_link_queue WHERE event_id = ?', event.public_id),
    restart: async () => { phone.close(); phone = await createMobileHarness(account, new Database(filename)); },
    close: async () => { phone.close(); await cloud.close(); rmSync(folder, { recursive: true, force: true }); } };
}

test('A verified Apple event date syncs through protocol 4, preserving private notes/history and retaining its local receipt across recovery', async () => {
  const f = await fixture(); try {
    const person = await f.phone.contacts.createContact(f.phone.db, { name: 'Apple friend', email: 'apple@example.test', phone: '', notes: 'PRIVATE PERSON', contactFrequency: 14 });
    const plan = await f.phone.context.createContext(f.phone.db, 'plan', person.id, { type: 'meetup', planned_date: '2026-10-05', summary: 'Coffee', notes: 'PRIVATE PLAN' });
    await f.run(); let facts: AppleCalendarFacts | null = null;
    const adapter: AppleCalendarAdapter = {
      async prepareEditor() {}, async permission() { return true; }, async calendars() { return []; }, async find() { return facts ? [facts] : []; },
      async get() { return facts; }, async edit() { return { action: 'canceled', id: null }; },
      async create(event) { facts = { id: 'apple-original', calendar_id: 'apple-personal', title: event.title, start: '2026-10-08T23:30:00Z', end: '2026-10-09T00:30:00Z', all_day: false, time_zone: 'Europe/Lisbon', url: event.url, recurring: false, cancelled: false }; return { action: 'saved', id: facts.id }; },
    };
    const draft = { title: 'Coffee', location: '', start: { date: '2026-10-05', date_time: null, time_zone: null }, end: { date: '2026-10-06', date_time: null, time_zone: null } };
    const review = await f.phone.appleCalendar.appleCalendarReview(f.phone.db, plan);
    const prepared = await f.phone.appleCalendar.prepareAppleCalendar(f.phone.db, f.account, plan, { operationId: crypto.randomUUID(), epoch: review.epoch, planFingerprint: review.planFingerprint, draft });
    const saved = await f.phone.appleCalendar.openAppleCalendarEditor(f.phone.db, f.account, prepared.id, prepared.revision, adapter, () => true, f.transport);
    const publication = await f.cloud.db.prepare('SELECT provider, status, attempted FROM calendar_publication_reservations WHERE id = ?').bind(saved.id).first();
    assert.deepEqual(publication, { provider: 'apple-calendar', status: 'saved', attempted: 1 });
    const sharedRequests = f.requests.filter((r) => r.path === 'v1/calendar-reservations');
    assert.deepEqual(sharedRequests.map((r) => JSON.parse(r.body!).action), ['reserve', 'attempt', 'result']);
    assert.ok(sharedRequests.every((r) => !/PRIVATE|apple-original|apple-personal|Coffee/.test(r.body!)));
    const verified = await f.phone.appleCalendar.verifyAppleCalendar(f.phone.db, f.account, saved.id, { revision: saved.revision, epoch: review.epoch, planFingerprint: review.planFingerprint, follow: true, reads: true }, adapter);
    await f.restart(); await f.run();
    const cloudPlan = await f.cloud.db.prepare('SELECT planned_date, notes, completed_at FROM plans WHERE public_id = ?').bind(plan).first();
    assert.equal(cloudPlan!.planned_date, '2026-10-09'); assert.equal(cloudPlan!.notes, 'PRIVATE PLAN'); assert.equal(cloudPlan!.completed_at, null);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM interactions').first<{ n: number }>())!.n, 0);
    assert.equal((await f.phone.appleCalendar.appleCalendarReview(f.phone.db, plan)).receipt!.id, verified.id);
    assert.ok(f.requests.filter((r) => r.body).every((r) => !r.body!.includes('apple_calendar_receipts') && !r.body!.includes('bonds://calendar/apple')));
    const otherPlan = await f.phone.context.createContext(f.phone.db, 'plan', person.id, { type: 'meetup', planned_date: '2026-10-10', summary: 'Another meeting', notes: '' });
    await f.run(); const other = await f.phone.appleCalendar.appleCalendarReview(f.phone.db, otherPlan);
    const unopened = await f.phone.appleCalendar.prepareAppleCalendar(f.phone.db, f.account, otherPlan, { operationId: crypto.randomUUID(), epoch: other.epoch, planFingerprint: other.planFingerprint, draft });
    await f.saveChoices([person.id], [otherPlan]);
    await assert.rejects(f.phone.appleCalendar.openAppleCalendarEditor(f.phone.db, f.account, unopened.id, unopened.revision, adapter, () => true, f.transport), /changed/);
    assert.equal((await f.phone.appleCalendar.appleCalendarReview(f.phone.db, otherPlan)).receipt!.attempted, 0);
  } finally { await f.close(); }
});

test('Phone Calendar choices survive file restart and upload newly created people and plans first without losing private data', async () => {
  const f = await fixture(); try {
    const person = await f.phone.contacts.createContact(f.phone.db, { name: 'Offline friend', email: 'offline@example.test', phone: '', notes: 'My offline private notes', contactFrequency: 14 });
    const plan = await f.phone.context.createContext(f.phone.db, 'plan', person.id, { type: 'meetup', planned_date: '2026-10-05', summary: 'Offline plan', notes: 'My private plan' });
    const operation = await f.saveChoices([person.id], [plan]);
    assert.equal((await f.queue())!.request_json, null);
    const local = await f.phone.calendarEvents.getCalendarEvent(f.phone.db, f.event.public_id); assert.equal(local!.linksState, 'pending'); assert.equal(local!.people[0].name, 'Offline friend'); assert.equal(local!.plans[0].id, plan);
    assert.equal((await f.phone.calendarEvents.listCalendarEvents(f.phone.db, person.id)).events.length, 1);
    const agenda = await f.phone.calendarEvents.listAgendaEntries(f.phone.db); assert.equal(agenda.entries.filter((item) => item.kind === 'source_event').length, 1);
    await f.restart(); assert.equal((await f.queue())!.id, operation); assert.equal((await f.phone.sync.syncSummary(f.phone.db)).pending, 3);
    await f.run(); assert.equal(await f.queue(), null);
    const paths = f.requests.filter((r) => r.body).map((r) => r.path); assert.equal(paths.at(-1), pushPath); assert.ok(paths.indexOf('v4/sync/push') < paths.indexOf(pushPath));
    const context = (await f.cloud.eventLinks.savedCalendarEvents(f.cloud.db, actor, new URLSearchParams(), f.event.public_id)).event!;
    assert.equal(context.people[0].name, 'Offline friend'); assert.equal(context.plans[0].summary, 'Offline plan');
    assert.equal((await f.phone.contacts.getContact(f.phone.db, person.id))!.notes, 'My offline private notes');
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM interactions').first<{ n: number }>())!.n, 0);
    assert.equal((await f.phone.calendarEvents.getCalendarEvent(f.phone.db, f.event.public_id))!.linksState, null);
  } finally { await f.close(); }
});

test('Unknown native link results stay frozen through restart and retry the identical request instead of replacing or discarding it', async () => {
  const f = await fixture(); try {
    const person = await f.person(); await f.run(); await f.saveChoices([person.publicId]);
    const uncertain: typeof fetch = async (input, init) => { const response = await f.transport(input, init); if (new URL(String(input)).pathname.endsWith('/calendar-event-links/push')) throw new Error('Lost reply after commit'); return response; };
    await assert.rejects(f.run(uncertain)); const queued = (await f.queue())!; assert.ok(queued.request_json); assert.equal(queued.status, 'pending');
    await assert.rejects(f.saveChoices([]), /unconfirmed/);
    await assert.rejects(f.phone.calendarLinks.discardCalendarLinkReview(f.phone.db, f.account, queued.id), /Only a held/);
    const cloudRevision = (await f.cloud.eventLinks.savedCalendarEvents(f.cloud.db, actor, new URLSearchParams(), f.event.public_id)).event!.revision;
    await f.restart(); assert.equal((await f.queue())!.request_json, queued.request_json); await f.run(); assert.equal(await f.queue(), null);
    const attempts = f.requests.filter((r) => r.path === pushPath); assert.equal(attempts.length, 2); assert.equal(attempts[0].body, attempts[1].body);
    assert.equal((await f.cloud.eventLinks.savedCalendarEvents(f.cloud.db, actor, new URLSearchParams(), f.event.public_id)).event!.revision, cloudRevision);
    assert.equal((await f.cloud.db.prepare("SELECT COUNT(*) n FROM mutation_receipts WHERE scope = 'native-calendar-links-v1'").first<{ n: number }>())!.n, 1);
  } finally { await f.close(); }
});

test('A failed local acknowledgement keeps the intent and an older confirmed replay cannot restore newly redacted source facts', async () => {
  const f = await fixture(); try {
    const person = await f.person(); await f.run(); await f.saveChoices([person.publicId]);
    let oldAck: unknown = null;
    const capture: typeof fetch = async (input, init) => { const response = await f.transport(input, init); if (new URL(String(input)).pathname.endsWith('/calendar-event-links/push')) oldAck = await response.clone().json(); return response; };
    f.phone.faults.sqlContains = 'DELETE FROM calendar_event_link_queue'; await assert.rejects(f.run(capture)); f.phone.faults.sqlContains = undefined;
    const queued = (await f.queue())!; assert.equal(queued.status, 'pending'); assert.ok(queued.request_json); assert.ok(oldAck);
    assert.doesNotMatch(JSON.stringify(queued), /Lunch with Ana|ana@example.test|calendar_label|observed_at|facts|notes/);
    await f.download([{ ...calendarEvent(), visibility: 'private', summary: 'Do not reintroduce this title' }]);
    const older: typeof fetch = async (input, init) => { const response = await f.transport(input, init); return new URL(String(input)).pathname.endsWith('/calendar-event-links/push') ? Response.json(oldAck) : response; };
    await f.run(older); assert.equal(await f.queue(), null);
    const context = (await f.phone.calendarEvents.getCalendarEvent(f.phone.db, f.event.public_id))!; assert.equal(context.facts.title, 'Busy'); assert.equal(context.facts.redacted, true); assert.equal(context.people[0].id, person.publicId);
    assert.doesNotMatch(JSON.stringify(context), /Lunch with Ana|Do not reintroduce this title/);
  } finally { await f.close(); }
});

test('Changed source semantics hold unsent choices for explicit review, while observation-only updates do not invent conflicts', async () => {
  const f = await fixture(); try {
    const person = await f.person(); await f.run(); const original = await f.review(); await f.saveChoices([person.publicId]);
    await f.download([{ ...calendarEvent(), summary: 'Changed actual meeting' }]); await f.run();
    const held = (await f.queue())!; assert.equal(held.status, 'conflict'); assert.equal(held.last_error_code, 'event_changed'); assert.equal(held.request_json, null);
    assert.deepEqual(JSON.parse(held.contact_ids), [person.publicId]); assert.equal((await f.phone.sync.syncSummary(f.phone.db)).conflicts, 1);
    await assert.rejects(f.phone.calendarLinks.saveCalendarLinks(f.phone.db, f.account, { eventId: f.event.public_id, epoch: original.epoch!, fingerprint: original.currentFingerprint!, queueId: held.id }, [person.publicId], []), /Review the current/);
    const operation = await f.saveChoices([person.publicId]); assert.notEqual(operation, held.id);
    await f.cloud.db.prepare("UPDATE calendar_events SET observed_at = '2026-10-06T00:00:00Z', revision = revision + 1 WHERE public_id = ?").bind(f.event.public_id).run();
    await f.run(); assert.equal(await f.queue(), null); assert.equal((await f.phone.calendarEvents.getCalendarEvent(f.phone.db, f.event.public_id))!.facts.title, 'Changed actual meeting');
    await f.phone.context.createContext(f.phone.db, 'plan', person.publicId, { type: 'meetup', planned_date: '2026-10-05', summary: 'A later plan' });
    await f.download([{ id: 'meeting1', status: 'cancelled', recurringEventId: 'series1', originalStartTime: calendarEvent().start }]); await f.run();
    const agenda = await f.phone.calendarEvents.listAgendaEntries(f.phone.db); assert.equal(agenda.entries[0].kind, 'source_event');
    if (agenda.entries[0].kind === 'source_event') { assert.equal(agenda.entries[0].event.facts.start, null); assert.ok(agenda.entries[0].event.facts.original_start); }
  } finally { await f.close(); }
});

test('Removed saved meetings confirm committed frozen choices without recreation and expose uncommitted choices for safe discard', async () => {
  const f = await fixture(); try {
    const person = await f.person(); await f.run(); await f.saveChoices([person.publicId]);
    const uncertain: typeof fetch = async (input, init) => { const response = await f.transport(input, init); if (new URL(String(input)).pathname.endsWith('/calendar-event-links/push')) throw new Error('Lost reply'); return response; };
    await assert.rejects(f.run(uncertain)); const current = (await f.cloud.eventLinks.savedCalendarEvents(f.cloud.db, actor, new URLSearchParams(), f.event.public_id)).event!;
    await f.cloud.eventLinks.removeSavedCalendarEvent(f.cloud.db, actor, f.event.public_id, { operation_id: crypto.randomUUID(), expected_epoch: f.c.epoch, expected_revision: current.revision });
    await f.run(); assert.equal(await f.queue(), null); assert.equal(await f.phone.calendarEvents.getCalendarEvent(f.phone.db, f.event.public_id), null);
    const second = await f.saveEvent(); await f.run();
    const review = await f.phone.calendarLinks.getCalendarLinkReview(f.phone.db, second.public_id);
    const intent = await f.phone.calendarLinks.saveCalendarLinks(f.phone.db, f.account, { eventId: second.public_id, epoch: review.epoch!, fingerprint: review.currentFingerprint!, queueId: null }, [person.publicId], []);
    await f.cloud.eventLinks.removeSavedCalendarEvent(f.cloud.db, actor, second.public_id, { operation_id: crypto.randomUUID(), expected_epoch: f.c.epoch, expected_revision: second.revision }); await f.run();
    const conflicts = await f.phone.calendarLinks.calendarLinkSyncReviews(f.phone.db); assert.equal(conflicts.length, 1); assert.equal(conflicts[0].id, intent); assert.equal(conflicts[0].last_error_code, 'event_missing');
    const missing = await f.phone.calendarLinks.getCalendarLinkReview(f.phone.db, second.public_id); assert.equal(missing.event, null); assert.deepEqual(missing.contactIds, [person.publicId]);
    await f.phone.calendarLinks.discardCalendarLinkReview(f.phone.db, f.account, intent); assert.equal((await f.phone.sync.syncSummary(f.phone.db)).conflicts, 0);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM calendar_events').first<{ n: number }>())!.n, 0);
  } finally { await f.close(); }
});

test('Restore holds old Calendar intents under their original epoch and fresh reviewed choices use a new operation identity', async () => {
  const f = await fixture(); try {
    const person = await f.person(); await f.run(); const backup = (await f.cloud.call('settings/backups', { method: 'POST' })).body.backup;
    await f.saveChoices([person.publicId]);
    const noCommit: typeof fetch = async (input, init) => { if (new URL(String(input)).pathname.endsWith('/calendar-event-links/push')) throw new Error('Offline before commit'); return f.transport(input, init); };
    await assert.rejects(f.run(noCommit)); const old = (await f.queue())!;
    assert.equal((await f.cloud.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200); await f.run();
    const held = (await f.queue())!; assert.equal(held.status, 'conflict'); assert.equal(held.last_error_code, 'epoch_changed'); assert.equal(held.request_json, old.request_json); assert.equal(held.epoch, old.epoch);
    const restored = await f.review(); assert.notEqual(restored.epoch, old.epoch); assert.deepEqual(restored.contactIds, [person.publicId]);
    const operation = await f.saveChoices([person.publicId]); assert.notEqual(operation, old.id); await f.run(); assert.equal(await f.queue(), null);
    assert.equal((await f.phone.calendarEvents.getCalendarEvent(f.phone.db, f.event.public_id))!.people[0].id, person.publicId);
    assert.equal((await f.phone.contacts.getContact(f.phone.db, person.publicId))!.notes, 'Private notes remain mine');
  } finally { await f.close(); }
});

test('Native pickers reach later pages, retain missing selections and reject plan stealing, oversized choices and failed draft replacement atomically', async () => {
  const f = await fixture(); try {
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) ids.push((await f.person(`Person ${String(i).padStart(2, '0')}`)).publicId);
    await f.run(); const missing = crypto.randomUUID();
    const first = await f.phone.calendarLinks.calendarLinkChoices(f.phone.db, f.event.public_id, 'person', '', 0, [ids[54], missing]);
    assert.equal(first.choices.length, 50); assert.equal(first.more, true); assert.equal(first.selected[0].label, 'Person 54'); assert.equal(first.selected[1].unavailable, true);
    const next = await f.phone.calendarLinks.calendarLinkChoices(f.phone.db, f.event.public_id, 'person', '', 50); assert.equal(next.choices.length, 5); assert.equal(next.more, false);
    assert.equal((await f.phone.calendarLinks.calendarLinkChoices(f.phone.db, f.event.public_id, 'person', '%')).choices.length, 0);
    const old = await f.saveChoices(ids.slice(0, 20)); await assert.rejects(f.saveChoices(ids.slice(0, 21)), /at most 20/); await assert.rejects(f.saveChoices([missing]), /unavailable/);
    f.phone.faults.sqlContains = 'INSERT INTO calendar_event_link_queue'; await assert.rejects(f.saveChoices([ids[54]])); f.phone.faults.sqlContains = undefined;
    assert.equal((await f.queue())!.id, old); assert.equal(JSON.parse((await f.queue())!.contact_ids).length, 20);
    const plan = await f.phone.context.createContext(f.phone.db, 'plan', ids[0], { type: 'meetup', planned_date: '2026-10-07', summary: 'One linked plan' }); await f.run();
    await f.download([calendarEvent(), calendarEvent('another')]); const other = await f.saveEvent('another'); await f.run();
    await f.saveChoices([], [plan]); const base = await f.phone.calendarLinks.getCalendarLinkReview(f.phone.db, other.public_id);
    await assert.rejects(f.phone.calendarLinks.saveCalendarLinks(f.phone.db, f.account, { eventId: other.public_id, epoch: base.epoch!, fingerprint: base.currentFingerprint!, queueId: null }, [], [plan]), /another meeting/);
    const plans = await f.phone.calendarLinks.calendarLinkChoices(f.phone.db, other.public_id, 'plan', '', 0, [plan]); assert.ok(plans.selected[0].linkedElsewhere);
  } finally { await f.close(); }
});

test('A late link acknowledgement cannot modify another account and schema-12 upgrade preserves populated cache and pending core intents', async () => {
  const f = await fixture(); try {
    const person = await f.person(); await f.run(); const before = await f.review();
    const core = await f.phone.contacts.createContact(f.phone.db, { name: 'Still pending', email: '', phone: '', notes: '', contactFrequency: 14 });
    const cursor = f.phone.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'").get();
    f.phone.sqlite.exec('DROP TABLE apple_calendar_publication_reviews; DROP TABLE apple_calendar_reservations; DROP TABLE today_snooze_queue; DROP TABLE today_snoozes; DROP TRIGGER gmail_context_contact_insert; DROP TRIGGER gmail_context_contact_identity; DROP TRIGGER gmail_context_contact_delete; DROP TRIGGER gmail_context_alias_insert; DROP TRIGGER gmail_context_alias_delete; DROP TRIGGER gmail_context_alias_update; DROP TABLE gmail_person_context; DROP TABLE gmail_context_state; DROP TRIGGER apple_calendar_plan_removed; DROP TRIGGER apple_calendar_plan_deleted; DROP TRIGGER apple_calendar_plan_date_changed; DROP TABLE apple_calendar_receipts; DROP TABLE calendar_event_link_queue; PRAGMA user_version = 12;'); await f.restart();
    assert.equal(f.phone.sqlite.pragma('user_version', { simple: true }), 18); assert.deepEqual(f.phone.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'").get(), cursor);
    assert.equal((await f.review()).currentFingerprint, before.currentFingerprint); assert.equal((await f.phone.contacts.getContact(f.phone.db, core.id))!.sync_state, 'pending');
    await f.run(); await f.saveChoices([person.publicId]); let current = true;
    const late: typeof fetch = async (input, init) => { const response = await f.transport(input, init); if (new URL(String(input)).pathname.endsWith('/calendar-event-links/push')) current = false; return response; };
    await assert.rejects(f.run(late, () => current)); assert.ok((await f.queue())!.request_json); assert.equal((await f.queue())!.status, 'pending');
    const another = await createMobileHarness({ ...f.account, userId: 'another' }); try {
      assert.equal((await another.sync.syncSummary(another.db)).pending, 0); assert.equal((await another.calendarEvents.listCalendarEvents(another.db)).events.length, 0);
      await assert.rejects(f.phone.calendarLinks.saveCalendarLinks(f.phone.db, { ...f.account, userId: 'another' }, { eventId: f.event.public_id, epoch: before.epoch!, fingerprint: before.currentFingerprint!, queueId: (await f.queue())!.id }, [], []), /another account/);
    } finally { another.close(); }
    await f.run(); assert.equal(await f.queue(), null);
    assert.equal((await f.cloud.db.prepare("SELECT COUNT(*) n FROM mutation_receipts WHERE scope = 'native-calendar-links-v1'").first<{ n: number }>())!.n, 1);
  } finally { await f.close(); }
});

test('A merged selected identity requires explicit replacement while a frozen committed request confirms its surviving association', async () => {
  const f = await fixture(); try {
    const primary = await f.person('Ana primary'), duplicate = await f.person('Ana duplicate'); await f.run(); await f.saveChoices([duplicate.publicId]);
    const merge = async (keep: number, remove: number) => {
      const review = await f.cloud.call('contacts/duplicates');
      const result = await f.cloud.call('contacts/duplicates', { method: 'POST', body: { primaryId: keep, duplicateIds: [remove], expectedRevision: review.body.revision } }); assert.equal(result.status, 200);
    };
    await merge(primary.id, duplicate.id); await f.run();
    const held = (await f.queue())!; assert.equal(held.status, 'conflict'); assert.equal(held.last_error_code, 'target_changed'); assert.deepEqual(JSON.parse(held.contact_ids), [duplicate.publicId]);
    const choices = await f.phone.calendarLinks.calendarLinkChoices(f.phone.db, f.event.public_id, 'person', '', 0, [duplicate.publicId]); assert.equal(choices.selected[0].unavailable, true);
    await f.saveChoices([primary.publicId]); await f.run(); assert.equal(await f.queue(), null);
    const later = await f.person('Ana later'); await f.run(); await f.saveChoices([later.publicId]);
    const uncertain: typeof fetch = async (input, init) => { const response = await f.transport(input, init); if (new URL(String(input)).pathname.endsWith('/calendar-event-links/push')) throw new Error('Lost committed reply'); return response; };
    await assert.rejects(f.run(uncertain)); const body = (await f.queue())!.request_json;
    await merge(primary.id, later.id); await f.run(); assert.equal(await f.queue(), null);
    assert.equal(f.requests.filter((r) => r.path === pushPath).at(-1)!.body, body);
    assert.deepEqual((await f.phone.calendarEvents.getCalendarEvent(f.phone.db, f.event.public_id))!.people.map((p) => p.id), [primary.publicId]);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM calendar_events').first<{ n: number }>())!.n, 1);
  } finally { await f.close(); }
});
