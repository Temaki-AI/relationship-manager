import assert from 'node:assert/strict';
import test from 'node:test';
import { publicationFixture, actor } from './helpers/google-publication-fixture.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';
import { selectedCalendar, calendarEnvironment } from './helpers/google-calendar-fixture.ts';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
const count = async (f: Awaited<ReturnType<typeof publicationFixture>>, table: string) => (await f.h.db.prepare('SELECT COUNT(*) n FROM ' + table).first<{ n: number }>())!.n;

test('publishing creates one stable event, redacts private canonical facts and preserves the CRM history', async () => {
  const f = await publicationFixture(); try {
    assert.equal((await f.review()).can_prepare, true); await f.prepare(); assert.equal(f.calls.filter((p) => p.method !== 'GET').length, 0);
    const r = await f.advance(); assert.equal(r.write!.status, 'confirmed'); assert.equal(r.publication!.status, 'published');
    assert.match(f.event!.id as string, /^[0-9a-f]{32}$/u); const insert = f.calls.find((p) => p.method === 'POST')!;
    assert.equal(insert.url.searchParams.get('sendUpdates'), null); assert.equal(insert.body!.attendees, undefined); assert.equal(insert.body!.description, undefined);
    assert.equal(JSON.stringify(insert.body).includes('PRIVATE'), false); assert.equal(await count(f, 'calendar_events'), 1); assert.equal(await count(f, 'calendar_event_plans'), 1);
    const saved = await f.h.db.prepare('SELECT facts FROM calendar_events').first<{ facts: string }>(); assert.equal(JSON.parse(saved!.facts).title, 'Busy');
    const plan = await f.h.db.prepare('SELECT * FROM plans WHERE id = ?').bind(f.plan.id).first();
    assert.equal(plan!.planned_date, '2026-10-20'); assert.equal(plan!.notes, 'PRIVATE PLAN NOTE'); assert.equal(plan!.completed_at, null); assert.equal(await count(f, 'interactions'), 0);
    await f.advance('verify'); assert.equal(f.calls.filter((p) => p.method === 'POST').length, 1); assert.equal(await count(f, 'calendar_events'), 1);
    const detail = await f.h.eventLinks.savedCalendarEvents(f.h.db, actor, new URLSearchParams(), r.saved_event_id!);
    assert.equal(detail.event!.source_status, 'available');
    const bootstrap = await f.h.call('v4/sync/bootstrap'); assert.equal(bootstrap.status, 200);
    const record = bootstrap.body.records.find((entry: { entity: string }) => entry.entity === 'source_event');
    assert.equal(record.id, r.saved_event_id); assert.equal(record.data.source_status, 'available');
    assert.deepEqual(JSON.parse(record.data.plan_ids), [f.plan.public_id]);
    assert.equal(JSON.stringify(record).includes('PRIVATE'), false); assert.equal(JSON.parse(record.data.facts).title, 'Busy');
  } finally { await f.h.close(); }
});

test('lost Google reply is resolved by reading the same ID without another insert or invitation', async () => {
  const f = await publicationFixture(); try {
    await f.prepare(f.draft({ attendee_emails: ['ana@example.test'], follow_plan_date: true })); f.loseReply = true;
    const uncertain = await f.advance(); assert.equal(uncertain.write!.status, 'unknown'); assert.equal(uncertain.write!.attempts, 1);
    const r = await f.advance('verify'); assert.equal(r.write!.status, 'confirmed'); assert.equal(f.calls.filter((p) => p.method === 'POST').length, 1);
    assert.equal(f.calls.find((p) => p.method === 'POST')!.url.searchParams.get('sendUpdates'), 'all');
    assert.equal((await f.h.db.prepare('SELECT planned_date FROM plans WHERE id = ?').bind(f.plan.id).first())!.planned_date, '2026-10-21');
    assert.equal(r.publication!.follow_plan_date, true);
  } finally { await f.h.close(); }
});

