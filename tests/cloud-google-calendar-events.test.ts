import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { googleActor as actor } from './helpers/google-contact-fixture.ts';
import { calendarEnvironment as environment, selectedCalendar, calendarId, calendarEvent } from './helpers/google-calendar-fixture.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';
const query = () => new URLSearchParams({ calendar_id: calendarId });
type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
async function complete(h: Harness, c: Awaited<ReturnType<typeof selectedCalendar>>, items: unknown[] = [calendarEvent()]) {
  const run = await h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, c.body);
  await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, run.id, async () => Response.json({ items }));
  return h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, query());
}
test('Event adapter preserves recurrence, offset/all-day semantics and partial attendees while redacting private details before persistence', async () => {
  const h = await createCloudHarness(); try {
    const event = h.googleEvents.normalizeGoogleEvent({ ...calendarEvent(), recurringEventId: 'series', originalStartTime: { dateTime: '2026-10-03T12:00:00+01:00', timeZone: 'Europe/Lisbon' }, iCalUID: 'series@google.test', attendeesOmitted: true }, 'Europe/Lisbon');
    assert.equal(event.start!.instant, '2026-10-04T11:00:00.000Z'); assert.equal(event.original_start!.instant, '2026-10-03T11:00:00.000Z'); assert.equal(event.recurring_id, 'series'); assert.equal(event.ical_uid, 'series@google.test'); assert.equal(event.attendees_incomplete, true);
    assert.equal(event.conference_url, 'https://meet.google.com/abc-defg-hij'); assert.doesNotMatch(JSON.stringify(event), /Private CRM|attachments|do-not-save/);
    for (const visibility of ['private', 'confidential']) { const busy = h.googleEvents.normalizeGoogleEvent({ ...calendarEvent(), visibility, location: 'secret location', eventType: 'fromGmail', iCalUID: 'secret@calendar', hangoutLink: 'https://secret.test/' }, 'Europe/Lisbon');
      assert.equal(busy.title, 'Busy'); assert.equal(busy.redacted, true); assert.deepEqual(busy.attendees, []); assert.equal(busy.organizer, null); assert.doesNotMatch(JSON.stringify(busy), /Ana|secret|meet\.google|owner@example/); }
    const allDay = h.googleEvents.normalizeGoogleEvent({ id: 'all-day', start: { date: '2026-10-04' }, end: { date: '2026-10-06' } }, 'Europe/Lisbon'); assert.equal(allDay.end!.date, '2026-10-06'); assert.equal(allDay.start!.instant, null);
    const cancelled = h.googleEvents.normalizeGoogleEvent({ id: 'cancelled', status: 'cancelled', recurringEventId: 'series', originalStartTime: { date: '2026-10-05' } }, 'Europe/Lisbon'); assert.equal(cancelled.start, null); assert.equal(cancelled.original_start!.date, '2026-10-05');
    assert.equal(h.googleEvents.normalizeGoogleEvent({ id: 'deleted', status: 'cancelled' }, 'UTC').status, 'cancelled');
    const wall = h.googleEvents.normalizeGoogleEvent({ ...calendarEvent(), start: { dateTime: '2026-10-04T12:00:00', timeZone: 'Europe/Lisbon' } }, 'Europe/Lisbon'); assert.equal(wall.start!.instant, '2026-10-04T11:00:00.000Z');
    const fold = h.googleEvents.normalizeGoogleEvent({ id: 'fold', start: { dateTime: '2026-10-25T01:30:00', timeZone: 'Europe/Lisbon' }, end: { dateTime: '2026-10-25T03:00:00', timeZone: 'Europe/Lisbon' } }, 'Europe/Lisbon'); assert.equal(fold.start!.instant, null); assert.equal(fold.start!.date_time, '2026-10-25T01:30:00');
    for (const bad of [{ ...calendarEvent(), visibility: ['private'] }, { ...calendarEvent(), status: ['confirmed'] }, { ...calendarEvent(), attendees: [{ email: 'ana@example.test', responseStatus: ['accepted'] }] }, { ...calendarEvent(), start: { date: '2026-02-30' }, end: { date: '2026-03-02' } }, { ...calendarEvent(), end: { dateTime: '2026-10-04T09:00:00Z' } }]) assert.throws(() => h.googleEvents.normalizeGoogleEvent(bad, 'UTC'));
    const window = h.googleEvents.calendarDownloadWindow('Europe/Lisbon', 0, 0, new Date('2026-10-25T12:00:00Z')); assert.deepEqual(window, { start: '2026-10-24T23:00:00.000Z', end: '2026-10-26T00:00:00.000Z' });
    assert.throws(() => h.googleEvents.calendarDownloadWindow('UTC', 90, 300));
  } finally { await h.close(); }
});
test('Event requests use bounded fixed fields, expanded instances and a fixed civil window; HTTP availability and scope failures stay distinct', async () => {
  const h = await createCloudHarness(); try {
    const page = await h.googleEvents.googleEventsPage('access', 'group/id@example.test', 'Europe/Lisbon', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'cursor', async (address, request) => {
      const url = new URL(address); assert.match(url.pathname, /group%2Fid%40example\.test/); assert.equal(url.searchParams.get('singleEvents'), 'true'); assert.equal(url.searchParams.get('showDeleted'), 'true'); assert.equal(url.searchParams.get('maxResults'), '50'); assert.equal(url.searchParams.get('maxAttendees'), '100');
      assert.equal(url.searchParams.get('pageToken'), 'cursor'); assert.equal(url.searchParams.get('timeMin'), '2026-01-01T00:00:00Z'); assert.equal(url.searchParams.has('syncToken'), false); assert.doesNotMatch(url.searchParams.get('fields')!, /description|attachments|accessCode|comment/); assert.equal(new Headers(request.headers).get('Authorization'), 'Bearer access');
      return Response.json({ items: [calendarEvent()], nextPageToken: 'next' });
    }); assert.equal(page.events.length, 1); assert.equal(page.next, 'next');
    for (const [status, body, reason] of [[404, '', 'unavailable'], [403, { error: { errors: [{ reason: 'forbidden' }] } }, 'unavailable'], [403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }, 'permission'], [403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 'retry'], [503, '', 'retry']] as const) {
      await assert.rejects(h.googleEvents.googleEventsPage('t', calendarId, 'UTC', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', null, async () => typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status })), (error: unknown) => error instanceof h.googleEvents.GoogleEventsError && error.reason === reason);
    }
    await assert.rejects(h.googleEvents.googleEventsPage('t', calendarId, 'UTC', 'a', 'b', null, async () => Response.json({ items: [calendarEvent(), calendarEvent()] })), /download could not/);
    await assert.rejects(h.googleEvents.googleEventsPage('t', calendarId, 'UTC', 'a', 'b', null, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))), /download could not/);
  } finally { await h.close(); }
});
test('Complete generations publish atomically; exact/concurrent start receipts and leases survive interruption without changing the previous view', async () => {
  const h = await createCloudHarness(); try {
    const c = await selectedCalendar(h), first = await complete(h, c); assert.equal(first.events[0].title, 'Lunch with Ana');
    const body = { ...c.body, operation_id: crypto.randomUUID() }, runs = await Promise.all([h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, body), h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, body)]); assert.equal(runs[0].id, runs[1].id);
    await assert.rejects(h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, { ...body, past_days: 1 }), /different calendar/);
    const page = await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, body.operation_id, async () => Response.json({ items: [calendarEvent('updated')], nextPageToken: 'a' })); assert.equal(page.status, 'active');
    assert.equal((await h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, query())).generation, first.generation);
    await h.db.prepare('UPDATE provider_event_runs SET lease_token = ?, lease_until = ? WHERE id = ?').bind('other', Date.now() + 60000, body.operation_id).run();
    let calls = 0; await assert.rejects(h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, body.operation_id, async () => { calls++; return Response.json({ items: [] }); }), /running/); assert.equal(calls, 0);
    await h.db.prepare('UPDATE provider_event_runs SET lease_until = 0 WHERE id = ?').bind(body.operation_id).run();
    const done = await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, body.operation_id, async (address) => { assert.equal(new URL(address).searchParams.get('pageToken'), 'a'); return Response.json({ items: [{ ...calendarEvent('second'), visibility: 'private' }] }); }); assert.equal(done.status, 'complete');
    const fresh = await h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, query()); assert.notEqual(fresh.generation, first.generation); assert.deepEqual(fresh.events.map((e) => e.id).sort(), ['second', 'updated']);
    const index = await h.db.prepare('SELECT facts FROM provider_event_index WHERE event_id = ?').bind('second').first<{ facts: string }>(); assert.doesNotMatch(index!.facts, /Ana|owner@example|meet.google/);
    assert.equal((await h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, body)).status, 'complete');
  } finally { await h.close(); }
});
test('Long cursor cycles, duplicate source IDs and capacity limits fail visibly while retaining the last complete generation', async () => {
  const h = await createCloudHarness(); try {
    const c = await selectedCalendar(h), first = await complete(h, c);
    for (const failure of ['cycle', 'duplicate', 'capacity', 'privacy']) {
      const body = { ...c.body, operation_id: crypto.randomUUID() }; await h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, body);
      if (failure === 'capacity') await h.db.prepare('UPDATE provider_event_runs SET processed = 5000 WHERE id = ?').bind(body.operation_id).run();
      const step = (items: unknown[], nextPageToken?: string) => h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, body.operation_id, async () => Response.json({ items, nextPageToken }));
      let result;
      if (failure === 'cycle') { await step([], 'a'); await step([], 'b'); result = await step([], 'a'); }
      else if (failure === 'duplicate') { await step([calendarEvent('duplicate')], 'a'); result = await step([calendarEvent('duplicate')]); }
      else if (failure === 'privacy') result = await step([{ ...calendarEvent('bad-privacy'), visibility: ['private'], summary: 'PRIVATE invalid flag must not persist' }]);
      else result = await step([calendarEvent('over')]);
      assert.equal(result.status, 'failed'); assert.equal(result.issue, 'unsupported_events'); assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM provider_event_index WHERE facts LIKE '%PRIVATE invalid flag%'").first())!.n, 0); assert.equal((await h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, query())).generation, first.generation);
    }
  } finally { await h.close(); }
});
test('Quota retries honor the deadline and exhaust visibly; calendar-specific failures retain source data without revoking the account', async () => {
  const h = await createCloudHarness(); try {
    const c = await selectedCalendar(h), first = await complete(h, c), body = { ...c.body, operation_id: crypto.randomUUID() };
    await h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, body);
    let calls = 0; const retry = async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '9999' } }); };
    const result = await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, body.operation_id, retry); assert.equal(result.status, 'active'); assert.ok(result.retry_at <= Date.now() + 900000); assert.ok(result.retry_at > Date.now());
    await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, body.operation_id, retry); assert.equal(calls, 1);
    for (let n = 0; n < 8; n++) { await h.db.prepare('UPDATE provider_event_runs SET retry_at = 0 WHERE id = ?').bind(body.operation_id).run(); await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, body.operation_id, retry); }
    assert.equal((await h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, query())).run!.status, 'failed');
    const unavailable = { ...c.body, operation_id: crypto.randomUUID() }; await h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, unavailable);
    const lost = await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, unavailable.operation_id, async () => new Response('', { status: 404 })); assert.equal(lost.issue, 'calendar_unavailable');
    const retained = await h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, query()); assert.equal(retained.generation, first.generation); assert.equal(retained.availability, 'unavailable'); assert.equal(retained.events.length, 1);
    assert.equal((await h.db.prepare('SELECT status FROM provider_connections WHERE id = ?').bind(c.connection.id).first())!.status, 'connected');
    await complete(h, { ...c, body: { ...c.body, operation_id: crypto.randomUUID() } }); assert.equal((await h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, query())).availability, 'available');
  } finally { await h.close(); }
});
test('Late event pages cannot cross deselection, authorization, restored epochs or membership changes; scope loss cancels operational reads', async () => {
  for (const change of ['deselection', 'authorization', 'restore', 'membership', 'scope', 'cancel']) {
    const h = await createCloudHarness(); try {
      const c = await selectedCalendar(h), first = await complete(h, c), body = { ...c.body, operation_id: crypto.randomUUID() }; await h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, body);
      await assert.rejects(h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, body.operation_id, async () => {
        if (change === 'deselection') { const r = await h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id); await h.googleCalendarResources.selectCalendars(h.db, actor, c.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: r.epoch, expected_authorization_revision: r.authorization_revision, expected_generation: r.generation, expected_selection_revision: r.selection_revision, selected_ids: [] }); }
        if (change === 'authorization') await h.providers.disconnectGoogleConnection(h.db, actor, environment, c.connection.id, c.connection.revision, async () => new Response(null, { status: 200 }));
        if (change === 'restore') await h.db.prepare('UPDATE workspace_sync_state SET epoch = ? WHERE workspace_id = ?').bind(crypto.randomUUID(), 'test').run();
        if (change === 'membership') await h.db.prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = 'test' AND user_id = 'owner'").run();
        if (change === 'cancel') { const stopped = await h.eventDownloads.cancelEventDownload(h.db, actor, c.connection.id, body.operation_id); assert.equal(stopped.status, 'cancelled'); assert.equal((await h.eventDownloads.cancelEventDownload(h.db, actor, c.connection.id, body.operation_id)).status, 'cancelled'); }
        if (change === 'scope') return Response.json({ error: { errors: [{ reason: 'insufficientPermissions' }] } }, { status: 403 });
        return Response.json({ items: [calendarEvent('late')] });
      }));
      assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM provider_event_index WHERE event_id = 'late'").first())!.n, 0);
      if (!['membership', 'cancel'].includes(change)) assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM provider_event_index").first())!.n, 0);
      else assert.equal((await h.db.prepare('SELECT active_generation FROM provider_event_resources WHERE connection_id = ?').bind(c.connection.id).first())!.active_generation, first.generation);
      if (change === 'scope') assert.equal((await h.db.prepare('SELECT status FROM provider_connections WHERE id = ?').bind(c.connection.id).first())!.status, 'reconnect_required');
    } finally { await h.close(); }
  }
});
test('Event pagination is generation-bound, cancelled events are explicit, and HTTP routes enforce owner, origin and supported paths', async () => {
  const h = await createCloudHarness(); try {
    const c = await selectedCalendar(h), body = c.body; await h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, body);
    await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, body.operation_id, async () => Response.json({ items: Array.from({ length: 50 }, (_, n) => calendarEvent('e' + String(n).padStart(3, '0'))), nextPageToken: 'next' }));
    await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, body.operation_id, async () => Response.json({ items: [calendarEvent('e050'), { id: 'deleted', status: 'cancelled' }] }));
    const review = await h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, query()); assert.equal(review.events.length, 50); assert.equal(review.more, true);
    const next = query(); next.set('after', review.next!); next.set('generation', review.generation!); assert.equal((await h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, next)).events[0].id, 'e050');
    next.set('generation', crypto.randomUUID()); await assert.rejects(h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, next), /Events changed/);
    const cancelled = query(); cancelled.set('cancelled', '1'); const all = await h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, cancelled); assert.equal(all.more, true);
    const path = ['connections', c.connection.id, 'calendars', 'events']; assert.equal(getCloudApiRewrite('/api/' + path.join('/')), '/api/cloud/' + path.join('/')); assert.ok(getCloudApiRewrite('/api/' + path.join('/') + '/step')); assert.equal(getCloudApiRewrite('/api/' + path.join('/') + '/unexpected'), null);
    const response = await h.providerApi.handleProviderConnections(new Request('https://test.invalid/api/' + path.join('/') + '?' + query()), actor, path); assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.doesNotMatch(await response.text(), /calendar-access|calendar-refresh|lease_token|fingerprint|next_page/);
    const forbidden = await h.providerApi.handleProviderConnections(new Request('https://test.invalid/api/' + path.join('/'), { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, operation_id: crypto.randomUUID() }) }), actor, path); assert.equal(forbidden.status, 403);
    const outsider = await h.providerApi.handleProviderConnections(new Request('https://test.invalid/api/' + path.join('/') + '?' + query()), { ...actor, userId: 'outsider' }, path); assert.equal(outsider.status, 403);
    await assert.rejects(h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, new URLSearchParams({ calendar_id: 'unselected@example.test' })), /saved choices/);
  } finally { await h.close(); }
});
test('The same event ID in separate selected calendars remains a separate source copy; empty complete windows replace only their own index', async () => {
  const h = await createCloudHarness(); try {
    const c = await selectedCalendar(h), other = 'work@example.test';
    const discovery = await h.googleCalendarResources.startCalendarDiscovery(h.db, actor, environment, c.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: c.epoch, expected_authorization_revision: c.connection.authorization_revision });
    await h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, environment, c.connection.id, discovery.id, async () => Response.json({ items: [calendarId, other].map((id) => ({ id, summary: id, timeZone: 'Europe/Lisbon', accessRole: 'owner' })) }));
    const review = await h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id);
    await h.googleCalendarResources.selectCalendars(h.db, actor, c.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: c.epoch, expected_authorization_revision: review.authorization_revision, expected_generation: review.generation, expected_selection_revision: review.selection_revision, selected_ids: [calendarId, other] });
    const choices = await h.googleCalendarResources.reviewCalendars(h.db, actor, c.connection.id);
    const personal = { ...c, body: { ...c.body, expected_selection_revision: choices.selection_revision } };
    await complete(h, personal);
    await complete(h, { ...personal, body: { ...personal.body, operation_id: crypto.randomUUID(), calendar_id: other } });
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_event_index').first())!.n, 2);
    await complete(h, { ...personal, body: { ...personal.body, operation_id: crypto.randomUUID(), past_days: 0, future_days: 0 } }, []);
    assert.equal((await h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, query())).events.length, 0);
    assert.equal((await h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, new URLSearchParams({ calendar_id: other }))).events.length, 1);
  } finally { await h.close(); }
});
test('Real CRM backup/restore excludes event previews and credentials, cancels pending reads, and erasure removes operational event records', async () => {
  const h = await createCloudHarness(); try {
    const c = await selectedCalendar(h); await complete(h, c);
    const scheduled = await h.eventDownloads.reviewCalendarEvents(h.db, actor, c.connection.id, query());
    await h.eventDownloads.changeCalendarEventSchedule(h.db, actor, c.connection.id, { calendar_id: calendarId, expected_epoch: scheduled.epoch, expected_authorization_revision: scheduled.authorization_revision,
      expected_selection_revision: scheduled.selection_revision, expected_settings_revision: scheduled.schedule.revision, enabled: true, interval: 86400, past_days: 90, future_days: 180 });
    const created = await h.call('contacts', { method: 'POST', body: { name: 'Ana', notes: 'Private confirmed history' } }); assert.equal(created.status, 201);
    const body = { ...c.body, operation_id: crypto.randomUUID() }; await h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, body);
    const backup = await h.call('settings/backups', { method: 'POST' }), filename = backup.body.backups[0].filename;
    const snapshot = await h.call('settings/backups/' + filename); assert.equal(snapshot.status, 200); assert.doesNotMatch(JSON.stringify(snapshot.body), /provider_event|calendar-refresh|Lunch with Ana/);
    const restored = await h.call('settings/restore', { method: 'POST', body: { filename, confirmation: 'RESTORE' } }); assert.equal(restored.status, 200);
    for (const table of ['provider_event_index', 'provider_event_resources', 'provider_event_pages']) assert.equal((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first())!.n, 0);
    assert.equal((await h.db.prepare('SELECT status FROM provider_event_runs WHERE id = ?').bind(body.operation_id).first())!.status, 'cancelled');
    assert.equal((await h.db.prepare('SELECT notes FROM contacts').first())!.notes, 'Private confirmed history');
    assert.equal((await h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } })).status, 200);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM provider_event_runs').first())!.n, 0);
  } finally { await h.close(); }
});
