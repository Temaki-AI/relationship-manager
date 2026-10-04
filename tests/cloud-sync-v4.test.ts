import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { googleActor as actor } from './helpers/google-contact-fixture.ts';
import { selectedCalendar, calendarEnvironment as environment, calendarId, calendarEvent } from './helpers/google-calendar-fixture.ts';
import { SYNC_V4_ENTITIES, type SyncV4EntityRecord } from '../packages/domain/src/sync-v4.ts';
import { readBootstrapV4, readPullV4, readSyncV4Record, readPushResultV4, calendarContextIds } from '../packages/domain/src/sync-v4-client.ts';
import { readCalendarEventFacts } from '../packages/domain/src/calendar-events.ts';
import { WORKSPACE_ERASURE_CONFIRMATION } from '../lib/workspace-erasure-contract.ts';
type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
async function fixture() {
  const h = await createCloudHarness(), c = await selectedCalendar(h);
  async function download(items: unknown[] = [calendarEvent()]) {
    const run = await h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, { ...c.body, operation_id: crypto.randomUUID() });
    await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, run.id, async () => Response.json({ items }));
  }
  await download();
  const person = async (name = 'Ana') => (await h.call('contacts', { method: 'POST', body: { name, email: 'ana@example.test', notes: 'Private notes' } })).body.contact;
  async function save(contact_ids: number[] = [], plan_ids: number[] = []) {
    const p = await h.eventLinks.eventLinkPreview(h.db, actor, c.connection.id, new URLSearchParams({ calendar_id: calendarId, event_id: 'meeting1' }));
    return (await h.eventLinks.linkCalendarEvent(h.db, actor, c.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: p.epoch,
      expected_authorization_revision: p.authorization_revision, expected_selection_revision: p.selection_revision, expected_generation: p.generation,
      calendar_id: calendarId, event_id: 'meeting1', expected_event_revision: p.saved?.revision ?? null, contact_ids, plan_ids })).event!;
  }
  return { h, c, person, save, download };
}
async function bootstrap(h: Harness) {
  const records: SyncV4EntityRecord[] = []; let query = '', cursor;
  do {
    const r = await h.call('v4/sync/bootstrap' + query); assert.equal(r.status, 200, JSON.stringify(r.body));
    const page = readBootstrapV4(r.body); records.push(...page.records); cursor = page.cursor;
    query = page.next ? '?' + new URLSearchParams(Object.entries(page.next).map(([k, v]) => [k, String(v)])) : '';
  } while (query);
  return { records, cursor: cursor! };
}
const event = (records: SyncV4EntityRecord[]) => records.find((r) => r.entity === 'source_event')!;
async function count(h: Harness, table: string) { return (await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{ n: number }>())!.n; }

test('v4 publishes one reviewed event with public graph identities; older clients skip source context', async () => {
  const f = await fixture(); try {
    const a = await f.person(), b = await f.person('Ana work');
    const plan = (await f.h.call('plans', { method: 'POST', body: { contact_id: b.id, type: 'meetup', planned_date: '2026-10-05', notes: 'Private plan' } })).body.plan;
    const saved = await f.save([a.id, b.id], [plan.id]), first = await bootstrap(f.h), record = event(first.records);
    assert.equal(record.id, saved.public_id); assert.equal(record.legacyId > 0, true); assert.equal(first.records.filter((r) => r.entity === 'source_event').length, 1);
    assert.deepEqual(calendarContextIds(record.data!.contact_ids), [a.public_id, b.public_id].sort()); assert.deepEqual(calendarContextIds(record.data!.plan_ids), [plan.public_id]);
    assert.equal(record.data!.source_status, 'available'); assert.equal(readCalendarEventFacts(JSON.parse(String(record.data!.facts))).title, 'Lunch with Ana');
    assert.doesNotMatch(JSON.stringify(record), /calendar-refresh|calendar-access|Private notes|Private plan|description|attachments|do-not-save/);
    for (const version of [1, 2, 3]) {
      const old = await f.h.call(`v${version}/sync/bootstrap`); assert.equal(old.status, 200);
      assert.ok(old.body.records.every((r: { entity?: string }) => r.entity !== 'source_event'));
      const changes = await f.h.call(`v${version}/sync/pull?epoch=${first.cursor.epoch}&sequence=${first.cursor.sequence}`);
      assert.deepEqual(changes.body.changes, []); assert.equal(changes.body.cursor.sequence, first.cursor.sequence);
    }
    const other = await f.h.call('v4/sync/bootstrap', { workspace: 'other' }); assert.equal(other.status, 200); assert.deepEqual(other.body.records, []);
  } finally { await f.h.close(); }
});

