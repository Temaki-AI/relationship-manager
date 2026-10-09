import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { googleActor as actor } from './helpers/google-contact-fixture.ts';
import { selectedCalendar, calendarEnvironment as environment, calendarId, calendarEvent } from './helpers/google-calendar-fixture.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';
import { WORKSPACE_ERASURE_CONFIRMATION } from '../lib/workspace-erasure-contract.ts';
type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
const query = (eventId = 'meeting1') => new URLSearchParams({ calendar_id: calendarId, event_id: eventId });
async function fixture() {
  const h = await createCloudHarness(), c = await selectedCalendar(h);
  async function download(items: unknown[] = [calendarEvent()]) {
    const run = await h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, { ...c.body, operation_id: crypto.randomUUID() });
    await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, run.id, async () => Response.json({ items }));
  }
  await download();
  const preview = () => h.eventLinks.eventLinkPreview(h.db, actor, c.connection.id, query());
  async function body(contactIds: number[] = [], planIds: number[] = []) {
    const p = await preview(); return { operation_id: crypto.randomUUID(), expected_epoch: p.epoch, expected_authorization_revision: p.authorization_revision, expected_selection_revision: p.selection_revision,
      expected_generation: p.generation, calendar_id: calendarId, event_id: 'meeting1', expected_event_revision: p.saved?.revision ?? null, contact_ids: contactIds, plan_ids: planIds };
  }
  const save = async (value?: Awaited<ReturnType<typeof body>>) => h.eventLinks.linkCalendarEvent(h.db, actor, c.connection.id, value ?? await body());
  const person = async (name = 'Ana', email = 'ana@example.test') => (await h.call('contacts', { method: 'POST', body: { name, email, notes: 'Private relationship notes' } })).body.contact;
  const detail = (id: string) => h.eventLinks.savedCalendarEvents(h.db, actor, new URLSearchParams(), id);
  return { h, c, download, preview, body, save, person, detail };
}
async function count(h: Harness, table: string) { return (await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{ n: number }>())!.n; }
async function publish(h: Harness) {
  let capture = await h.beginCapture();
  for (let i = 0; capture.state === 'capturing' && i < 100; i++) capture = await h.advanceCapture(capture.id);
  for (let i = 0; capture.state === 'awaiting_verification' && i < 100; i++) capture = await h.advanceCaptureVerification(capture.id);
  assert.equal(capture.state, 'manifest_ready', JSON.stringify(capture)); return capture;
}
async function restore(h: Harness, id: string) {
  let job = await h.beginRestorePreparation(id);
  for (let i = 0; job.state === 'preparing' && i < 100; i++) job = await h.advanceRestorePreparation(job.id);
  assert.equal(job.state, 'ready'); job = await h.beginRestoreApply(job.id);
  for (let i = 0; job.state === 'deleting' && i < 100; i++) job = await h.advanceRestoreDeletion(job.id);
  for (let i = 0; ['awaiting_write', 'writing'].includes(job.state) && i < 100; i++) job = await h.advanceRestoreWriting(job.id);
  for (let i = 0; job.state === 'repairing_dates' && i < 100; i++) job = await h.advanceRestoreDateRepair(job.id);
  for (let i = 0; job.state === 'verifying' && i < 100; i++) job = await h.advanceRestoreVerification(job.id);
  assert.equal(job.state, 'completed', JSON.stringify(job));
}
test('Source-first context can later link to existing people and plans without editing private notes, plan dates or history', async () => {
  const f = await fixture(); try {
    const orphan = await f.save(); assert.deepEqual(orphan.event!.people, []); assert.equal(await count(f.h, 'contacts'), 0);
    const person = await f.person(), plan = (await f.h.call('plans', { method: 'POST', body: { contact_id: person.id, type: 'meetup', summary: 'My own plan', notes: 'My plan notes', planned_date: '2026-11-03' } })).body.plan;
    const before = await f.h.db.prepare('SELECT * FROM plans WHERE id = ?').bind(plan.id).first();
    const result = await f.save(await f.body([person.id], [plan.id])); assert.equal(result.event!.public_id, orphan.event!.public_id); assert.equal(await count(f.h, 'calendar_events'), 1);
    assert.deepEqual(result.event!.people, [{ id: person.id, name: person.name }]); assert.equal(result.event!.plans[0].id, plan.id); assert.deepEqual(await f.h.db.prepare('SELECT * FROM plans WHERE id = ?').bind(plan.id).first(), before);
    assert.equal((await f.h.call('contacts/' + person.id)).body.contact.notes, 'Private relationship notes'); assert.equal(await count(f.h, 'interactions'), 0);
    const list = await f.h.eventLinks.savedCalendarEvents(f.h.db, actor, new URLSearchParams({ contact_id: String(person.id) })); assert.equal(list.events!.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /calendar-refresh|calendar-access|description|attachments|do-not-save/);
  } finally { await f.h.close(); }
});
test('Participant matching proposes ambiguous email candidates, ignores own identities/resources and supports bounded directory search', async () => {
  const f = await fixture(); try {
    for (let i = 0; i < 7; i++) await f.person('Shared address ' + i);
    const owner = await f.person('Owner', 'owner@example.test');
    await f.download([{ ...calendarEvent(), attendees: [{ email: 'ana@example.test' }, { email: 'owner@example.test' }, { email: 'room@example.test', resource: true }, { email: 'self@example.test', self: true }, { email: 'missing@example.test' }] }]);
    const p = await f.preview(); assert.equal(p.saved, null); assert.deepEqual(p.matches.map((m) => m.address), ['ana@example.test', 'missing@example.test']); assert.equal(p.matches[0].candidates.length, 5); assert.equal(p.matches[0].more, true);
    const q = query(); q.set('search', 'Owner'); const result = await f.h.eventLinks.eventLinkPreview(f.h.db, actor, f.c.connection.id, q); assert.deepEqual(result.contacts.map((p) => p.id), [owner.id]);
    q.set('contacts_after', 'bad'); await assert.rejects(f.h.eventLinks.eventLinkPreview(f.h.db, actor, f.c.connection.id, q));
    const accepted = await f.save(); assert.deepEqual(accepted.event!.people, []);
  } finally { await f.h.close(); }
});
test('Receipts serialize uncertain and concurrent saves; stale generations, epochs and graph targets cannot commit', async () => {
  const f = await fixture(); try {
    const p = await f.person(), body = await f.body([p.id]); const [one, two] = await Promise.all([f.save(body), f.save(body)]);
    assert.equal(one.event!.public_id, two.event!.public_id); assert.equal(await count(f.h, 'calendar_events'), 1); assert.equal(await count(f.h, 'calendar_event_people'), 1);
    await assert.rejects(f.save({ ...body, contact_ids: [] }), /different event choices/);
    const next = await f.body([]), raced = await Promise.allSettled([f.save(next), f.save({ ...next, operation_id: crypto.randomUUID() })]); assert.deepEqual(raced.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const stale = await f.body(); await f.download([{ ...calendarEvent(), summary: 'Changed source' }]); await assert.rejects(f.save(stale), /changed/);
    const other = (await f.h.call('contacts', { method: 'POST', workspace: 'other', body: { name: 'Other' } })).body.contact;
    await assert.rejects(f.save(await f.body([other.id]))); await assert.rejects(f.save(await f.body(Array.from({ length: 21 }, (_, i) => i + 1))));
    const before = await count(f.h, 'mutation_receipts'); const wrong = await f.body(); wrong.expected_epoch = crypto.randomUUID(); await assert.rejects(f.save(wrong)); assert.equal(await count(f.h, 'mutation_receipts'), before);
    await f.h.db.prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = 'test'").run(); await assert.rejects(f.detail(one.event!.public_id));
  } finally { await f.h.close(); }
});
test('Retained links can be edited after disconnect, and a plan cannot silently be reassigned to another event', async () => {
  const f = await fixture(); try {
    const p = await f.person(), plan = (await f.h.call('plans', { method: 'POST', body: { contact_id: p.id, type: 'meetup', planned_date: '2026-10-04' } })).body.plan;
    const saved = (await f.save(await f.body([], [plan.id]))).event!;
    const sourceBody = await f.body(); await f.download([calendarEvent(), calendarEvent('another')]); const q = query('another'), preview = await f.h.eventLinks.eventLinkPreview(f.h.db, actor, f.c.connection.id, q);
    await assert.rejects(f.save({ ...sourceBody, operation_id: crypto.randomUUID(), event_id: 'another', expected_generation: preview.generation, expected_event_revision: null, plan_ids: [plan.id] }));
    await f.h.providers.disconnectGoogleConnection(f.h.db, actor, environment, f.c.connection.id, f.c.connection.revision, async () => new Response(null, { status: 200 }));
    const detail = await f.detail(saved.public_id); assert.equal(detail.event!.source_status, 'review_required'); assert.ok(detail.contacts!.some((v) => v.id === p.id));
    const edit = { operation_id: crypto.randomUUID(), expected_epoch: detail.epoch, expected_revision: detail.event!.revision, contact_ids: [p.id], plan_ids: [] };
    const changed = await f.h.eventLinks.editSavedCalendarEvent(f.h.db, actor, saved.public_id, edit); assert.equal(changed.event!.people[0].id, p.id); assert.deepEqual(changed.event!.plans, []);
    assert.equal((await f.h.eventLinks.editSavedCalendarEvent(f.h.db, actor, saved.public_id, edit)).event!.revision, changed.event!.revision);
    await assert.rejects(f.h.eventLinks.editSavedCalendarEvent(f.h.db, actor, saved.public_id, { ...edit, operation_id: crypto.randomUUID() })); assert.equal(await count(f.h, 'plans'), 1);
  } finally { await f.h.close(); }
});
test('Only complete source generations refresh saved facts; privacy changes and cancellations preserve links, absence is not cancellation', async () => {
  const f = await fixture(); try {
    const p = await f.person(), saved = (await f.save(await f.body([p.id]))).event!;
    const run = await f.h.eventDownloads.startEventDownload(f.h.db, actor, environment, f.c.connection.id, { ...f.c.body, operation_id: crypto.randomUUID() });
    await f.h.eventDownloads.advanceEventDownload(f.h.db, actor, environment, f.c.connection.id, run.id, async () => Response.json({ items: [{ ...calendarEvent(), visibility: 'private', summary: 'Secret' }], nextPageToken: 'next' }));
    assert.equal((await f.detail(saved.public_id)).event!.facts.title, 'Lunch with Ana');
    await f.h.eventDownloads.advanceEventDownload(f.h.db, actor, environment, f.c.connection.id, run.id, async () => Response.json({ items: [] }));
    const busy = (await f.detail(saved.public_id)).event!; assert.equal(busy.facts.title, 'Busy'); assert.equal(busy.people[0].id, p.id); assert.doesNotMatch(JSON.stringify(busy.facts), /Secret|ana@example/);
    await f.download([{ id: 'meeting1', status: 'cancelled' }]); assert.equal((await f.detail(saved.public_id)).event!.facts.status, 'cancelled');
    await f.download(); await f.download([]); const absent = (await f.detail(saved.public_id)).event!; assert.equal(absent.source_status, 'unavailable'); assert.equal(absent.facts.status, 'confirmed'); assert.equal(absent.people.length, 1);
    await f.download(); assert.equal((await f.detail(saved.public_id)).event!.source_status, 'available');
  } finally { await f.h.close(); }
});
test('Merging people collapses duplicate associations and follows existing plan ownership without duplicating an event', async () => {
  const f = await fixture(); try {
    const a = await f.person('Ana A'), b = await f.person('Ana B'), plan = (await f.h.call('plans', { method: 'POST', body: { contact_id: b.id, type: 'meetup', planned_date: '2026-10-05' } })).body.plan;
    const saved = (await f.save(await f.body([a.id, b.id], [plan.id]))).event!;
    const review = await f.h.call('contacts/duplicates'), merge = await f.h.call('contacts/duplicates', { method: 'POST', body: { primaryId: a.id, duplicateIds: [b.id], expectedRevision: review.body.revision } });
    assert.equal(merge.status, 200, JSON.stringify(merge.body)); const result = (await f.detail(saved.public_id)).event!; assert.deepEqual(result.people.map((p) => p.id), [a.id]); assert.equal(result.plans[0].contact_id, a.id); assert.equal(await count(f.h, 'calendar_events'), 1);
  } finally { await f.h.close(); }
});
test('Schema 14 interactive recovery includes orphan and linked events, validates their graph and reads schema 13 with empty event tables', async () => {
  const f = await fixture(); try {
    const p = await f.person(), saved = (await f.save(await f.body([p.id]))).event!, backup = (await f.h.call('settings/backups', { method: 'POST' })).body.backup;
    assert.equal(backup.schemaVersion, 'cloud-14'); const snapshot = (await f.h.call('settings/backups/' + backup.filename)).body; assert.equal(snapshot.version, 14); assert.equal(snapshot.tables.calendar_events.length, 1); assert.equal(snapshot.tables.calendar_event_people.length, 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /calendar-refresh|provider_event_index|active_generation/);
    for (const mutate of [(s: typeof snapshot) => { s.tables.calendar_event_people[0].event_id = 999; }, (s: typeof snapshot) => { const facts = JSON.parse(s.tables.calendar_events[0].facts); facts.redacted = true; s.tables.calendar_events[0].facts = JSON.stringify(facts); }]) {
      const invalid = structuredClone(snapshot); mutate(invalid); assert.throws(() => f.h.validateCloudSnapshot(invalid, 'test'));
    }
    await f.h.db.prepare("DELETE FROM calendar_events WHERE workspace_id = 'test'").run(); const result = await f.h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } }); assert.equal(result.status, 200, JSON.stringify(result.body));
    const restored = (await f.detail(saved.public_id)).event!; assert.equal(restored.revision, saved.revision); assert.equal(restored.people.length, 1); assert.equal(restored.source_status, 'review_required');
    const old = structuredClone(snapshot); old.version = 13; for (const key of ['calendar_events', 'calendar_event_people', 'calendar_event_plans']) delete old.tables[key];
    assert.deepEqual(f.h.validateCloudSnapshot(old, 'test').tables.calendar_events, []);
    assert.equal((await f.h.call('settings/restore', { method: 'POST', body: old, headers: { 'X-Bonds-Restore-Confirmation': 'RESTORE' } })).status, 200); assert.equal(await count(f.h, 'calendar_events'), 0);
  } finally { await f.h.close(); }
});
test('Resumable capture and restore round-trip linked event context, detect edits during capture and erase canonical rows', async () => {
  const f = await fixture(); try {
    const p = await f.person(), plan = (await f.h.call('plans', { method: 'POST', body: { contact_id: p.id, type: 'call', planned_date: '2026-10-05' } })).body.plan;
    const saved = (await f.save(await f.body([p.id], [plan.id]))).event!, capture = await publish(f.h);
    const root = JSON.parse(await (await f.h.assets.get(`test/recovery-jobs/${capture.id}/manifest-${capture.manifest_sha256}.json`))!.text()); assert.equal(root.snapshotSchemaVersion, 14); assert.equal(root.rowCounts.calendar_events, 1);
    await f.h.db.prepare("DELETE FROM calendar_events WHERE workspace_id = 'test'").run(); await restore(f.h, capture.id); assert.equal((await f.detail(saved.public_id)).event!.plans[0].id, plan.id);
    const stale = await f.h.beginCapture(), current = await f.detail(saved.public_id); await f.h.eventLinks.editSavedCalendarEvent(f.h.db, actor, saved.public_id, { operation_id: crypto.randomUUID(), expected_epoch: current.epoch, expected_revision: current.event!.revision, contact_ids: [], plan_ids: [] });
    await assert.rejects(f.h.advanceCapture(stale.id), /Workspace changed/);
    const erased = await f.h.call('settings/erase', { method: 'POST', body: { confirmation: WORKSPACE_ERASURE_CONFIRMATION } }); assert.equal(erased.status, 200, JSON.stringify(erased.body)); assert.equal(await count(f.h, 'calendar_events'), 0); assert.equal(await count(f.h, 'calendar_event_people'), 0);
  } finally { await f.h.close(); }
});
test('Saved-context removal requires a verified recovery point; uncertain retries never delete a re-saved source or its relationships', async () => {
  const f = await fixture(); try {
    const p = await f.person(), saved = (await f.save(await f.body([p.id]))).event!, body = { operation_id: crypto.randomUUID(), expected_epoch: f.c.epoch, expected_revision: saved.revision };
    f.h.faults.failGet = true; await assert.rejects(f.h.eventLinks.removeSavedCalendarEvent(f.h.db, actor, saved.public_id, body)); assert.equal(await count(f.h, 'calendar_events'), 1); f.h.faults.failGet = false;
    const removed = await f.h.eventLinks.removeSavedCalendarEvent(f.h.db, actor, saved.public_id, body); assert.equal(removed.removed, true); assert.equal(await count(f.h, 'calendar_events'), 0); assert.equal(await count(f.h, 'contacts'), 1);
    const again = (await f.save()).event!; assert.notEqual(again.public_id, saved.public_id); assert.equal((await f.h.eventLinks.removeSavedCalendarEvent(f.h.db, actor, saved.public_id, body)).replayed, true); assert.equal(await count(f.h, 'calendar_events'), 1);
    assert.equal(await count(f.h, 'provider_event_index'), 1); assert.equal(await count(f.h, 'cloud_backup_pins'), 0);
  } finally { await f.h.close(); }
});
test('HTTP routes enforce owner, origin, strict identities and uncached projections; strict event readers reject unsafe facts', async () => {
  const f = await fixture(); try {
    const saved = (await f.save()).event!, path = 'calendar/events/' + saved.public_id;
    assert.equal((await f.h.call(path)).headers.get('Cache-Control'), 'no-store');
    const body = { operation_id: crypto.randomUUID(), expected_epoch: f.c.epoch, expected_revision: saved.revision, contact_ids: [], plan_ids: [] };
    assert.equal((await f.h.call(path, { method: 'PATCH', body, headers: { Origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await f.h.call(path + '/unexpected')).status, 404);
    assert.equal((await f.h.call(path, { method: 'PATCH', body, headers: { Origin: environment.BETTER_AUTH_URL } })).status, 200);
    const latest = await f.detail(saved.public_id); f.h.faults.failPut = true;
    const outage = await f.h.call(path, { method: 'DELETE', body: { operation_id: crypto.randomUUID(), expected_epoch: latest.epoch, expected_revision: latest.event!.revision }, headers: { Origin: environment.BETTER_AUTH_URL } });
    assert.equal(outage.status, 500); assert.equal(outage.headers.get('Cache-Control'), 'no-store'); assert.equal(await count(f.h, 'calendar_events'), 1); f.h.faults.failPut = false;

    for (const p of ['/api/calendar/events', '/api/calendar/events/' + saved.public_id, `/api/connections/${f.c.connection.id}/calendars/events/link`, `/api/connections/${f.c.connection.id}/calendars/events/link-preview`]) assert.ok(getCloudApiRewrite(p));
    for (const p of ['/api/calendar/events/7', '/api/calendar/events/' + saved.public_id + '/extra', `/api/connections/${f.c.connection.id}/calendars/events/link/extra`]) assert.equal(getCloudApiRewrite(p), null);
    const facts = saved.facts; assert.deepEqual(f.h.calendarFacts.readCalendarEventFacts(facts), facts);
    for (const invalid of [{ ...facts, visibility: ['private'] }, { ...facts, status: ['confirmed'] }, { ...facts, attendees: [{ ...facts.attendees[0], response: ['accepted'] }] }, { ...facts, google_url: 'javascript:alert(1)' }, { ...facts, description: 'secret' }, { ...facts, redacted: true }, { ...facts, start: { ...facts.start!, instant: '2026-10-05T11:00:00Z' } }, { ...facts, start: { ...facts.start!, date_time: '2026-10-04T12:00:00.100+01:00', instant: '2026-10-04T11:00:00.100Z' }, end: { ...facts.end!, date_time: '2026-10-04T12:00:00+01:00', instant: '2026-10-04T11:00:00Z' } }]) assert.throws(() => f.h.calendarFacts.readCalendarEventFacts(invalid));
  } finally { await f.h.close(); }
});

test('Genuine schema-13 private artifacts retain their original part chain and restore empty canonical event tables', async () => {
  const f = await fixture(); try {
    await f.person(); const capture = await publish(f.h), prefix = `test/recovery-jobs/${capture.id}`;
    const root = JSON.parse(await (await f.h.assets.get(`${prefix}/manifest-${capture.manifest_sha256}.json`))!.text()), chain = root.partsChainSha256;
    root.snapshotSchemaVersion = 13; root.tableOrder = root.tableOrder.filter((table: string) => !table.startsWith('calendar_event'));
    for (const table of ['calendar_events', 'calendar_event_people', 'calendar_event_plans']) delete root.rowCounts[table];
    const bytes = new TextEncoder().encode(JSON.stringify(root));
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((b) => b.toString(16).padStart(2, '0')).join('');
    await f.h.assets.put(`${prefix}/manifest-${hash}.json`, bytes, { customMetadata: { workspaceId: 'test', jobId: capture.id, sha256: hash } });
    await f.h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET manifest_sha256 = ?, manifest_bytes = ? WHERE id = ?').bind(hash, bytes.byteLength, capture.id).run();
    let reader = await f.h.beginSnapshotRead(capture.id);
    for (let i = 0; reader.state === 'reading' && i < 100; i++) reader = await f.h.advanceSnapshotRead(reader.id);
    assert.equal(reader.state, 'verified', JSON.stringify(reader)); assert.equal(reader.part_chain, chain); assert.equal(JSON.parse(reader.row_counts).calendar_events, 0);
    await f.save(); assert.equal(await count(f.h, 'calendar_events'), 1); await restore(f.h, capture.id); assert.equal(await count(f.h, 'calendar_events'), 0); assert.equal(await count(f.h, 'contacts'), 1);
  } finally { await f.h.close(); }
});
