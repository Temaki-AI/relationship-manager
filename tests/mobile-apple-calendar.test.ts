import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import { DEVICE_TOKEN_PREFIX, readNativeAccount } from '../packages/domain/src/devices.ts';
import { appleCalendarDraft, appleCalendarDay, appleCalendarUrl, readAppleCalendarFacts, type AppleCalendarFacts } from '../packages/domain/src/apple-calendar.ts';
import type { AppleCalendarAdapter } from '../apps/mobile/src/data/apple-calendar.ts';
import * as schema from '../apps/mobile/src/data/schema.ts';

const account = readNativeAccount({ deviceId: crypto.randomUUID(), userId: 'owner', workspaceId: 'personal', email: 'owner@example.test', name: 'Owner', origin: 'https://everclosecrm.com', expiresAt: '2030-01-01T00:00:00.000Z', token: DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url') });
const draft = { title: 'Coffee', location: 'Cafe', start: { date: '2026-10-05', date_time: null, time_zone: null }, end: { date: '2026-10-06', date_time: null, time_zone: null } };
async function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'everclose-apple-')), filename = path.join(folder, 'phone.sqlite');
  let phone = await createMobileHarness(account, new Database(filename));
  const epoch = crypto.randomUUID(), now = new Date().toISOString();
  for (const key of ['sync-cursor-v4', 'sync-cursor-v3']) await phone.db.runAsync('INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)', key, JSON.stringify({ epoch, sequence: 1 }), now);
  const person = await phone.contacts.createContact(phone.db, { name: 'Ana', email: 'ana@example.test', phone: '', notes: 'PRIVATE PERSON', contactFrequency: 14 });
  const planId = await phone.context.createContext(phone.db, 'plan', person.id, { type: 'meetup', planned_date: '2026-10-05', summary: 'Private coffee summary', notes: 'PRIVATE PLAN' });
  await phone.db.runAsync('DELETE FROM sync_queue');
  const facts = new Map<string, AppleCalendarFacts>(), effects: Array<ReturnType<typeof appleCalendarDraft>['event'] & { url: string }> = [];
  let creates = 0, edits = 0, prompts = 0, full = true;
  const adapter: AppleCalendarAdapter = {
    async prepareEditor() {},
    async create(event) {
      creates++; effects.push(event); const id = 'apple-event-1';
      facts.set(id, { id, calendar_id: 'calendar-1', title: event.title, start: event.startDate, end: event.endDate, all_day: event.allDay, time_zone: event.timeZone, url: event.url, recurring: false, cancelled: false });
      return { action: 'saved', id };
    },
    async permission(request) { if (request) prompts++; return full; },
    async get(id) { return facts.get(id) ?? null; },
    async calendars() { return [{ id: 'calendar-1', title: 'Personal' }]; },
    async find(calendarId, start, end, url) { return [...facts.values()].filter((f) => f.calendar_id === calendarId && f.url === url && Date.parse(f.start) >= Date.parse(start) && Date.parse(f.start) < Date.parse(end)); },
    async edit(id) { edits++; return { action: 'saved', id }; },
  };
  const review = () => phone.appleCalendar.appleCalendarReview(phone.db, planId);
  async function prepare(operationId = crypto.randomUUID()) { const r = await review(); return phone.appleCalendar.prepareAppleCalendar(phone.db, account, planId, { operationId, epoch: r.epoch, planFingerprint: r.planFingerprint, draft }); }
  async function open() { const r = (await review()).receipt!; return phone.appleCalendar.openAppleCalendarEditor(phone.db, account, r.id, r.revision, adapter); }
  async function verify(follow = false, reads = false, candidate?: AppleCalendarFacts) {
    const r = await review(); return phone.appleCalendar.verifyAppleCalendar(phone.db, account, r.receipt!.id, { revision: r.receipt!.revision, epoch: r.epoch, planFingerprint: r.planFingerprint, follow, reads }, adapter, () => true, candidate);
  }
  async function due() { await phone.db.runAsync("UPDATE apple_calendar_receipts SET last_read_at = '2000-01-01T00:00:00.000Z'"); }
  return { account, adapter, epoch, planId, person, facts, effects, review, prepare, open, verify, due,
    get phone() { return phone; }, get creates() { return creates; }, get edits() { return edits; }, get prompts() { return prompts; },
    permit: (value: boolean) => { full = value; },
    restart: async () => { phone.close(); phone = await createMobileHarness(account, new Database(filename)); },
    close: () => { phone.close(); rmSync(folder, { recursive: true, force: true }); } };
}