test('published privacy changes, cancellation and source absence advance v4 without changing CRM history', async () => {
  const f = await fixture(); try {
    const p = await f.person(); await f.save([p.id]); const start = (await bootstrap(f.h)).cursor;
    await f.download([{ ...calendarEvent(), visibility: 'private', summary: 'Secret meeting' }]);
    const result = await f.h.call(`v4/sync/pull?epoch=${start.epoch}&sequence=${start.sequence}`), page = readPullV4(result.body, start), current = event(page.records);
    const facts = readCalendarEventFacts(JSON.parse(String(current.data!.facts))); assert.equal(facts.title, 'Busy'); assert.deepEqual(facts.attendees, []);
    assert.doesNotMatch(JSON.stringify(page), /Secret meeting|ana@example/);
    await f.download([{ ...calendarEvent(), status: 'cancelled' }]);
    assert.equal(readCalendarEventFacts(JSON.parse(String(event((await bootstrap(f.h)).records).data!.facts))).status, 'cancelled');
    await f.download([]); const missing = event((await bootstrap(f.h)).records);
    assert.equal(missing.data!.source_status, 'unavailable'); assert.deepEqual(calendarContextIds(missing.data!.contact_ids), [p.public_id]);
    assert.equal(await count(f.h, 'interactions'), 0); assert.equal((await f.h.call('contacts/' + p.id)).body.contact.notes, 'Private notes');
  } finally { await f.h.close(); }
});

test('access changes share the journal, retain facts, and agree between web and v4', async () => {
  const f = await fixture(); try {
    const saved = await f.save(); let prior = (await bootstrap(f.h)).cursor;
    async function status(expected: string) {
      const r = await f.h.call(`v4/sync/pull?epoch=${prior.epoch}&sequence=${prior.sequence}`), page = readPullV4(r.body, prior);
      assert.equal(event(page.records).data!.source_status, expected); prior = page.cursor;
      assert.equal((await f.h.eventLinks.savedCalendarEvents(f.h.db, actor, new URLSearchParams(), saved.public_id)).event!.source_status, expected);
    }
    await f.h.db.prepare("UPDATE provider_calendars SET availability = 'unavailable' WHERE connection_id = ?").bind(f.c.connection.id).run(); await status('unavailable');
    await f.h.db.prepare("UPDATE provider_calendars SET availability = 'available' WHERE connection_id = ?").bind(f.c.connection.id).run(); await status('available');
    await f.h.db.prepare("UPDATE provider_calendar_resources SET selected_ids = '[]' WHERE connection_id = ?").bind(f.c.connection.id).run(); await status('review_required');
    await f.h.db.prepare('UPDATE provider_calendar_resources SET selected_ids = ? WHERE connection_id = ?').bind(JSON.stringify([calendarId]), f.c.connection.id).run(); await status('available');
    await f.h.providers.disconnectGoogleConnection(f.h.db, actor, environment, f.c.connection.id, f.c.connection.revision, async () => new Response(null, { status: 200 })); await status('review_required');
    assert.equal(readCalendarEventFacts(JSON.parse(String(event((await bootstrap(f.h)).records).data!.facts))).title, 'Lunch with Ana');
  } finally { await f.h.close(); }
});

