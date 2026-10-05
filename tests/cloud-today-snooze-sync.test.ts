import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const { NextRequest } = createRequire(import.meta.url)('next/server');
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { DEVICE_TOKEN_PREFIX, parseDeviceCallback, readNativeAccount } from '../packages/domain/src/devices.ts';
import { promptUntil, type PromptMutation } from '../packages/domain/src/today-snoozes.ts';

async function fixture() {
  const h = await createCloudHarness();
  await h.db.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@example.invalid', 1, 1, 1)").run();
  await h.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner')").run();
  const verifier = randomBytes(32).toString('hex'), state = randomBytes(32).toString('hex');
  const approved = await h.authorizeDevice({ challenge: createHash('sha256').update(verifier).digest('base64url'), state, deviceName: 'Migration 44 prompt QA' });
  assert.equal(approved.status, 200);
  const code = parseDeviceCallback((await approved.json()).callback, state), token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const exchanged = await h.exchangeDevice({ code, state, verifier, token }); assert.equal(exchanged.status, 200);
  const account = readNativeAccount({ ...(await exchanged.json()).identity, token, origin: 'https://everclosecrm.com' });
  const actor = { ...account, authMethod: 'device' as const, lifecycle: 'active' };
  const p = (await h.call('contacts', { method: 'POST', body: { name: 'Migration 44 person', notes: 'Private memory', birthday: '1990-10-06' } })).body.contact;
  const identity = await h.db.prepare('SELECT public_id FROM contacts WHERE workspace_id = ? AND id = ?').bind('test', p.id).first<{ public_id: string }>();
  const epoch = (await h.db.prepare('SELECT epoch FROM workspace_sync_state WHERE workspace_id = ?').bind('test').first<{ epoch: string }>())!.epoch;
  assert.equal(await h.db.prepare("SELECT name FROM sqlite_master WHERE name = 'gmail_observations'").first(), null);
  const mutation = (until: string | null, base: string | null): PromptMutation => ({ version: 1, operationId: crypto.randomUUID(), epoch, kind: 'birthday', targetId: identity!.public_id, untilDate: until, baseUntilDate: base, timeZone: 'UTC' });
  return { h, actor, p, epoch, identity: identity!.public_id, mutation };
}

test('migration-44 shared snoozes use existing web rows and receipts without changing private CRM facts', async () => {
  const f = await fixture(); try {
    const web = promptUntil(7, new Date(), 'UTC'), phone = promptUntil(1, new Date(), 'UTC'), laterWeb = promptUntil(30, new Date(), 'UTC');
    assert.equal((await f.h.call('today/snooze', { method: 'PUT', body: { id: `birthday-${f.p.id}`, until: web, timeZone: 'UTC' } })).status, 200);
    const snapshot = await f.h.todaySnoozeSync.promptSnoozeSnapshot(f.h.db, f.actor, f.epoch, 'UTC');
    assert.deepEqual(snapshot.snoozes, [{ kind: 'birthday', targetId: f.identity, contactId: f.identity, untilDate: web }]);
    const body = f.mutation(phone, web), acknowledgement = await f.h.todaySnoozeSync.pushPromptSnooze(f.h.db, f.actor, body);
    await f.h.call('today/snooze', { method: 'PUT', body: { id: `birthday-${f.p.id}`, until: laterWeb, timeZone: 'UTC' } });
    assert.deepEqual(await f.h.todaySnoozeSync.pushPromptSnooze(f.h.db, f.actor, body, new Date('2099-01-01T00:00:00Z')), acknowledgement);
    await assert.rejects(f.h.todaySnoozeSync.pushPromptSnooze(f.h.db, f.actor, { ...body, untilDate: laterWeb }), { code: 'receipt_mismatch' });
    await assert.rejects(f.h.todaySnoozeSync.pushPromptSnooze(f.h.db, f.actor, f.mutation(phone, web)), { code: 'prompt_changed' });
    assert.equal((await f.h.db.prepare('SELECT until_date FROM daily_snoozes').first<{ until_date: string }>())!.until_date, laterWeb);
    assert.equal((await f.h.db.prepare('SELECT notes FROM contacts WHERE public_id = ?').bind(f.identity).first<{ notes: string }>())!.notes, 'Private memory');
    assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM interactions').first<{ n: number }>())!.n, 0);
  } finally { await f.h.close(); }
});

test('migration-44 authorization, restore and paused-workspace fences guard snapshots and original receipts', async () => {
  const f = await fixture(); try {
    const body = f.mutation(promptUntil(7, new Date(), 'UTC'), null);
    await f.h.todaySnoozeSync.pushPromptSnooze(f.h.db, f.actor, body);
    await assert.rejects(f.h.todaySnoozeSync.promptSnoozeSnapshot(f.h.db, { ...f.actor, authMethod: 'web' }, f.epoch, 'UTC'), { code: 'device_required' });
    await f.h.db.prepare('UPDATE workspace_sync_state SET paused = 1 WHERE workspace_id = ?').bind('test').run();
    await assert.rejects(f.h.todaySnoozeSync.pushPromptSnooze(f.h.db, f.actor, body), { code: 'maintenance' });
    await f.h.db.prepare('UPDATE workspace_sync_state SET paused = 0, epoch = ? WHERE workspace_id = ?').bind(crypto.randomUUID(), 'test').run();
    await assert.rejects(f.h.todaySnoozeSync.pushPromptSnooze(f.h.db, f.actor, body), { code: 'epoch_changed' });
    await f.h.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), f.actor.deviceId).run();
    await assert.rejects(f.h.todaySnoozeSync.promptSnoozeSnapshot(f.h.db, f.actor, f.epoch, 'UTC'), { code: 'unauthorized' });
  } finally { await f.h.close(); }
});


test('migration-44 real Google middleware and dispatcher accept the exact bearer path and reject a revoked session', async () => {
  const previous = process.env.AUTH_MODE; process.env.AUTH_MODE = 'google';
  const f = await fixture(); try {
    const body = f.mutation(promptUntil(7, new Date(), 'UTC'), null);
    const headers = { Authorization: `Bearer ${f.actor.token}`, 'Content-Type': 'application/json' };
    const request = new NextRequest('https://everclosecrm.com/api/v1/today-snoozes', { method: 'POST', headers, body: JSON.stringify(body) });
    const gate = await f.h.middleware(request); assert.equal(gate.status, 200);
    const rewritten = gate.headers.get('x-middleware-rewrite'); assert.equal(rewritten, 'https://everclosecrm.com/api/cloud/v1/today-snoozes');
    const response = await f.h.cloudRoute(new Request(rewritten!, { method: 'POST', headers, body: JSON.stringify(body) }), { params: Promise.resolve({ path: ['v1', 'today-snoozes'] }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).operationId, body.operationId);
    const get = new Request(rewritten + '?epoch=' + f.epoch + '&timeZone=UTC', { headers });
    const snapshot = await f.h.cloudRoute(get, { params: Promise.resolve({ path: ['v1', 'today-snoozes'] }) });
    assert.equal(snapshot.status, 200); assert.equal((await snapshot.json()).snoozes[0].targetId, f.identity);
    await f.h.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), f.actor.deviceId).run();
    assert.equal((await f.h.cloudRoute(get, { params: Promise.resolve({ path: ['v1', 'today-snoozes'] }) })).status, 401);
    assert.equal((await f.h.middleware(new NextRequest('https://everclosecrm.com/api/v1/today-snoozes/extra', { headers }))).status, 401);
  } finally { await f.h.close(); if (previous === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = previous; }
});