test('Apple Calendar drafts validate civil dates, DST gaps/folds and strip private source fields', () => {
  const event = appleCalendarDraft(draft).event;
  assert.equal(event.timeZone, 'UTC'); assert.equal(event.startDate, '2026-10-05T00:00:00.000Z'); assert.equal(event.allDay, true);
  assert.throws(() => appleCalendarDraft({ ...draft, notes: 'private' }), /fields/);
  assert.throws(() => appleCalendarDraft({ ...draft, start: { ...draft.start, date: '2026-02-30' } }), /valid/);
  const timed = (start: string, end: string) => ({ ...draft, start: { date: null, date_time: start, time_zone: 'Europe/Lisbon' }, end: { date: null, date_time: end, time_zone: 'Europe/Lisbon' } });
  assert.throws(() => appleCalendarDraft(timed('2026-03-29T01:30:00', '2026-03-29T03:00:00')), /does not exist/);
  assert.throws(() => appleCalendarDraft(timed('2026-10-25T01:30:00', '2026-10-25T03:00:00')), /occurs twice/);
  assert.equal(appleCalendarDraft(timed('2026-10-25T01:30:00+01:00', '2026-10-25T03:00:00+00:00')).event.startDate, '2026-10-25T00:30:00.000Z');
  const facts = { id: 'x', calendar_id: 'cal', title: 'Meeting', start: '2026-10-05T00:30:00.000Z', end: '2026-10-05T01:30:00.000Z', time_zone: 'America/Los_Angeles', all_day: false, url: null, recurring: false, cancelled: false };
  assert.equal(appleCalendarDay(readAppleCalendarFacts(facts)), '2026-10-04');
  assert.ok(!('notes' in readAppleCalendarFacts({ ...facts, notes: 'private provider notes', attendees: ['private'] })));
  assert.throws(() => readAppleCalendarFacts({ ...facts, start: '2026-02-30T00:00:00Z' }), /times/);
  assert.throws(() => readAppleCalendarFacts({ ...facts, time_zone: 'UNKNOWN ZONE' }), /timezone/);
  assert.throws(() => appleCalendarUrl('invalid', crypto.randomUUID()));
});

