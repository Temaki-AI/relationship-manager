import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { googleActor as actor } from './helpers/google-contact-fixture.ts';
import { selectedCalendar, calendarEnvironment as environment, calendarId, calendarEvent } from './helpers/google-calendar-fixture.ts';
import { calendarEventDates, calendarEventPeople, type SourceCalendarEvent } from '../lib/calendar-directory.ts';

async function fixture(items: unknown[] = [calendarEvent()]) {
  const h = await createCloudHarness(), c = await selectedCalendar(h);
  const run = await h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, { ...c.body, operation_id: crypto.randomUUID() });
  await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, run.id, async () => Response.json({ items }));
  async function save(id = 'meeting1', people: number[] = [], plans: number[] = []) {
    const preview = await h.eventLinks.eventLinkPreview(h.db, actor, c.connection.id, new URLSearchParams({ calendar_id: calendarId, event_id: id }));
    return (await h.eventLinks.linkCalendarEvent(h.db, actor, c.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: preview.epoch,
      expected_authorization_revision: preview.authorization_revision, expected_selection_revision: preview.selection_revision, expected_generation: preview.generation,
      calendar_id: calendarId, event_id: id, expected_event_revision: preview.saved?.revision ?? null, contact_ids: people, plan_ids: plans })).event!;
  }
  const directory = async (start = '2026-10-01', end = '2026-10-31', zone = 'UTC', workspace = 'test') => {
    const result = await h.call('calendar?' + new URLSearchParams({ start, end, timeZone: zone }), { workspace });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  };
  return { h, c, save, directory };
}

test('Web calendar combines one source-first meeting with core actions and all reviewed person/plan context', async () => {
  const f = await fixture(); try {
    const orphan = await f.save();
    let result = await f.directory(); const first = result.events.find((event: SourceCalendarEvent) => event.kind === 'source_event') as SourceCalendarEvent;
    assert.equal(first.source.public_id, orphan.public_id); assert.deepEqual(first.source.people, []);
    assert.equal(first.completed, false); assert.equal(first.source_id, null); assert.equal(first.contact_id, null);
    assert.deepEqual(calendarEventPeople(first), []);
    assert.doesNotMatch(JSON.stringify(first), /"attendees"|calendar-access|calendar-refresh|"etag"|"external_id"|"account_key"|do-not-save/);
    const ana = (await f.h.call('contacts', { method: 'POST', body: { name: 'Ana', notes: 'Private Ana notes' } })).body.contact;
    const sam = (await f.h.call('contacts', { method: 'POST', body: { name: 'Sam' } })).body.contact;
    const plan = (await f.h.call('plans', { method: 'POST', body: { contact_id: sam.id, type: 'call', summary: 'Call Sam', notes: 'Private plan notes', planned_date: '2026-10-10' } })).body.plan;
    await f.save('meeting1', [ana.id], [plan.id]);
    result = await f.directory(); const event = result.events.find((value: SourceCalendarEvent) => value.kind === 'source_event') as SourceCalendarEvent;
    assert.deepEqual(calendarEventPeople(event), [{ id: ana.id, name: 'Ana' }, { id: sam.id, name: 'Sam' }]);
    assert.equal(result.events.filter((value: SourceCalendarEvent) => value.kind === 'source_event').length, 1);
    assert.ok(result.events.some((value: { kind: string }) => value.kind === 'plan'));
    assert.doesNotMatch(JSON.stringify(event), /Private Ana notes|Private plan notes/);
    assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM interactions').first<{ n: number }>())!.n, 0);
    assert.deepEqual((await f.directory(undefined, undefined, 'UTC', 'other')).events, []);
    await f.h.db.prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = 'test' AND user_id = 'owner'").run();
    const restricted = await f.directory(); assert.equal(restricted.source_events_available, false);
    assert.ok(restricted.events.every((value: { kind: string }) => value.kind !== 'source_event'));
    assert.ok(restricted.events.some((value: { kind: string }) => value.kind === 'plan'));
  } finally { await f.h.close(); }
});