test('conditional updates preserve guest responses and private comments without persisting them', async () => {
  const f = await publicationFixture(); try {
    await f.prepare(f.draft({ attendee_emails: ['ana@example.test'] })); await f.advance();
    f.event!.attendees = [{ email: 'ana@example.test', responseStatus: 'accepted', comment: 'PRIVATE GUEST COMMENT', optional: true }];
    await f.prepare(f.draft({ summary: 'Updated coffee', attendee_emails: ['ana@example.test'] })); await f.advance();
    let patch = f.calls.filter((p) => p.method === 'PATCH').at(-1)!; assert.equal(patch.body!.attendees, undefined); assert.ok(patch.headers.get('if-match')); assert.equal(patch.url.searchParams.get('sendUpdates'), 'all');
    await f.prepare(f.draft({ attendee_emails: ['ana@example.test', 'second@example.test'] })); await f.advance();
    patch = f.calls.filter((p) => p.method === 'PATCH').at(-1)!;
    assert.deepEqual((patch.body!.attendees as object[])[0], { email: 'ana@example.test', responseStatus: 'accepted', comment: 'PRIVATE GUEST COMMENT', optional: true });
    const stored = await f.h.db.prepare('SELECT request_json FROM calendar_plan_writes').all<{ request_json: string }>();
    assert.equal(JSON.stringify(stored.results).includes('PRIVATE GUEST COMMENT'), false);
    assert.equal(JSON.stringify((await f.h.db.prepare('SELECT facts FROM calendar_events').all()).results).includes('PRIVATE GUEST COMMENT'), false);
  } finally { await f.h.close(); }
});

test('changed remote versions, cancellation and removal never overwrite or recreate a known event', async () => {
  const f = await publicationFixture(); try {
    await f.prepare(); await f.advance(); await f.prepare(f.draft({ summary: 'Changed locally' }));
    f.event = { ...f.event, summary: 'Changed in Google', etag: '"external"' };
    const conflict = await f.advance(); assert.equal(conflict.write!.status, 'conflict'); assert.equal(f.calls.filter((p) => p.method === 'PATCH').length, 0);
    await f.prepare(f.draft({ summary: 'Explicit new review' }));
    f.event = { ...f.event, etag: '"changed-again"' };
    const failed = await f.advance(); assert.equal(failed.write!.status, 'conflict');
    f.event = { id: f.event!.id, etag: '"cancelled"', status: 'cancelled' };
    assert.equal((await f.review()).can_prepare, false); await assert.rejects(f.prepare(), /cancelled/);
    f.event = null; assert.equal((await f.review()).can_prepare, false); await f.advance('verify'); assert.equal(f.calls.filter((p) => p.method === 'POST').length, 1);
  } finally { await f.h.close(); }
});

test('discard, plan deletion and detached links keep uncertain event receipts and never revive old links', async () => {
  const f = await publicationFixture(); try {
    await f.prepare(); let r = await f.review(); await f.h.planPublications.discardPlanPublication(f.h.db, actor, f.connection.id, f.plan.public_id, { operation_id: r.write!.id, expected_revision: r.write!.revision });
    await f.prepare(); await f.advance(); await f.h.db.prepare('DELETE FROM calendar_event_plans WHERE plan_id = ?').bind(f.plan.id).run();
    await f.advance('verify'); assert.equal(await count(f, 'calendar_event_plans'), 0);
    await f.h.call('plans/' + f.plan.id, { method: 'DELETE' }); r = await f.review(); assert.equal(r.plan, null); assert.equal(r.publication!.status, 'held');
    await f.advance('verify'); assert.equal(await count(f, 'calendar_event_plans'), 0); assert.equal(f.calls.filter((p) => p.method === 'POST').length, 1);
  } finally { await f.h.close(); }
});