test('time-based expiry invalidates bootstrap continuation and is visible to older cursors', async () => {
  const f = await fixture(); try {
    await f.save(); for (let i = 0; i < 11; i++) await f.person('Person ' + i);
    await f.h.db.prepare('UPDATE provider_connections SET refresh_expires_at = ? WHERE id = ?').bind(Date.now() + 2000, f.c.connection.id).run();
    const first = (await f.h.call('v4/sync/bootstrap')).body; assert.ok(first.next);
    const oldHead = (await f.h.call('v3/sync/bootstrap')).body.cursor;
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const query = new URLSearchParams(Object.entries(first.next).map(([k, v]) => [k, String(v)]));
    const continued = await f.h.call('v4/sync/bootstrap?' + query); assert.equal(continued.status, 409); assert.equal(continued.body.code, 'bootstrap_changed');
    const changes = readPullV4((await f.h.call(`v4/sync/pull?epoch=${first.cursor.epoch}&sequence=${first.cursor.sequence}`)).body, first.cursor);
    assert.equal(event(changes.records).data!.source_status, 'review_required');
    const old = await f.h.call(`v3/sync/pull?epoch=${oldHead.epoch}&sequence=${oldHead.sequence}`);
    assert.deepEqual(old.body.changes, []); assert.equal(old.body.cursor.sequence, changes.cursor.sequence);
  } finally { await f.h.close(); }
});

test('merge references, removal tombstones and restored source context use one identity and fresh epochs', async () => {
  const f = await fixture(); try {
    const a = await f.person(), b = await f.person('Duplicate'), saved = await f.save([a.id, b.id]);
    const review = await f.h.call('contacts/duplicates'); const merge = await f.h.call('contacts/duplicates', { method: 'POST', body: { primaryId: a.id, duplicateIds: [b.id], expectedRevision: review.body.revision } });
    assert.equal(merge.status, 200, JSON.stringify(merge.body)); const before = await bootstrap(f.h);
    assert.equal(event(before.records).id, saved.public_id); assert.deepEqual(calendarContextIds(event(before.records).data!.contact_ids), [a.public_id]);
    const backup = (await f.h.call('settings/backups', { method: 'POST' })).body.backup;
    const current = (await f.h.eventLinks.savedCalendarEvents(f.h.db, actor, new URLSearchParams(), saved.public_id)).event!;
    await f.h.eventLinks.removeSavedCalendarEvent(f.h.db, actor, saved.public_id, { operation_id: crypto.randomUUID(), expected_epoch: before.cursor.epoch, expected_revision: current.revision });
    const removed = readPullV4((await f.h.call(`v4/sync/pull?epoch=${before.cursor.epoch}&sequence=${before.cursor.sequence}`)).body, before.cursor);
    assert.equal(event(removed.records).deleted, true); assert.equal(event(removed.records).data, null);
    const restored = await f.h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } }); assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const after = await bootstrap(f.h); assert.notEqual(after.cursor.epoch, before.cursor.epoch); assert.equal(after.cursor.sequence, 0);
    assert.equal(event(after.records).id, saved.public_id); assert.equal(event(after.records).revision, 1); assert.equal(event(after.records).data!.source_status, 'review_required');
    assert.deepEqual(calendarContextIds(event(after.records).data!.contact_ids), [a.public_id]);
    assert.equal((await f.h.call(`v4/sync/pull?epoch=${before.cursor.epoch}&sequence=0`)).body.code, 'epoch_changed');
    assert.equal((await f.h.call('settings/erase', { method: 'POST', body: { confirmation: WORKSPACE_ERASURE_CONFIRMATION } })).status, 200);
    assert.equal(await count(f.h, 'calendar_events'), 0); assert.equal(await count(f.h, 'sync_entity_records'), 0);
  } finally { await f.h.close(); }
});

test('source facts are read-only while existing v4 mutations retain exact receipts across v3', async () => {
  const f = await fixture(); try {
    const p = await f.person(), saved = await f.save([p.id]), start = await bootstrap(f.h);
    const result = await f.h.call('v4/sync/push', { method: 'POST', body: { version: 4, epoch: start.cursor.epoch, mutation: { operationId: crypto.randomUUID(), entity: 'source_event', entityId: saved.public_id, type: 'delete', baseRevision: 1 } } });
    assert.equal(result.status, 400); assert.equal(result.body.code, 'read_only_entity'); assert.equal(await count(f.h, 'calendar_events'), 1);
    const mutation = { operationId: crypto.randomUUID(), entity: 'contact', entityId: p.public_id, type: 'update', baseRevision: start.records.find((r) => r.entity === 'contact')!.revision, base: { name: 'Ana' }, patch: { name: 'Ana updated' } };
    const pushed = await f.h.call('v4/sync/push', { method: 'POST', body: { version: 4, epoch: start.cursor.epoch, mutation } }); assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
    assert.equal(readPushResultV4(pushed.body, mutation.operationId, 'contact', p.public_id).status, 'applied');
    const retry = await f.h.call('v3/sync/push', { method: 'POST', body: { version: 3, epoch: start.cursor.epoch, mutation } }); assert.equal(retry.body.replayed, true); assert.equal(retry.body.result.record.revision, pushed.body.result.record.revision);
    assert.equal((await f.h.call('v4/sync/push', { method: 'POST', body: { version: 4, epoch: start.cursor.epoch, mutation: { ...mutation, patch: { name: 'Changed intent' } } } })).status, 409);
  } finally { await f.h.close(); }
});