test('Calendar overlap keeps all-day civil dates, exclusive ends, clipped spans and the viewer timezone', async () => {
  const f = await fixture([
    { ...calendarEvent('days'), start: { date: '2026-09-29' }, end: { date: '2026-10-06' } },
    { ...calendarEvent('midnight'), start: { dateTime: '2026-10-04T23:00:00Z', timeZone: 'UTC' }, end: { dateTime: '2026-10-05T00:00:00Z', timeZone: 'UTC' } },
    { ...calendarEvent('cancelled'), status: 'cancelled', start: undefined, end: undefined, recurringEventId: 'series', originalStartTime: { dateTime: '2026-10-04T11:00:00Z', timeZone: 'UTC' } },
  ]); try {
    const allDay = await f.save('days'), timed = await f.save('midnight'), cancelled = await f.save('cancelled');
    const events = (await f.directory('2026-10-01', '2026-10-05')).events as SourceCalendarEvent[];
    const span = events.find((event) => event.source.public_id === allDay.public_id)!;
    assert.deepEqual([span.date, span.last_date], ['2026-09-29', '2026-10-05']);
    assert.deepEqual(calendarEventDates(span, { start: '2026-10-01', end: '2026-10-05' }), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
    const midnight = events.find((event) => event.source.public_id === timed.public_id)!;
    assert.deepEqual([midnight.date, midnight.last_date], ['2026-10-04', '2026-10-04']);
    const cancel = events.find((event) => event.source.public_id === cancelled.public_id)!;
    assert.equal(cancel.date, '2026-10-04'); assert.equal(cancel.source.facts.status, 'cancelled');
    const island = (await f.directory('2026-10-05', '2026-10-05', 'Pacific/Kiritimati')).events as SourceCalendarEvent[];
    const shifted = island.find((event) => event.source.public_id === timed.public_id)!;
    assert.deepEqual([shifted.date, shifted.last_date], ['2026-10-05', '2026-10-05']);
    assert.deepEqual(calendarEventDates(shifted, { start: '2026-10-05', end: '2026-10-05' }), ['2026-10-05']);
    assert.ok(!(await f.directory('2026-10-06', '2026-10-06')).events.some((event: SourceCalendarEvent) => event.source?.public_id === allDay.public_id));
  } finally { await f.h.close(); }
});

test('Calendar cards retain private busy context and cancellations after disconnect without exposing provider rights', async () => {
  const f = await fixture([{ ...calendarEvent(), visibility: 'private', summary: 'Never expose this', location: 'Private address' }]); try {
    const saved = await f.save();
    let event = (await f.directory()).events[0] as SourceCalendarEvent;
    assert.equal(event.title, 'Busy'); assert.equal(event.source.facts.redacted, true); assert.equal(event.source.facts.location, null);
    assert.equal(event.source.source_status, 'available');
    const cancelled = { ...saved.facts, status: 'cancelled', conference_url: null };
    await f.h.db.prepare('UPDATE calendar_events SET facts = ?, revision = revision + 1 WHERE workspace_id = ? AND public_id = ?').bind(JSON.stringify(cancelled), 'test', saved.public_id).run();
    await f.h.providers.disconnectGoogleConnection(f.h.db, actor, environment, f.c.connection.id, f.c.connection.revision, async () => new Response(null, { status: 200 }));
    event = (await f.directory()).events[0]; assert.equal(event.source.source_status, 'review_required'); assert.equal(event.source.facts.status, 'cancelled');
    assert.doesNotMatch(JSON.stringify(event), /Never expose this|Private address|calendar-access|calendar-refresh|authorization_revision/);
  } finally { await f.h.close(); }
});

test('Unresolved source times remain retained but are explicitly omitted from the calendar grid', async () => {
  const f = await fixture(); try {
    const saved = await f.save(), point = { date: null, date_time: '2026-10-25T01:30:00', time_zone: 'Europe/Lisbon', instant: null };
    const facts = { ...saved.facts, start: point, end: { ...point, date_time: '2026-10-25T02:30:00' } };
    f.h.calendarFacts.readCalendarEventFacts(facts);
    await f.h.db.prepare('UPDATE calendar_events SET facts = ?, revision = revision + 1 WHERE workspace_id = ? AND public_id = ?').bind(JSON.stringify(facts), 'test', saved.public_id).run();
    const result = await f.directory(); assert.equal(result.source_date_uncertain, true); assert.deepEqual(result.events, []);
    const retained = await f.h.eventLinks.savedCalendarEvents(f.h.db, actor, new URLSearchParams()); assert.equal(retained.events![0].facts.start!.date_time, point.date_time);
    await f.h.db.prepare("UPDATE workspace_sync_state SET paused = 1 WHERE workspace_id = 'test'").run();
    const paused = await f.directory(); assert.equal(paused.source_date_uncertain, false); assert.deepEqual(paused.events, []);
  } finally { await f.h.close(); }
});

test('Calendar source limits report more context and profile previews page three records without skipping one', async () => {
  const f = await fixture(); try {
    const saved = await f.save();
    for (let i = 0; i < 103; i++) {
      const id = 'bounded-' + i, facts = { ...saved.facts, id };
      await f.h.db.prepare(`INSERT INTO calendar_events (public_id, workspace_id, provider, account_key, account_email, calendar_key, calendar_label, calendar_time_zone, external_id, facts, availability, observed_at, created_at, updated_at)
        VALUES (?, 'test', 'google-calendar', 'google-owner', 'owner@example.test', ?, 'Personal', 'Europe/Lisbon', ?, ?, 'available', ?, ?, ?)`).bind(crypto.randomUUID(), calendarId, id, JSON.stringify(facts), saved.observed_at, saved.observed_at, saved.observed_at).run();
    }
    const result = await f.directory(); assert.equal(result.source_truncated, true); assert.equal(result.events.length, 100);
    assert.equal(result.truncated, false); assert.equal(result.source_events_available, true);
    // Dense shared meetings must also fit the mobile response budget, including UTF-8 names.
    for (let i = 0; i < 20; i++) {
      const person = await f.h.call('contacts', { method: 'POST', body: { name: '👋'.repeat(90) + ' Person ' + i } }); assert.equal(person.status, 201);
    }
    await f.h.db.prepare(`INSERT INTO calendar_event_people (workspace_id, event_id, contact_id, created_at)
      SELECT e.workspace_id, e.id, c.id, ? FROM calendar_events e JOIN contacts c ON c.workspace_id = e.workspace_id WHERE e.workspace_id = 'test'`).bind(saved.observed_at).run();
    const dense = await f.directory(); assert.equal(dense.source_truncated, true); assert.ok(dense.events.length < 100);
    assert.ok(new TextEncoder().encode(JSON.stringify(dense.events)).byteLength < 513 * 1024);
    const preview = await f.h.call('calendar/events?limit=3'); assert.equal(preview.status, 200); assert.equal(preview.body.events.length, 3); assert.equal(preview.body.more, true);
    const next = await f.h.call('calendar/events?' + new URLSearchParams({ limit: '3', after: String(preview.body.next) }));
    assert.equal(next.status, 200); assert.equal(next.body.events.length, 3);
    assert.equal(new Set([...preview.body.events, ...next.body.events].map((event: { public_id: string }) => event.public_id)).size, 6);
    for (const limit of ['0', '51', 'bad', '1.5', '03']) assert.equal((await f.h.call('calendar/events?limit=' + limit)).status, 400);
  } finally { await f.h.close(); }
});
