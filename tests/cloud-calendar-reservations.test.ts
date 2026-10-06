import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { publicationFixture } from './helpers/google-publication-fixture.ts';
import { DEVICE_TOKEN_PREFIX, isNativeDeviceApiPath, parseDeviceCallback } from '../packages/domain/src/devices.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';
import type { DeviceActor } from '../lib/cloud/device-api.ts';
import { publicationPlanSnapshot } from '../packages/domain/src/calendar-reservations.ts';
import { fingerprintIdempotencyInput } from '../lib/idempotency.ts';

test('native snapshot serialization retains the existing Google plan fingerprint, including Unicode private fields', () => {
  const plan = { public_id: crypto.randomUUID(), contact_public_id: crypto.randomUUID(), type: 'meetup',
    planned_date: '2026-10-06', summary: 'Café ☕', notes: 'Private\ncontext', completed_at: null };
  assert.equal(createHash('sha256').update(JSON.stringify(publicationPlanSnapshot(plan))).digest('hex'), fingerprintIdempotencyInput(plan));
});

async function fixture() {
  const f = await publicationFixture(), api = f.h.calendarReservations;
  async function phone() {
    const verifier = randomBytes(32).toString('hex'), state = randomBytes(32).toString('hex');
    const approved = await f.h.authorizeDevice({ challenge: createHash('sha256').update(verifier).digest('base64url'), state, deviceName: 'Calendar reservation QA phone' });
    assert.equal(approved.status, 200);
    const code = parseDeviceCallback((await approved.json()).callback, state), token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const exchanged = await f.h.exchangeDevice({ code, state, verifier, token }); assert.equal(exchanged.status, 200);
    const identity = (await exchanged.json()).identity;
    return { actor: { ...identity, lifecycle: 'active', authMethod: 'device' } as DeviceActor, token };
  }
  const p = await phone(), q = await phone();
  const epoch = (await f.h.db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'test'").first<{ epoch: string }>())!.epoch;
  const read = (actor = p.actor, operation?: string) => api.readCalendarReservation(f.h.db, actor, f.plan.public_id, epoch, operation);
  const preview = await read();
  const body = (overrides = {}) => ({ action: 'reserve', operation_id: crypto.randomUUID(), plan_id: f.plan.public_id,
    expected_epoch: epoch, expected_plan_fingerprint: preview.plan_fingerprint!, expected_revision: null, ...overrides });
  const mutate = (value: unknown, actor = p.actor) => api.mutateCalendarReservation(f.h.db, actor, value);
  const next = (b: ReturnType<typeof body>, action: string, revision: number, extra = {}) => ({ ...b, action, expected_revision: revision, ...extra });
  const rows = async () => (await f.h.db.prepare('SELECT * FROM calendar_publication_reservations').all()).results;
  return { f, p, q, epoch, api, read, body, mutate, next, rows, close: () => f.h.close() };
}

test('two phones competing for one plan acquire one durable reservation without sharing event details', async () => {
  const t = await fixture(); try {
    const a = t.body(), b = t.body();
    const r = await Promise.allSettled([t.mutate(a), t.mutate(b, t.q.actor)]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((await t.rows()).length, 1);
    const saved = await t.read(); assert.equal(saved.reservation!.provider, 'apple-calendar');
    assert.equal(JSON.stringify(saved).includes('PRIVATE'), false); assert.equal(JSON.stringify(saved).includes('@'), false);
    assert.equal(t.f.calls.filter((x) => x.method === 'POST' || x.method === 'PATCH').length, 0);
    await assert.rejects(t.f.prepare(), /already has a Calendar publication/);
    assert.equal((await t.f.h.db.prepare('SELECT * FROM calendar_plan_publications').all()).results.length, 0);
  } finally { await t.close(); }
});

test('Google publication and a device reservation race atomically without a provider write', async () => {
  const t = await fixture(); try {
    const r = await t.f.review(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const fetcher = async (url: string, init: RequestInit) => {
      if (new URL(url).pathname.includes('/calendarList/')) { entered(); await gate; }
      return t.f.fetcher(url, init);
    };
    const pending = t.f.h.planPublications.preparePlanPublication(t.f.h.db,
      { userId: 'owner', workspaceId: 'test', authMethod: 'web' }, t.f.env, t.f.connection.id, t.f.plan.public_id,
      { operation_id: crypto.randomUUID(), expected_preview_fingerprint: r.preview_fingerprint, draft: t.f.draft() }, fetcher);
    await paused; await t.mutate(t.body()); release();
    await assert.rejects(pending, /acquired another Calendar publication/);
    assert.equal((await t.f.h.db.prepare('SELECT * FROM calendar_plan_publications').all()).results.length, 0);
    assert.equal((await t.f.h.db.prepare('SELECT * FROM calendar_plan_writes').all()).results.length, 0);
    assert.equal((await t.rows()).length, 1); assert.equal(t.f.calls.filter((x) => x.method !== 'GET').length, 0);
  } finally { await t.close(); }
});

test('Google receipts reserve a plan through preparation, uncertain writes and confirmation', async () => {
  const t = await fixture(); try {
    await t.f.prepare(); let row = (await t.read()).reservation!;
    assert.equal(row.provider, 'google-calendar'); assert.equal(row.status, 'reserved'); assert.equal(row.on_this_phone, false);
    await assert.rejects(t.mutate(t.body()), /already has a Calendar publication/);
    t.f.loseReply = true; await t.f.advance(); row = (await t.read()).reservation!;
    assert.equal(row.attempted, true); assert.equal(row.status, 'attempted');
    await t.f.advance('verify'); assert.equal((await t.read()).reservation!.status, 'saved');
    await t.f.prepare(t.f.draft({ summary: 'Reviewed update' })); await t.f.advance();
    assert.equal((await t.read()).reservation!.status, 'saved');
    assert.equal(t.f.calls.filter((x) => x.method === 'POST').length, 1);
  } finally { await t.close(); }
});

test('lost reservation and attempt replies replay the same receipt; another phone cannot control it', async () => {
  const t = await fixture(); try {
    const b = t.body(), reserved = await t.mutate(b); assert.equal(reserved.reservation.revision, 1);
    assert.deepEqual(await t.mutate(b), reserved);
    const attempt = t.next(b, 'attempt', 1), attempted = await t.mutate(attempt);
    assert.equal(attempted.reservation.status, 'attempted'); assert.equal(attempted.reservation.revision, 2);
    assert.deepEqual(await t.mutate(attempt), attempted); assert.equal((await t.mutate(b)).reservation.status, 'attempted');
    await assert.rejects(t.mutate(attempt, t.q.actor), /another Calendar review/);
    await assert.rejects(t.mutate(t.next(b, 'release', 2)), /cannot be discarded/);
    assert.equal((await t.rows()).length, 1);
  } finally { await t.close(); }
});

test('a saved editor result is durable and idempotent and cannot release the original publication', async () => {
  const t = await fixture(); try {
    const b = t.body(); await t.mutate(b); await t.mutate(t.next(b, 'attempt', 1));
    const result = t.next(b, 'result', 2, { result_action: 'saved' });
    const saved = await t.mutate(result); assert.equal(saved.reservation.status, 'saved'); assert.deepEqual(await t.mutate(result), saved);
    await assert.rejects(t.mutate(t.next(b, 'result', 3, { result_action: 'canceled' })), /cannot be discarded/);
    await assert.rejects(t.mutate(t.next(b, 'release', 3)), /cannot be discarded/);
    const plan = await t.f.h.db.prepare('SELECT notes, completed_at FROM plans WHERE public_id = ?').bind(t.f.plan.public_id).first();
    assert.equal(plan!.notes, 'PRIVATE PLAN NOTE'); assert.equal(plan!.completed_at, null);
    assert.equal((await t.f.h.db.prepare('SELECT * FROM interactions').all()).results.length, 0);
  } finally { await t.close(); }
});

test('only an unattempted release or the originating editor cancellation allows a new publication', async () => {
  const t = await fixture(); try {
    const a = t.body(); await t.mutate(a); const release = t.next(a, 'release', 1);
    assert.equal((await t.mutate(release)).reservation.status, 'cancelled'); assert.equal((await t.mutate(release)).reservation.revision, 2);
    const b = t.body(); await t.mutate(b); await t.mutate(t.next(b, 'attempt', 1));
    const canceled = t.next(b, 'result', 2, { result_action: 'canceled' });
    assert.equal((await t.mutate(canceled)).reservation.status, 'cancelled'); assert.equal((await t.mutate(canceled)).reservation.revision, 3);
    assert.equal((await t.mutate(b)).reservation.status, 'cancelled'); await assert.rejects(t.mutate(t.next(b, 'attempt', 1)), /cannot be discarded/);
    await t.f.prepare(); assert.equal((await t.read()).reservation!.provider, 'google-calendar'); assert.equal((await t.rows()).length, 3);
  } finally { await t.close(); }
});

test('plan edits, session revocation and wrong ownership fence actions before an editor can open', async () => {
  const t = await fixture(); try {
    const b = t.body(); await t.mutate(b);
    await t.f.h.db.prepare('UPDATE plans SET notes = ? WHERE public_id = ?').bind('A newer private note', t.f.plan.public_id).run();
    await assert.rejects(t.mutate(t.next(b, 'attempt', 1)), /Sync the plan/);
    const newPreview = await t.read();
    await assert.rejects(t.mutate({ ...t.next(b, 'attempt', 1), expected_plan_fingerprint: newPreview.plan_fingerprint }), /snapshot changed/);
    await assert.rejects(t.read({ ...t.p.actor, workspaceId: 'elsewhere' }), { status: 401 });
    await t.f.h.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), t.p.actor.deviceId!).run();
    assert.equal((await t.read(t.q.actor)).reservation!.status, 'held'); await assert.rejects(t.mutate(t.next(b, 'attempt', 1)), /Sign in/);
  } finally { await t.close(); }
});

test('an authorization loss between reads and the atomic reservation commit rolls back the claim', async () => {
  const t = await fixture(); try {
    const db = { ...t.f.h.db, prepare: t.f.h.db.prepare.bind(t.f.h.db), batch: async (statements: Parameters<typeof t.f.h.db.batch>[0]) => {
      await t.f.h.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), t.p.actor.deviceId!).run();
      return t.f.h.db.batch(statements);
    } };
    await assert.rejects(t.api.mutateCalendarReservation(db, t.p.actor, t.body()), /Sign in/); assert.equal((await t.rows()).length, 0);
  } finally { await t.close(); }
});