test('Apple Calendar persists its frozen receipt before the editor and keeps notes, history and permission choices private', async () => {
  const f = await fixture(); try {
    const prepared = await f.prepare(), replay = await f.prepare(prepared.id); assert.equal(replay.id, prepared.id); assert.equal(f.creates, 0);
    const create = f.adapter.create;
    f.adapter.create = async (event) => { const r = (await f.review()).receipt!; assert.equal(r.attempted, 1); assert.equal(r.status, 'unknown'); return create(event); };
    const saved = await f.open(); assert.equal(saved.status, 'saved'); assert.equal(saved.read_enabled, 0); assert.equal(f.prompts, 0); assert.equal(f.effects.length, 1);
    assert.deepEqual(Object.keys(f.effects[0]).sort(), ['allDay', 'endDate', 'location', 'startDate', 'timeZone', 'title', 'url']);
    assert.ok(!JSON.stringify(f.effects[0]).includes('PRIVATE')); assert.ok(!saved.request_json.includes('PRIVATE'));
    assert.equal(f.effects[0].url, appleCalendarUrl(f.planId, prepared.id));
    await f.restart(); await assert.rejects(f.open(), /already attempted/); assert.equal(f.creates, 1);
    const verified = await f.verify(); assert.equal(verified.status, 'verified'); assert.equal(verified.follow_date, 0); assert.equal(verified.read_enabled, 0);
    assert.equal((await f.review()).plan!.notes, 'PRIVATE PLAN'); assert.equal((await f.phone.contacts.getContact(f.phone.db, f.person.id))!.notes, 'PRIVATE PERSON');
    assert.equal((await f.phone.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) n FROM interactions'))!.n, 0);
  } finally { f.close(); }
});

test('A lost create reply cannot be retried or discarded; original-marker discovery rereads the candidate before binding', async () => {
  const f = await fixture(); try {
    await f.prepare(); const create = f.adapter.create;
    f.adapter.create = async (event) => { await create(event); throw new Error('lost native reply with private metadata'); };
    await assert.rejects(f.open(), /reply is unconfirmed/); await f.restart();
    const r = (await f.review()).receipt!; assert.equal(r.status, 'unknown'); assert.equal(r.event_id, null); assert.equal(r.attempted, 1);
    await assert.rejects(f.phone.appleCalendar.discardAppleCalendar(f.phone.db, account, r.id, r.revision), /may have reached/);
    await assert.rejects(f.open(), /already attempted/); assert.equal(f.creates, 1);
    const candidate = await f.phone.appleCalendar.findAppleCalendar(f.phone.db, account, r.id, 'calendar-1', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', f.adapter);
    f.facts.set(candidate.id, { ...candidate, url: 'bonds://unrelated' });
    await assert.rejects(f.verify(false, false, candidate), /marker/); assert.equal((await f.review()).receipt!.event_id, null);
    f.facts.set(candidate.id, candidate); assert.equal((await f.verify(false, false, candidate)).event_id, candidate.id); assert.equal(f.creates, 1);
  } finally { f.close(); }
});

test('Ambiguous or absent original-marker searches and missing events never enable another creation', async () => {
  const f = await fixture(); try {
    await f.prepare(); await f.open(); const r = (await f.review()).receipt!, original = f.facts.get(r.event_id!)!;
    f.facts.set('duplicate', { ...original, id: 'duplicate' });
    await assert.rejects(f.phone.appleCalendar.findAppleCalendar(f.phone.db, account, r.id, 'calendar-1', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', f.adapter), /Several/);
    f.facts.clear(); await assert.rejects(f.verify(), /not found/); await assert.rejects(f.prepare(), /original Calendar receipt/);
    assert.equal((await f.review()).receipt!.attempted, 1); assert.equal(f.creates, 1);
  } finally { f.close(); }
});

test('Cancellation permits a fresh review; unopened discard is local and attempted/frozen receipt fields are guarded in SQLite', async () => {
  const f = await fixture(); try {
    const original = await f.prepare(); await f.phone.appleCalendar.discardAppleCalendar(f.phone.db, account, original.id, original.revision);
    assert.equal(f.creates, 0); await f.prepare(); f.adapter.create = async () => ({ action: 'canceled', id: null });
    assert.equal((await f.open()).status, 'cancelled'); const next = await f.prepare(); assert.notEqual(next.id, original.id);
    const create = async (event: Parameters<AppleCalendarAdapter['create']>[0]) => { const id = 'new'; f.facts.set(id, { id, calendar_id: 'calendar-1', title: event.title, start: event.startDate, end: event.endDate, all_day: true, time_zone: 'UTC', url: event.url, recurring: false, cancelled: false }); return { action: 'saved', id }; };
    f.adapter.create = create; await f.open();
    for (const sql of ["UPDATE apple_calendar_receipts SET attempted = 0 WHERE id = ?", "UPDATE apple_calendar_receipts SET request_json = '{}' WHERE id = ?", "UPDATE apple_calendar_receipts SET status = 'discarded' WHERE id = ?", "UPDATE apple_calendar_receipts SET epoch = 'other' WHERE id = ?"]) await assert.rejects(f.phone.db.runAsync(sql, next.id));
    assert.equal((await f.review()).receipt!.attempted, 1);
  } finally { f.close(); }
});

test('Permission denial and a stale plan after a permission prompt leave the editor unopened', async () => {
  const f = await fixture(); try {
    const r = await f.prepare(); f.adapter.prepareEditor = async () => { throw new Error('Calendar permission denied'); };
    await assert.rejects(f.open(), /denied/); assert.equal((await f.review()).receipt!.attempted, 0); assert.equal(f.creates, 0);
    f.adapter.prepareEditor = async () => { const plan = (await f.review()).plan!; await f.phone.context.updateContext(f.phone.db, 'plan', plan, { ...plan, notes: 'Corrected PRIVATE note' }); };
    await assert.rejects(f.open(), /changed/); assert.equal((await f.review()).receipt!.attempted, 0); assert.equal(f.creates, 0);
    await f.phone.appleCalendar.discardAppleCalendar(f.phone.db, account, r.id, r.revision); await f.prepare();
    f.adapter.prepareEditor = async () => {}; await f.open(); f.permit(false); await assert.rejects(f.verify(true, true), /not allowed/); assert.equal((await f.review()).receipt!.facts, null);
  } finally { f.close(); }
});

test('A late editor acknowledgement stays in its original account and cannot apply CRM changes after an account switch', async () => {
  const f = await fixture(); try {
    const r = await f.prepare(); let current = true; const create = f.adapter.create;
    f.adapter.create = async (event) => { const result = await create(event); current = false; return result; };
    const held = await f.phone.appleCalendar.openAppleCalendarEditor(f.phone.db, account, r.id, r.revision, f.adapter, () => current);
    assert.equal(held.status, 'held'); assert.equal(held.event_id, 'apple-event-1'); assert.equal(held.read_enabled, 0);
    await assert.rejects(f.phone.appleCalendar.verifyAppleCalendar(f.phone.db, account, r.id, { revision: held.revision, epoch: f.epoch, planFingerprint: (await f.review()).planFingerprint, reads: true, follow: true }, f.adapter, () => current), /active account changed/);
    assert.equal((await f.review()).plan!.planned_date, '2026-10-05'); assert.equal(f.creates, 1);
  } finally { f.close(); }
});

test('An account switch during full-access permission review prevents verify, find and edit from reading the old event', async () => {
  for (const action of ['verify', 'find', 'edit']) {
    const f = await fixture(); try {
      await f.prepare(); await f.open(); await f.verify(); const r = await f.review(); let current = true, reads = 0;
      f.adapter.permission = async () => { current = false; return true; }; f.adapter.get = async () => { reads++; return null; }; f.adapter.find = async () => { reads++; return []; };
      const proof = { revision: r.receipt!.revision, epoch: r.epoch, planFingerprint: r.planFingerprint };
      const operation = action === 'verify'
        ? f.phone.appleCalendar.verifyAppleCalendar(f.phone.db, account, r.receipt!.id, { ...proof, follow: true, reads: true }, f.adapter, () => current)
        : action === 'find'
          ? f.phone.appleCalendar.findAppleCalendar(f.phone.db, account, r.receipt!.id, 'calendar-1', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', f.adapter, () => current)
          : f.phone.appleCalendar.editAppleCalendar(f.phone.db, account, r.receipt!.id, proof, f.adapter, () => current);
      await assert.rejects(operation, /active account changed/); assert.equal(reads, 0); assert.equal(f.edits, 0); assert.equal((await f.review()).receipt!.revision, r.receipt!.revision);
    } finally { f.close(); }
  }
});

test('Following an explicitly verified date changes only that date, publishes an original-base outbox patch, and respects the read cadence', async () => {
  const f = await fixture(); try {
    await f.prepare(); await f.open(); const original = f.facts.get('apple-event-1')!;
    f.facts.set(original.id, { ...original, start: '2026-10-05T23:30:00Z', end: '2026-10-06T00:30:00Z', all_day: false, time_zone: 'Europe/Lisbon' });
    const verified = await f.verify(true, true); assert.equal(verified.last_plan_date, '2026-10-06'); assert.equal(verified.read_enabled, 1);
    const patch = await f.phone.db.getFirstAsync<{ payload: string; base_payload: string }>("SELECT payload, base_payload FROM sync_queue WHERE entity_type = 'plan'");
    assert.deepEqual(JSON.parse(patch!.payload), { planned_date: '2026-10-06' }); assert.deepEqual(JSON.parse(patch!.base_payload), { planned_date: '2026-10-05' });
    f.facts.set(original.id, { ...original, start: '2026-10-09T00:00:00Z', end: '2026-10-10T00:00:00Z' });
    assert.equal((await f.phone.appleCalendar.refreshAppleCalendarReads(f.phone.db, account, f.adapter)).changed, 0);
    await f.due(); assert.equal((await f.phone.appleCalendar.refreshAppleCalendarReads(f.phone.db, account, f.adapter)).changed, 1);
    assert.equal((await f.review()).plan!.planned_date, '2026-10-09'); assert.equal((await f.review()).plan!.completed_at, null); assert.equal((await f.review()).plan!.notes, 'PRIVATE PLAN');
    assert.equal((await f.phone.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) n FROM interactions'))!.n, 0);
  } finally { f.close(); }
});

test('Manual plan-date corrections pause date following until another explicit review, including a correction changed back before a read', async () => {
  const f = await fixture(); try {
    await f.prepare(); await f.open(); await f.verify(true, true);
    const plan = (await f.review()).plan!; await f.phone.context.updateContext(f.phone.db, 'plan', plan, { ...plan, planned_date: '2026-10-20' });
    assert.equal((await f.review()).receipt!.follow_date, 0);
    const facts = f.facts.get('apple-event-1')!; f.facts.set(facts.id, { ...facts, start: '2026-10-09T00:00:00Z', end: '2026-10-10T00:00:00Z' });
    await f.due(); await f.phone.appleCalendar.refreshAppleCalendarReads(f.phone.db, account, f.adapter);
    assert.equal((await f.review()).plan!.planned_date, '2026-10-20'); assert.equal((await f.review()).receipt!.follow_date, 0); assert.equal((await f.review()).receipt!.read_enabled, 1);
    await f.restart(); await f.due(); await f.phone.appleCalendar.refreshAppleCalendarReads(f.phone.db, account, f.adapter); assert.equal((await f.review()).plan!.planned_date, '2026-10-20');
    await f.verify(true, true);
    const current = (await f.review()).plan!;
    await f.phone.context.updateContext(f.phone.db, 'plan', current, { ...current, planned_date: '2026-10-21' });
    const corrected = (await f.review()).plan!; await f.phone.context.updateContext(f.phone.db, 'plan', corrected, { ...corrected, planned_date: current.planned_date });
    f.facts.set(facts.id, { ...facts, start: '2026-10-25T00:00:00Z', end: '2026-10-26T00:00:00Z' });
    await f.due(); await f.phone.appleCalendar.refreshAppleCalendarReads(f.phone.db, account, f.adapter);
    assert.equal((await f.review()).receipt!.follow_date, 0); assert.equal((await f.review()).plan!.planned_date, current.planned_date);
  } finally { f.close(); }
});

test('Completion, permission loss, cancellation, recurrence and moved source identities suspend reads without completing or recreating anything', async () => {
  for (const change of ['completion', 'permission', 'cancelled', 'recurrence', 'moved', 'missing']) {
    const f = await fixture(); try {
      await f.prepare(); await f.open(); await f.verify(true, true); const facts = f.facts.get('apple-event-1')!;
      if (change === 'completion') await f.phone.context.completePlan(f.phone.db, f.planId);
      if (change === 'permission') f.permit(false);
      if (change === 'cancelled') f.facts.set(facts.id, { ...facts, cancelled: true });
      if (change === 'recurrence') f.facts.set(facts.id, { ...facts, recurring: true });
      if (change === 'moved') f.facts.set(facts.id, { ...facts, id: 'moved', calendar_id: 'calendar-2' });
      if (change === 'missing') f.facts.clear();
      await f.due(); const prompts = f.prompts; await f.phone.appleCalendar.refreshAppleCalendarReads(f.phone.db, account, f.adapter); assert.equal(f.prompts, prompts);
      const r = await f.review(); assert.equal(r.receipt!.read_enabled, 0); assert.equal(r.receipt!.follow_date, 0); assert.equal(r.plan!.planned_date, '2026-10-05');
      assert.equal((await f.phone.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) n FROM interactions'))!.n, change === 'completion' ? 1 : 0); assert.equal(f.creates, 1);
    } finally { f.close(); }
  }
});

test('A date-following transaction rolls back both the plan and receipt when its durable outbox fails', async () => {
  const f = await fixture(); try {
    await f.prepare(); await f.open(); const original = f.facts.get('apple-event-1')!; f.facts.set(original.id, { ...original, start: '2026-10-09T00:00:00Z', end: '2026-10-10T00:00:00Z' });
    f.phone.faults.sqlContains = 'INSERT INTO sync_queue'; await assert.rejects(f.verify(true, true), /Simulated/); f.phone.faults.sqlContains = undefined;
    assert.equal((await f.review()).plan!.planned_date, '2026-10-05'); assert.equal((await f.review()).receipt!.status, 'saved'); assert.equal((await f.review()).receipt!.facts, null);
    assert.equal((await f.phone.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) n FROM sync_queue'))!.n, 0);
  } finally { f.close(); }
});

test('Restoration pauses consent and retains original receipts; a fresh verification can resume reads without creating another event', async () => {
  const f = await fixture(); try {
    await f.prepare(); await f.open(); await f.verify(true, true); const nextEpoch = crypto.randomUUID();
    await f.phone.appleCalendar.holdAppleCalendarForEpoch(f.phone.db, nextEpoch);
    await f.phone.db.runAsync("UPDATE app_metadata SET value = ? WHERE key = 'sync-cursor-v4'", JSON.stringify({ epoch: nextEpoch, sequence: 1 }));
    await f.restart(); const held = (await f.review()).receipt!; assert.equal(held.status, 'held'); assert.equal(held.epoch, f.epoch); assert.equal(held.read_enabled, 0);
    await assert.rejects(f.prepare(), /original Calendar receipt/); const renewed = await f.verify(true, true); assert.equal(renewed.read_epoch, nextEpoch); assert.equal(renewed.epoch, f.epoch); assert.equal(f.creates, 1);
    await f.phone.context.deleteContext(f.phone.db, 'plan', f.planId); assert.equal((await f.review()).receipt!.status, 'held'); assert.equal((await f.review()).receipt!.read_enabled, 0);
    await f.phone.db.runAsync('DELETE FROM plans WHERE id = ?', f.planId); assert.ok((await f.review()).receipt); assert.equal(f.creates, 1);
  } finally { f.close(); }
});

test('The event editor edits only an explicitly verified original and always requires reverification after its reply', async () => {
  const f = await fixture(); try {
    await f.prepare(); await f.open(); await f.verify(true, true); const r = await f.review();
    const edited = await f.phone.appleCalendar.editAppleCalendar(f.phone.db, account, r.receipt!.id, { revision: r.receipt!.revision, epoch: r.epoch, planFingerprint: r.planFingerprint }, f.adapter);
    assert.equal(edited.status, 'saved'); assert.equal(edited.follow_date, 0); assert.equal(edited.read_enabled, 0); assert.equal(f.edits, 1); assert.equal(f.creates, 1);
    await assert.rejects(f.phone.appleCalendar.editAppleCalendar(f.phone.db, account, edited.id, { revision: edited.revision, epoch: r.epoch, planFingerprint: r.planFingerprint }, f.adapter), /Verify/);
    await f.verify(); const again = await f.review(); f.adapter.edit = async () => { throw new Error('lost edit reply'); };
    await assert.rejects(f.phone.appleCalendar.editAppleCalendar(f.phone.db, account, again.receipt!.id, { revision: again.receipt!.revision, epoch: again.epoch, planFingerprint: again.planFingerprint }, f.adapter), /unconfirmed/);
    assert.equal((await f.review()).receipt!.event_id, 'apple-event-1'); assert.equal((await f.review()).receipt!.status, 'unknown'); assert.equal((await f.verify()).status, 'verified'); assert.equal(f.creates, 1);
  } finally { f.close(); }
});

test('A genuine native schema-13 upgrade preserves private relationships, queued drafts, source links and cursor identities', async () => {
  const sqlite = new Database(':memory:');
  for (const sql of [schema.MOBILE_SCHEMA_SQL, schema.MOBILE_SYNC_MIGRATION_SQL, schema.MOBILE_ENTITY_SYNC_MIGRATION_SQL, schema.MOBILE_CONTEXT_SYNC_MIGRATION_SQL, schema.MOBILE_CONTACT_ALIAS_MIGRATION_SQL, schema.MOBILE_CONTACT_METHODS_MIGRATION_SQL, schema.MOBILE_CONTACT_SOURCES_MIGRATION_SQL, schema.MOBILE_PROVIDER_SOURCES_MIGRATION_SQL, schema.MOBILE_DEVICE_CONTACT_REVIEW_MIGRATION_SQL, schema.MOBILE_DEVICE_SOURCE_SYNC_MIGRATION_SQL, schema.MOBILE_DEVICE_CONTACT_POLICY_MIGRATION_SQL, schema.MOBILE_CALENDAR_CONTEXT_MIGRATION_SQL, schema.MOBILE_CALENDAR_LINKS_MIGRATION_SQL]) sqlite.exec(sql);
  sqlite.pragma('user_version = 13'); const id = crypto.randomUUID(), plan = crypto.randomUUID(), operation = crypto.randomUUID(), now = new Date().toISOString(), epoch = crypto.randomUUID();
  sqlite.prepare('INSERT INTO contacts (id,name,notes,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, 'Existing person', 'PRIVATE', now, now);
  const source = { public_id: crypto.randomUUID(), provider: 'linkedin', account_key: 'personal', external_id: 'ana', profile_url: 'https://www.linkedin.com/in/ana', origin: 'user_provided', fields: JSON.stringify({ name: { original_value: 'Ana from export', observed_value: 'Ana from export', applied_value: null } }), revision: 1, observed_at: now, created_at: now, updated_at: now };
  sqlite.prepare('UPDATE contacts SET source_links = ? WHERE id = ?').run(JSON.stringify([source]), id);
  sqlite.prepare('INSERT INTO plans (id,contact_id,type,planned_date,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(plan, id, 'meetup', '2026-10-05', 'PRIVATE PLAN', now, now);
  sqlite.prepare('INSERT INTO sync_queue (id,entity_type,entity_id,operation,payload,created_at) VALUES (?,?,?,?,?,?)').run(operation, 'plan', plan, 'update', JSON.stringify({ notes: 'Offline draft' }), now);
  sqlite.prepare('INSERT INTO app_metadata (key,value,updated_at) VALUES (?,?,?)').run('sync-cursor-v4', JSON.stringify({ epoch, sequence: 42 }), now);
  const before = JSON.stringify({ people: sqlite.prepare('SELECT * FROM contacts').all(), plans: sqlite.prepare('SELECT * FROM plans').all(), queue: sqlite.prepare('SELECT * FROM sync_queue').all(), cursor: sqlite.prepare("SELECT * FROM app_metadata WHERE key = 'sync-cursor-v4'").all() });
  const phone = await createMobileHarness(account, sqlite); try {
    assert.equal(sqlite.pragma('user_version', { simple: true }), 15); assert.equal((sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'apple_calendar_receipts'").get() as { name: string }).name, 'apple_calendar_receipts');
    assert.equal(JSON.stringify({ people: sqlite.prepare('SELECT * FROM contacts').all(), plans: sqlite.prepare('SELECT * FROM plans').all(), queue: sqlite.prepare('SELECT * FROM sync_queue').all(), cursor: sqlite.prepare("SELECT * FROM app_metadata WHERE key = 'sync-cursor-v4'").all() }), before);
  } finally { phone.close(); }
});