test('v4 readers reject corrupt facts, source graph identities, acknowledgements and ordered pages', async () => {
  const f = await fixture(); try {
    await f.save(); const page = (await f.h.call('v4/sync/bootstrap')).body, record = event(page.records), data = record.data!;
    assert.deepEqual(page.entities, SYNC_V4_ENTITIES); readBootstrapV4(page);
    for (const patch of [{ contact_ids: '[1]' }, { plan_ids: JSON.stringify([record.id, record.id]) }, { contact_ids: JSON.stringify(Array.from({ length: 21 }, () => crypto.randomUUID())) },
      { source_status: ['available'] }, { calendar_time_zone: '' }, { observed_at: '1' }, { calendar_label: 'Bad\u0000label' }, { account_email: 'bad' }, { facts: '{"visibility":"private"}' }, { secret: 'not allowed' }]) {
      assert.throws(() => readSyncV4Record({ ...record, data: { ...data, ...patch } }), /invalid sync/);
    }
    assert.throws(() => readSyncV4Record({ ...record, deleted: true }), /invalid sync/);
    assert.throws(() => readSyncV4Record({ ...record, mergedIntoId: crypto.randomUUID() }), /invalid sync/);
    assert.throws(() => readBootstrapV4({ ...page, entities: SYNC_V4_ENTITIES.slice(0, 6) }), /invalid sync/);
    assert.throws(() => readBootstrapV4({ ...page, records: [record, record] }), /invalid sync/);
    assert.throws(() => readPullV4({ version: 4, more: false, cursor: page.cursor, changes: [{ entity: 'source_event', sequence: page.cursor.sequence, record }] }, page.cursor), /invalid sync/);
    assert.throws(() => readPushResultV4({ version: 4, replayed: false, result: { operationId: 'op', status: ['applied'], record } }, 'op', 'source_event', record.id), /invalid sync/);
  } finally { await f.h.close(); }
});

test('migration 41 seeds existing saved context without renumbering canonical records', async () => {
  const f = await fixture(), db = new Database(':memory:'); try {
    const saved = await f.save(), row = await f.h.db.prepare('SELECT * FROM calendar_events WHERE public_id = ?').bind(saved.public_id).first<Record<string, unknown>>();
    db.pragma('foreign_keys = ON');
    for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter((s) => s.endsWith('.sql') && s < '0041_').sort()) db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
    db.exec("INSERT INTO workspaces (id, name) VALUES ('test', 'Test')");
    const columns = Object.keys(row!); db.prepare(`INSERT INTO calendar_events (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row!) as (string | number | null)[]);
    const head = (db.prepare("SELECT COUNT(*) head FROM sync_changes WHERE workspace_id = 'test'").get() as { head: number }).head;
    db.exec(readFileSync(new URL('../drizzle/0041_calendar_event_sync.sql', import.meta.url), 'utf8'));
    const record = db.prepare("SELECT * FROM sync_entity_records WHERE entity_type = 'source_event'").get() as { public_id: string; legacy_id: number; revision: number; payload: string };
    assert.equal(record.public_id, saved.public_id); assert.equal(record.legacy_id, row!.id); assert.equal(record.revision, 1);
    assert.equal(JSON.parse(record.payload).source_status, 'review_required'); assert.equal((db.prepare("SELECT COUNT(*) head FROM sync_changes WHERE workspace_id = 'test'").get() as { head: number }).head, head + 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM calendar_events').get() as { n: number }).n, 1);
  } finally { db.close(); await f.h.close(); }
});