test('fresh ownership, origin, exact routes, plan edits and current consent fence publication writes', async () => {
  const f = await publicationFixture(); try {
    const route = `/api/connections/${f.connection.id}/plan-publications/${f.plan.public_id}`;
    assert.equal(getCloudApiRewrite(route + '/step'), route.replace('/api/', '/api/cloud/') + '/step'); assert.equal(getCloudApiRewrite(route + '/other'), null);
    const response = await f.h.providerApi.handleProviderConnections(new Request('https://test.invalid' + route, { method: 'POST', headers: { Origin: 'https://other.invalid', 'Content-Type': 'application/json' }, body: '{}' }), actor, ['connections', f.connection.id, 'plan-publications', f.plan.public_id]); assert.equal(response.status, 403);
    await f.prepare(); const first = await f.review(); f.fail = 429;
    const unsent = await f.h.planPublications.advancePlanPublication(f.h.db, actor, f.env, f.connection.id, f.plan.public_id, { operation_id: first.write!.id, expected_revision: first.write!.revision,
      expected_epoch: first.epoch, expected_authorization_revision: first.authorization_revision, expected_plan_fingerprint: first.plan_fingerprint, mode: 'send' }, f.fetcher);
    assert.equal(unsent.write!.status, 'unknown'); assert.equal(unsent.write!.attempts, 0);
    await f.h.planPublications.discardPlanPublication(f.h.db, actor, f.connection.id, f.plan.public_id, { operation_id: unsent.write!.id, expected_revision: unsent.write!.revision });
    await f.prepare(); await f.h.db.prepare('UPDATE plans SET notes = ? WHERE id = ?').bind('Changed after consent', f.plan.id).run();
    await assert.rejects(f.advance(), /earlier plan/); assert.equal(f.calls.filter((p) => p.method === 'POST').length, 0);
    const conn = await f.h.db.prepare('SELECT revision FROM provider_connections WHERE id = ?').bind(f.connection.id).first<{ revision: number }>();
    await f.h.providers.disconnectGoogleConnection(f.h.db, actor, f.env, f.connection.id, conn!.revision, async () => new Response(null, { status: 200 }));
    const r = await f.review(); assert.equal(r.can_prepare, false); assert.equal(r.write!.status, 'held'); assert.equal(r.publication!.follow_plan_date, false);
    await assert.rejects(f.h.planPublications.reviewPlanPublication(f.h.db, { ...actor, authMethod: 'device' }, f.env, f.connection.id, f.plan.public_id, f.fetcher), /web|owner/);
  } finally { await f.h.close(); }
});

test('complete calendar refreshes follow only a consented date and suspend on manual correction', async () => {
  const f = await publicationFixture(); try {
    await f.prepare(); await f.advance(); const reader = await selectedCalendar(f.h, f.calendar.id as string);
    const changed = (day: string) => ({ ...f.event, start: { date: day }, end: { date: new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10) } });
    async function download(event: object, split = false) {
      const run = await f.h.eventDownloads.startEventDownload(f.h.db, actor, calendarEnvironment, reader.connection.id, { ...reader.body, operation_id: crypto.randomUUID() });
      await f.h.eventDownloads.advanceEventDownload(f.h.db, actor, calendarEnvironment, reader.connection.id, run.id, async () => Response.json({ items: [event], ...(split ? { nextPageToken: 'next' } : {}) }));
      if (split) {
        assert.equal((await f.h.db.prepare('SELECT planned_date FROM plans WHERE id = ?').bind(f.plan.id).first())!.planned_date, '2026-10-21');
        await f.h.eventDownloads.advanceEventDownload(f.h.db, actor, calendarEnvironment, reader.connection.id, run.id, async () => Response.json({ items: [] }));
      }
    }
    await download(changed('2026-10-23')); assert.equal((await f.h.db.prepare('SELECT planned_date FROM plans WHERE id = ?').bind(f.plan.id).first())!.planned_date, '2026-10-20');
    await f.prepare(f.draft({ follow_plan_date: true })); await f.advance();
    await download({ ...f.event, start: { dateTime: '2026-10-23T23:30:00Z', timeZone: 'Europe/Lisbon' }, end: { dateTime: '2026-10-24T00:30:00Z', timeZone: 'Europe/Lisbon' } }, true);
    assert.equal((await f.h.db.prepare('SELECT planned_date FROM plans WHERE id = ?').bind(f.plan.id).first())!.planned_date, '2026-10-24');
    await f.h.db.prepare('UPDATE plans SET planned_date = ? WHERE id = ?').bind('2026-12-01', f.plan.id).run();
    await download(changed('2026-10-25'));
    const plan = await f.h.db.prepare('SELECT * FROM plans WHERE id = ?').bind(f.plan.id).first(); assert.equal(plan!.planned_date, '2026-12-01'); assert.equal(plan!.notes, 'PRIVATE PLAN NOTE'); assert.equal(plan!.completed_at, null);
    assert.equal((await f.review()).publication!.follow_plan_date, false); assert.equal(await count(f, 'interactions'), 0);
  } finally { await f.h.close(); }
});