test('CRM backup excludes operational claims; restore holds them and complete erasure removes them', async () => {
  const t = await fixture(); try {
    const b = t.body(); await t.mutate(b); await t.mutate(t.next(b, 'attempt', 1));
    const backup = (await t.f.h.call('settings/backups', { method: 'POST' })).body.backup;
    const snapshot = (await t.f.h.call('settings/backups/' + backup.filename)).body;
    assert.equal(snapshot.tables.calendar_publication_reservations, undefined);
    assert.equal((await t.f.h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200);
    assert.equal((await t.rows())[0].status, 'held'); assert.equal((await t.rows())[0].attempted, 1);
    await assert.rejects(t.mutate(t.next(b, 'result', 2, { result_action: 'canceled' })), /recovery/);
    assert.equal((await t.f.h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } })).status, 200);
    assert.equal((await t.rows()).length, 0);
  } finally { await t.close(); }
});

test('migration 49 backfills existing Google publication identity without changing prior data', async () => {
  const t = await fixture(); try {
    await t.f.prepare(); await t.f.advance();
    const triggers = ['insert_guard', 'update_guard', 'google_insert', 'google_attempt', 'google_state', 'restore', 'plan_delete', 'device_revoke'];
    for (const n of triggers) await t.f.h.db.prepare('DROP TRIGGER calendar_reservation_' + n).run();
    await t.f.h.db.prepare('DROP TABLE calendar_publication_reservations').run();
    const names = (await t.f.h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>()).results.map((p) => p.name);
    const before = new Map<string, string>();
    for (const n of names) before.set(n, JSON.stringify((await t.f.h.db.prepare('SELECT * FROM "' + n + '"').all()).results));
    const sql = readFileSync(new URL('../drizzle/0049_calendar_publication_reservations.sql', import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) if (statement.trim()) await t.f.h.db.prepare(statement).run();
    for (const n of names) assert.equal(JSON.stringify((await t.f.h.db.prepare('SELECT * FROM "' + n + '"').all()).results), before.get(n), n);
    assert.equal((await t.rows()).length, 1); assert.equal((await t.rows())[0].status, 'saved'); assert.equal((await t.rows())[0].attempted, 1);
    assert.equal((await t.read()).reservation!.provider, 'google-calendar'); assert.equal((await t.f.h.db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  } finally { await t.close(); }
});

test('the exact native route authenticates sessions and rejects web writes, extra paths and malformed actions', async () => {
  const t = await fixture(); try {
    const path = '/api/v1/calendar-reservations';
    assert.equal(isNativeDeviceApiPath(path), true); assert.equal(getCloudApiRewrite(path), '/api/cloud/v1/calendar-reservations');
    for (const extra of ['/other', '/', '-extra']) { assert.equal(isNativeDeviceApiPath(path + extra), false); assert.equal(getCloudApiRewrite(path + extra), null); }
    const call = (body: unknown, token?: string) => t.f.h.call('v1/calendar-reservations', { method: 'POST', body, headers: token ? { Authorization: 'Bearer ' + token } : {} });
    assert.equal((await call(t.body())).status, 403); assert.equal((await call(t.body(), 'invalid-token')).status, 401);
    assert.equal((await call({ ...t.body(), title: 'Do not share this' }, t.p.token)).status, 400);
    const b = t.body(); assert.equal((await call(b, t.p.token)).status, 200);
    const r = await t.f.h.call(`v1/calendar-reservations?plan_id=${b.plan_id}&epoch=${t.epoch}`, { headers: { Authorization: 'Bearer ' + t.q.token } });
    assert.equal(r.status, 200); assert.equal(r.body.reservation.on_this_phone, false); assert.equal(r.headers.get('cache-control'), 'no-store');
  } finally { await t.close(); }
});
