import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { DEVICE_TOKEN_PREFIX, parseDeviceCallback } from '../packages/domain/src/devices.ts';

test('Calendar reservations traverse actual middleware, session authentication and dispatcher while rejecting invalid routes and origins', async () => {
  const h = await createCloudHarness(), previous = process.env.AUTH_MODE; process.env.AUTH_MODE = 'google';
  try {
    await h.db.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Fixture owner', 'owner@test.invalid', 1, 1, 1)").run();
    await h.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner')").run();
    const verifier = randomBytes(32).toString('hex'), state = randomBytes(32).toString('hex');
    const approved = await h.authorizeDevice({ challenge: createHash('sha256').update(verifier).digest('base64url'), state, deviceName: 'Calendar routing fixture' });
    assert.equal(approved.status, 200);
    const code = parseDeviceCallback((await approved.json()).callback, state), token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    assert.equal((await h.exchangeDevice({ code, state, verifier, token })).status, 200);
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Synthetic Calendar person', notes: 'PRIVATE CONTACT' } })).body.contact;
    const plan = (await h.call('plans', { method: 'POST', body: { contact_id: contact.id, type: 'meetup', planned_date: '2026-10-20', notes: 'PRIVATE PLAN' } })).body.plan;
    const epoch = (await h.db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'test'").first<{ epoch: string }>())!.epoch;
    const route = '/api/v1/calendar-reservations', origin = 'https://everclosecrm.com';
    const call = (path: string, body?: unknown, credential = token, extra: Record<string, string> = {}) => h.routedRequest(new Request(origin + path, {
      method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + credential, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const before = await call(route + '?' + new URLSearchParams({ plan_id: plan.public_id, epoch }));
    assert.equal(before.status, 200); assert.equal(before.headers.get('Cache-Control'), 'no-store');
    const preview = await before.json(), operation = crypto.randomUUID();
    const draft = { action: 'reserve', operation_id: operation, plan_id: plan.public_id, expected_epoch: epoch,
      expected_revision: null, expected_plan_fingerprint: preview.plan_fingerprint };
    const reserved = await call(route, draft); assert.equal(reserved.status, 200); assert.equal((await reserved.json()).reservation.status, 'reserved');
    const attempted = await call(route, { ...draft, action: 'attempt', expected_revision: 1 });
    assert.equal(attempted.status, 200); assert.equal((await attempted.json()).reservation.status, 'attempted');
    const saved = await call(route, { ...draft, action: 'result', expected_revision: 2, result_action: 'saved' });
    assert.equal(saved.status, 200); const receipt = await saved.json(); assert.equal(receipt.reservation.status, 'saved');
    assert.ok(!JSON.stringify(receipt).includes('PRIVATE'));
    assert.equal((await call(route + '/extra', draft)).status, 401);
    assert.equal((await call(route + '/', draft)).status, 401);
    assert.equal((await call('/api/cloud/v1/calendar-reservations', draft)).status, 401);
    assert.equal((await call(route, draft, DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url'))).status, 401);
    assert.equal((await call(route, draft, token, { Origin: 'https://attacker.invalid' })).status, 403);
    await h.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE token_hash = ?').bind(new Date().toISOString(), createHash('sha256').update(token).digest('hex')).run();
    assert.equal((await call(route + '?' + new URLSearchParams({ plan_id: plan.public_id, epoch }))).status, 401);
  } finally { if (previous === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = previous; await h.close(); }
});
