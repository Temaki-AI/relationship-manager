import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { googleActor as actor } from './helpers/google-contact-fixture.ts';
import { selectedCalendar, calendarEnvironment as environment, calendarId, calendarEvent } from './helpers/google-calendar-fixture.ts';
import type { CalendarEventQueueMessage } from '../lib/cloud/google-event-jobs.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';
async function fixture() {
  const h = await createCloudHarness(), c = await selectedCalendar(h), messages: CalendarEventQueueMessage[] = [];
  let outage = false;
  const queue = { async send(body: CalendarEventQueueMessage) { if (outage) throw new Error('Queue outage'); messages.push(body); } };
  Object.assign(h.emailEnv, { GOOGLE_CALENDAR_QUEUE: queue });
  const review = () => h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, new URLSearchParams({ calendar_id: calendarId }));
  async function choices(enabled = true, extra: Record<string, unknown> = {}) {
    const r = await review();
    return { calendar_id: calendarId, expected_epoch: r.epoch, expected_authorization_revision: r.authorization_revision, expected_selection_revision: r.selection_revision,
      expected_settings_revision: r.schedule.revision, enabled, interval: 86400, past_days: 90, future_days: 180, ...extra };
  }
  const schedule = async (enabled = true, extra: Record<string, unknown> = {}) => h.eventDownloads.changeCalendarEventSchedule(h.db, actor, c.connection.id, await choices(enabled, extra));
  const http = (body: unknown, origin = environment.BETTER_AUTH_URL) => h.providerApi.handleProviderConnections(new Request(`https://test.invalid/api/connections/${c.connection.id}/calendars/events/schedule`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) }), actor, ['connections', c.connection.id, 'calendars', 'events', 'schedule']);
  async function deliver(body: unknown, fetcher: (url: string) => Promise<Response> = async () => Response.json({ items: [calendarEvent()] })) {
    const result = { acknowledgements: 0, retries: [] as number[] };
    await h.eventJobs.processCalendarEventMessage({ body, attempts: 1, ack() { result.acknowledgements++; }, retry(options) { result.retries.push(options?.delaySeconds ?? 0); } }, h.emailEnv as unknown as CloudflareEnv, fetcher);
    return result;
  }
  const tick = () => h.eventJobs.reconcileCalendarEventDownloads(h.db, queue, environment);
  return { h, c, messages, review, choices, schedule, http, deliver, tick, outage(value: boolean) { outage = value; } };
}
test('Calendar refresh is opt-in before first download, revision guarded and bound to the owner, origin and selected calendar', async () => {
  const f = await fixture(); try {
    assert.deepEqual((await f.review()).schedule, { enabled: false, interval: 86400, revision: 0, past_days: 90, future_days: 180, next_at: null });
    assert.equal((await f.tick()).scheduled, 0); assert.equal(f.messages.length, 0);
    const body = await f.choices();
    assert.equal((await f.http(body, 'https://untrusted.invalid')).status, 403);
    assert.equal(getCloudApiRewrite(`/api/connections/${f.c.connection.id}/calendars/events/schedule`), `/api/cloud/connections/${f.c.connection.id}/calendars/events/schedule`);
    assert.equal(getCloudApiRewrite(`/api/connections/${f.c.connection.id}/calendars/events/schedule/extra`), null);
    await assert.rejects(f.h.eventDownloads.changeCalendarEventSchedule(f.h.db, { ...actor, workspaceId: 'other' }, f.c.connection.id, body));
    await assert.rejects(f.schedule(true, { past_days: 200, future_days: 200 }), /365/);
    await assert.rejects(f.schedule(true, { interval: 30 }), /Refresh/);
    await assert.rejects(f.schedule(true, { extra_scope: 'all calendars' }), /Refresh/);
    const response = await f.http(body);
    assert.equal(response.status, 200, await response.text());
    const r = await f.review(); assert.equal(r.generation, null); assert.equal(r.schedule.enabled, true); assert.equal(r.schedule.revision, 1);
    for (const expression of ['past_days = 1.5, settings_revision = settings_revision + 1', 'sync_interval = 30, settings_revision = settings_revision + 1', 'sync_enabled = 0']) {
      await assert.rejects(f.h.db.prepare(`UPDATE provider_event_resources SET ${expression} WHERE connection_id = ?`).bind(f.c.connection.id).run(), /PROVIDER_EVENT_SCHEDULE_INVALID/);
    }
    assert.equal((await f.review()).schedule.revision, 1); assert.equal((await f.review()).schedule.enabled, true);
    await assert.rejects(f.h.eventDownloads.changeCalendarEventSchedule(f.h.db, actor, f.c.connection.id, body), /changed/);
    const tick = await f.tick(); assert.equal(tick.scheduled, 1); assert.equal(tick.enqueued, 1); assert.deepEqual(Object.keys(f.messages[0]).sort(), ['connectionId', 'kind', 'runId', 'version', 'workspaceId']);
    assert.equal((await f.tick()).scheduled, 0); assert.equal((await f.review()).schedule.next_at! >= Date.now() + 86300000, true);
    assert.equal((await f.deliver(f.messages[0])).acknowledgements, 1); assert.equal((await f.review()).events.length, 1);
    let calls = 0; assert.equal((await f.deliver(f.messages[0], async () => { calls++; return Response.json({ items: [] }); })).acknowledgements, 1); assert.equal(calls, 0);
  } finally { await f.h.close(); }
});
test('Queue send outages retain the durable next page, resume without publishing partial views and honor provider retry deadlines', async () => {
  const f = await fixture(); try {
    await f.schedule(); f.outage(true); await assert.rejects(f.tick(), /Queue outage/);
    const original = await f.review(); assert.equal(original.run!.status, 'active'); assert.equal(original.generation, null);
    f.outage(false); assert.equal((await f.tick()).scheduled, 0); const job = f.messages.shift()!; assert.equal(job.runId, original.run!.id);
    f.outage(true);
    await assert.rejects(f.deliver(job, async () => Response.json({ items: [calendarEvent()], nextPageToken: 'second-page' })), /Queue outage/);
    const staged = await f.review(); assert.equal(staged.generation, null); assert.equal(staged.events.length, 0); assert.equal(staged.run!.processed, 1);
    f.outage(false); await f.tick(); let calls = 0;
    const waiting = await f.deliver(job, async (url) => { calls++; assert.equal(new URL(url).searchParams.get('pageToken'), 'second-page'); return new Response('', { status: 429, headers: { 'Retry-After': '120' } }); });
    assert.equal(waiting.retries[0], 120); await f.deliver(job, async () => { calls++; return Response.json({ items: [] }); }); assert.equal(calls, 1);
    await f.h.db.prepare('UPDATE provider_event_runs SET retry_at = 0 WHERE id = ?').bind(job.runId).run();
    await f.deliver(job, async (url) => { assert.equal(new URL(url).searchParams.get('pageToken'), 'second-page'); assert.equal(new URL(url).searchParams.has('syncToken'), false); return Response.json({ items: [] }); });
    const complete = await f.review(); assert.equal(complete.run!.status, 'complete'); assert.equal(complete.events.length, 1);
    assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM provider_event_pages').first())!.n, 0);
  } finally { await f.h.close(); }
});
test('Schedule changes stop late scheduled pages, retain the previous complete view, and leave explicit manual downloads independent', async () => {
  const f = await fixture(); try {
    const manual = await f.h.eventDownloads.startEventDownload(f.h.db, actor, environment, f.c.connection.id, f.c.body);
    await f.schedule(); assert.equal((await f.tick()).scheduled, 0);
    await f.h.eventDownloads.advanceEventDownload(f.h.db, actor, environment, f.c.connection.id, manual.id, async () => Response.json({ items: [calendarEvent()] }));
    const first = await f.review(); await f.tick(); const job = f.messages.shift()!;
    await f.deliver(job, async () => { await f.schedule(false); return Response.json({ items: [calendarEvent('late')] }); });
    const stopped = await f.review(); assert.equal(stopped.schedule.enabled, false); assert.equal(stopped.run!.status, 'cancelled'); assert.equal(stopped.run!.issue, 'schedule_changed');
    assert.equal(stopped.generation, first.generation); assert.equal(stopped.events[0].id, 'meeting1'); assert.equal((await f.tick()).scheduled, 0);
    assert.equal((await f.h.db.prepare("SELECT COUNT(*) n FROM provider_event_index WHERE event_id = 'late'").first())!.n, 0);
    await f.schedule(true); await f.tick(); const another = f.messages.at(-1)!;
    await f.deliver(another, async () => { await f.schedule(true, { past_days: 7, future_days: 14 }); return Response.json({ items: [calendarEvent('changed-window')] }); });
    assert.equal((await f.review()).generation, first.generation);
  } finally { await f.h.close(); }
});
test('A failed publication batch rolls back staging and checkpoint writes before the same job resumes', async () => {
  const f = await fixture(); try {
    await f.schedule(); await f.tick(); await f.deliver(f.messages.shift()!); const first = await f.review();
    await f.h.db.prepare('UPDATE provider_event_resources SET next_sync_at = 0').run(); await f.tick(); const job = f.messages.at(-1)!;
    let armed = false;
    const db = f.h.db;
    f.h.emailEnv.DB = new Proxy(db, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (armed) {
          armed = false;
          return target.batch([...statements.slice(0, 3), target.prepare('INSERT INTO provider_event_pages (run_id, token_hash) VALUES (?, ?)').bind(job.runId, 'fault'),
            target.prepare('INSERT INTO provider_event_pages (run_id, token_hash) VALUES (?, ?)').bind(job.runId, 'fault'), ...statements.slice(3)]);
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    // Credential access also batches a guard. Arm only when an event page is being committed.
    await assert.rejects(f.deliver(job, async () => { armed = true; return Response.json({ items: [calendarEvent('new-meeting')] }); }));
    assert.equal(armed, false, 'the failing real transaction ran');
    assert.equal((await f.review()).generation, first.generation); assert.equal((await f.h.db.prepare('SELECT processed FROM provider_event_runs WHERE id = ?').bind(job.runId).first())!.processed, 0);
    assert.equal((await f.h.db.prepare("SELECT COUNT(*) n FROM provider_event_index WHERE event_id = 'new-meeting'").first())!.n, 0);
    f.h.emailEnv.DB = db; await f.deliver(job, async () => Response.json({ items: [calendarEvent('new-meeting')] }));
    assert.equal((await f.review()).events[0].id, 'new-meeting'); assert.equal((await f.review()).run!.status, 'complete');
  } finally { await f.h.close(); }
});
test('Authorization, selection, dataset and membership changes fence automatic event publication and stale queue messages', async () => {
  for (const change of ['authorization', 'selection', 'dataset', 'membership', 'permission', 'expiry']) {
    const f = await fixture(); try {
      await f.schedule(); await f.tick(); const job = f.messages.shift()!;
      await f.deliver(job, async () => {
        if (change === 'authorization') await f.h.providers.disconnectGoogleConnection(f.h.db, actor, environment, f.c.connection.id, f.c.connection.revision, async () => new Response(null, { status: 200 }));
        if (change === 'selection') { const r = await f.h.googleCalendarResources.reviewCalendars(f.h.db, actor, f.c.connection.id); await f.h.googleCalendarResources.selectCalendars(f.h.db, actor, f.c.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: r.epoch, expected_authorization_revision: r.authorization_revision, expected_generation: r.generation, expected_selection_revision: r.selection_revision, selected_ids: [] }); }
        if (change === 'dataset') await f.h.db.prepare("UPDATE workspace_sync_state SET epoch = ? WHERE workspace_id = 'test'").bind(crypto.randomUUID()).run();
        if (change === 'membership') await f.h.db.prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = 'test' AND user_id = 'owner'").run();
        if (change === 'expiry') await f.h.db.prepare('UPDATE provider_connections SET refresh_expires_at = ? WHERE id = ?').bind(Date.now() - 1, f.c.connection.id).run();
        return change === 'permission' ? Response.json({ error: { errors: [{ reason: 'insufficientPermissions' }] } }, { status: 403 }) : Response.json({ items: [calendarEvent('late')] });
      });
      assert.equal((await f.h.db.prepare("SELECT COUNT(*) n FROM provider_event_index WHERE event_id = 'late'").first())!.n, 0, change);
      let calls = 0; await f.deliver(job, async () => { calls++; return Response.json({ items: [] }); }); assert.equal(calls, 0);
      await f.tick(); assert.equal((await f.h.db.prepare('SELECT status FROM provider_event_runs WHERE id = ?').bind(job.runId).first())!.status !== 'active', true);
    } finally { await f.h.close(); }
  }
});
test('Rolling windows follow calendar civil days through DST and recalculate after a changed window without changing a captured run', async (t) => {
  const f = await fixture(); try {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-24T23:30:00Z') });
    await f.schedule(true, { interval: 3600, past_days: 0, future_days: 0 }); await f.tick(); const first = await f.review();
    const run = (await f.h.db.prepare('SELECT * FROM provider_event_runs WHERE id = ?').bind(first.run!.id).first())!;
    assert.equal(run.window_start, '2026-10-24T23:00:00.000Z'); assert.equal(run.window_end, '2026-10-26T00:00:00.000Z');
    assert.equal(Date.parse(run.window_end as string) - Date.parse(run.window_start as string), 25 * 3600000);
    t.mock.timers.setTime(new Date('2026-10-26T00:30:00Z').getTime()); const repaired = await f.tick(); assert.equal(repaired.expired, 1); assert.equal(repaired.scheduled, 1);
    assert.equal((await f.h.db.prepare('SELECT window_start FROM provider_event_runs WHERE id = ?').bind(run.id).first())!.window_start, run.window_start);
    const next = await f.review();
    const advanced = (await f.h.db.prepare('SELECT window_start, window_end FROM provider_event_runs WHERE id = ?').bind(next.run!.id).first())!;
    assert.equal(advanced.window_start, '2026-10-26T00:00:00.000Z'); assert.equal(advanced.window_end, '2026-10-27T00:00:00.000Z');
    await f.schedule(true, { past_days: 30, future_days: 60 }); await f.tick(); const backfill = await f.review();
    assert.notEqual(backfill.run!.id, next.run!.id); assert.equal(backfill.schedule.past_days, 30); assert.equal(backfill.schedule.future_days, 60);
  } finally { t.mock.timers.reset(); await f.h.close(); }
});
test('Rediscovery fences an unfinished window while retained calendar consent uses its new timezone at the next eligible refresh', async () => {
  const f = await fixture(); try {
    await f.schedule(); await f.tick(); const oldJob = f.messages.shift()!, before = await f.review();
    const discovery = await f.h.googleCalendarResources.startCalendarDiscovery(f.h.db, actor, environment, f.c.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: f.c.epoch, expected_authorization_revision: f.c.connection.authorization_revision });
    await f.h.googleCalendarResources.advanceCalendarDiscovery(f.h.db, actor, environment, f.c.connection.id, discovery.id, async () => Response.json({ items: [{ id: calendarId, summary: 'Updated calendar', timeZone: 'America/New_York', accessRole: 'owner' }] }));
    const changed = await f.review(); assert.equal(changed.selection_revision > before.selection_revision, true); assert.deepEqual(changed.schedule, before.schedule);
    assert.equal(changed.run!.status, 'cancelled'); let calls = 0; await f.deliver(oldJob, async () => { calls++; return Response.json({ items: [] }); }); assert.equal(calls, 0);
    assert.equal((await f.tick()).scheduled, 0, 'rediscovery does not expand the chosen cadence');
    await f.h.db.prepare('UPDATE provider_event_resources SET next_sync_at = 0').run(); assert.equal((await f.tick()).scheduled, 1);
    const run = (await f.h.db.prepare('SELECT * FROM provider_event_runs WHERE id = ?').bind(f.messages.at(-1)!.runId).first())!;
    const expected = f.h.googleEvents.calendarDownloadWindow('America/New_York', 90, 180);
    assert.equal(run.calendar_time_zone, 'America/New_York'); assert.equal(run.window_start, expected.start); assert.equal(run.window_end, expected.end);
    assert.equal(run.selection_revision, changed.selection_revision); assert.equal(run.schedule_revision, changed.schedule.revision);
  } finally { await f.h.close(); }
});
test('Recurring observations preserve saved links, private notes and plan/history while repairing missing and private event facts', async () => {
  const f = await fixture(); try {
    await f.schedule(); await f.tick(); await f.deliver(f.messages.shift()!);
    const person = (await f.h.call('contacts', { method: 'POST', body: { name: 'Ana', notes: 'Private relationship notes', email: 'ana@example.test' } })).body.contact;
    const plan = (await f.h.call('plans', { method: 'POST', body: { contact_id: person.id, type: 'meetup', summary: 'My plan', notes: 'Private plan', planned_date: '2026-11-03' } })).body.plan;
    const preview = await f.h.eventLinks.eventLinkPreview(f.h.db, actor, f.c.connection.id, new URLSearchParams({ calendar_id: calendarId, event_id: 'meeting1' }));
    const saved = await f.h.eventLinks.linkCalendarEvent(f.h.db, actor, f.c.connection.id, { operation_id: crypto.randomUUID(), calendar_id: calendarId, event_id: 'meeting1', expected_epoch: preview.epoch,
      expected_authorization_revision: preview.authorization_revision, expected_selection_revision: preview.selection_revision, expected_generation: preview.generation, expected_event_revision: null, contact_ids: [person.id], plan_ids: [plan.id] });
    const before = await f.h.db.prepare('SELECT * FROM plans WHERE id = ?').bind(plan.id).first();
    for (const items of [[{ ...calendarEvent(), visibility: 'private', summary: 'Secret' }], [], [calendarEvent()]]) {
      await f.h.db.prepare('UPDATE provider_event_resources SET next_sync_at = 0').run(); await f.tick(); await f.deliver(f.messages.at(-1)!, async () => Response.json({ items }));
      const detail = (await f.h.eventLinks.savedCalendarEvents(f.h.db, actor, new URLSearchParams(), saved.event!.public_id)).event!;
      assert.equal(detail.public_id, saved.event!.public_id); assert.equal(detail.people[0].id, person.id); assert.equal(detail.plans[0].id, plan.id);
      if (items[0] && 'visibility' in items[0]) { assert.equal(detail.facts.title, 'Busy'); assert.doesNotMatch(JSON.stringify(detail.facts), /Secret|ana@example/); }
      if (!items.length) { assert.equal(detail.source_status, 'unavailable'); assert.notEqual(detail.facts.status, 'cancelled'); }
    }
    assert.deepEqual(await f.h.db.prepare('SELECT * FROM plans WHERE id = ?').bind(plan.id).first(), before);
    assert.equal((await f.h.db.prepare('SELECT notes FROM contacts WHERE id = ?').bind(person.id).first())!.notes, 'Private relationship notes');
    assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM interactions').first())!.n, 0);
  } finally { await f.h.close(); }
});
test('Bounded due dispatch rotates calendars through tied timestamps, expires abandoned jobs and cleans only unpublished generations', async (t) => {
  const f = await fixture(); try {
    const ids = Array.from({ length: 7 }, (_, i) => `calendar-${i}@example.test`);
    const discovery = await f.h.googleCalendarResources.startCalendarDiscovery(f.h.db, actor, environment, f.c.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: f.c.epoch, expected_authorization_revision: f.c.connection.authorization_revision });
    await f.h.googleCalendarResources.advanceCalendarDiscovery(f.h.db, actor, environment, f.c.connection.id, discovery.id, async () => Response.json({ items: ids.map((id) => ({ id, summary: id, timeZone: 'Europe/Lisbon', accessRole: 'owner' })) }));
    const r = await f.h.googleCalendarResources.reviewCalendars(f.h.db, actor, f.c.connection.id);
    await f.h.googleCalendarResources.selectCalendars(f.h.db, actor, f.c.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: r.epoch, expected_authorization_revision: r.authorization_revision, expected_generation: r.generation, expected_selection_revision: r.selection_revision, selected_ids: ids });
    const choices = await f.h.googleCalendarResources.reviewCalendars(f.h.db, actor, f.c.connection.id);
    for (const id of ids) await f.h.eventDownloads.changeCalendarEventSchedule(f.h.db, actor, f.c.connection.id, { calendar_id: id, expected_epoch: choices.epoch, expected_authorization_revision: choices.authorization_revision, expected_selection_revision: choices.selection_revision, expected_settings_revision: 0, enabled: true, interval: 86400, past_days: 1, future_days: 1 });
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1000 });
    assert.equal((await f.tick()).scheduled, 5); assert.equal((await f.tick()).scheduled, 2); assert.equal((await f.tick()).scheduled, 0); assert.equal(f.messages.length, 15);
    assert.equal(new Set(f.messages.map((j) => j.runId)).size, 7, 'successful dispatch rotates older due work');
    const job = f.messages[0]; await f.deliver(job, async () => Response.json({ items: [calendarEvent()], nextPageToken: 'abandoned' }));
    await f.h.db.prepare('UPDATE provider_event_runs SET created_at = ? WHERE id = ?').bind(new Date(Date.now() - 25 * 3600000).toISOString(), job.runId).run();
    assert.equal((await f.tick()).expired, 1); assert.equal((await f.h.db.prepare('SELECT issue FROM provider_event_runs WHERE id = ?').bind(job.runId).first())!.issue, 'job_expired');
    assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM provider_event_index WHERE generation = (SELECT generation FROM provider_event_runs WHERE id = ?)').bind(job.runId).first())!.n, 0);
    for (const body of [null, { ...job, token: 'forbidden' }, { ...job, workspaceId: 'other' }, { ...job, runId: crypto.randomUUID() }]) { let calls = 0; await f.deliver(body, async () => { calls++; return Response.json({ items: [] }); }); assert.equal(calls, 0); }
  } finally { t.mock.timers.reset(); await f.h.close(); }
});