test('a real completion rollback retains the attempted write for provider reconciliation', async () => {
  const f = await publicationFixture(); try {
    await f.prepare(); let armed = false;
    const db = new Proxy(f.h.db, { get(target, key) {
      if (key === 'batch') return async (statements: Parameters<typeof f.h.db.batch>[0]) => {
        if (armed) { armed = false; return target.batch([...statements, target.prepare('INSERT INTO calendar_plan_writes SELECT * FROM calendar_plan_writes')]); }
        return target.batch(statements);
      }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const fetcher = async (address: string, request: RequestInit) => { const response = await f.fetcher(address, request); if (request.method === 'POST') armed = true; return response; };
    const r = await f.review(); await assert.rejects(f.h.planPublications.advancePlanPublication(db, actor, f.env, f.connection.id, f.plan.public_id,
      { operation_id: r.write!.id, expected_revision: r.write!.revision, expected_epoch: r.epoch, expected_authorization_revision: r.authorization_revision, expected_plan_fingerprint: r.plan_fingerprint, mode: 'send' }, fetcher));
    assert.equal(armed, false); assert.equal(await count(f, 'calendar_events'), 0); assert.equal((await f.review()).write!.status, 'unknown');
    assert.equal((await f.advance('verify')).write!.status, 'confirmed'); assert.equal(await count(f, 'calendar_events'), 1); assert.equal(f.calls.filter((p) => p.method === 'POST').length, 1);
  } finally { await f.h.close(); }
});

test('event drafts validate civil dates, timezone gaps and folds, limits and explicit offsets', async () => {
  const f = await publicationFixture(); try {
    const validate = f.h.publicationDraft.publicationDraft, moment = (time: string) => ({ date: null, date_time: time, time_zone: 'Europe/Lisbon' });
    assert.equal(validate(f.draft()).planDate, '2026-10-21');
    for (const fields of [f.draft({ start: { date: '2026-02-30', date_time: null, time_zone: null } }), f.draft({ summary: 'Bad\nTitle' }), f.draft({ attendee_emails: ['a@example.test', 'A@example.test'] }), f.draft({ description: 'Private notes' }), f.draft({ attendee_emails: Array.from({ length: 21 }, (_, n) => `person${n}@example.test`) })]) assert.throws(() => validate(fields));
    assert.throws(() => validate(f.draft({ start: moment('2026-03-29T01:30:00'), end: moment('2026-03-29T03:30:00') })), /does not exist/);
    assert.throws(() => validate(f.draft({ start: moment('2026-10-25T01:30:00'), end: moment('2026-10-25T03:30:00') })), /occurs twice/);
    const fold = validate(f.draft({ start: moment('2026-10-25T01:30:00+01:00'), end: moment('2026-10-25T03:30:00+00:00') }));
    assert.equal('dateTime' in fold.google.start && fold.google.start.dateTime, '2026-10-25T00:30:00.000Z');
    assert.throws(() => validate(f.draft({ start: moment('2026-10-21T10:00:00+00:00'), end: moment('2026-10-21T11:00:00+01:00') })), /does not match/);
  } finally { await f.h.close(); }
});

test('CRM recovery excludes operational publication receipts and suspends following without replaying external effects', async () => {
  const f = await publicationFixture(); try {
    await f.prepare(f.draft({ follow_plan_date: true })); await f.advance();
    const backup = (await f.h.call('settings/backups', { method: 'POST' })).body.backup;
    assert.equal(backup.schemaVersion, 'cloud-14'); const snapshot = (await f.h.call('settings/backups/' + backup.filename)).body;
    assert.equal(snapshot.tables.calendar_events.length, 1); assert.equal(snapshot.tables.calendar_event_plans.length, 1);
    assert.equal(snapshot.tables.calendar_plan_publications, undefined); assert.equal(snapshot.tables.calendar_plan_writes, undefined); assert.equal(JSON.stringify(snapshot).includes('test-refresh'), false);
    const result = await f.h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } }); assert.equal(result.status, 200);
    const pub = await f.h.db.prepare('SELECT * FROM calendar_plan_publications').first(); assert.equal(pub!.follow_date, 0); assert.equal(pub!.status, 'held');
    assert.equal(await count(f, 'calendar_plan_writes'), 1); assert.equal(await count(f, 'calendar_event_plans'), 1); assert.equal(f.calls.filter((p) => p.method === 'POST').length, 1);
  } finally { await f.h.close(); }
});

test('migration 44 preserves genuine prior grants and calendar setup while adding only local publication records', () => {
  const db = new Database(':memory:'); try {
    db.pragma('foreign_keys = ON'); const directory = new URL('../drizzle/', import.meta.url);
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '0044_').sort()) db.exec(readFileSync(new URL(name, directory), 'utf8'));
    db.exec("INSERT INTO workspaces (id, name) VALUES ('upgrade', 'Upgrade'); INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@test.invalid', 1, 1, 1); INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('upgrade', 'owner', 'owner');");
    const epoch = (db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'upgrade'").get() as { epoch: string }).epoch, id = crypto.randomUUID(), operation = crypto.randomUUID();
    db.prepare("INSERT INTO provider_connections (id, workspace_id, user_id, provider, purpose, account_id, email, display_name, granted_scopes, status, dataset_epoch, credentials, revision, created_at, updated_at) VALUES (?, 'upgrade', 'owner', 'google', 'calendar-publish', 'subject', 'owner@test.invalid', 'Original', '[]', 'connected', ?, 'unchanged-ciphertext', 7, '2026-10-03', '2026-10-03')").run(id, epoch);
    db.prepare("INSERT INTO provider_owned_calendars (connection_id, workspace_id, user_id, operation_id, fingerprint, request_json, dataset_epoch, authorization_revision, created_at, updated_at) VALUES (?, 'upgrade', 'owner', ?, ?, ?, ?, 1, '2026-10-03', '2026-10-03')")
      .run(id, operation, 'a'.repeat(64), JSON.stringify({ client_id: 'publisher', calendar: { summary: 'Everclose', timeZone: 'Europe/Lisbon', description: 'Everclose calendar recovery: ' + operation } }), epoch);
    const before = db.prepare('SELECT * FROM provider_connections').all(), setup = db.prepare('SELECT * FROM provider_owned_calendars').all();
    db.exec(readFileSync(new URL('0044_calendar_plan_publications.sql', directory), 'utf8'));
    assert.deepEqual(db.prepare('SELECT * FROM provider_connections').all(), before); assert.deepEqual(db.prepare('SELECT * FROM provider_owned_calendars').all(), setup);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM calendar_plan_publications').get() as { n: number }).n, 0); assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});
