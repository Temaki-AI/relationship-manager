import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { DEVICE_TOKEN_PREFIX, isNativeDeviceApiPath, nativeAccountOrigin, parseDeviceCallback } from '../packages/domain/src/devices.ts';
import { WORKSPACE_ERASURE_CONFIRMATION } from '../lib/workspace-erasure-contract.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
async function seeded() {
  const h = await createCloudHarness();
  await h.db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
    VALUES ('owner', 'Owner', 'owner@example.com', 1, 1, 1), ('outsider', 'Other', 'other@example.com', 1, 1, 1)`).run();
  await h.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner'), ('other', 'outsider', 'owner')").run();
  return h;
}
async function authorize(h: Harness) {
  const verifier = randomBytes(32).toString('hex');
  const state = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const response = await h.authorizeDevice({ challenge, state, deviceName: 'My iPhone' });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await response.json();
  return { verifier, state, code: parseDeviceCallback(body.callback, state), token: `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}` };
}
function deviceRequest(path: string, token: string, method = 'GET') {
  return new Request(`https://test.invalid/api/v1/devices/${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
}

test('phone authorization requires a web approval, same origin, current membership and a bounded request count', async () => {
  const h = await seeded();
  try {
    const body = { challenge: randomBytes(32).toString('base64url'), state: randomBytes(32).toString('hex'), deviceName: 'iPhone' };
    assert.equal((await h.authorizeDevice(body, { authMethod: 'device' })).status, 403);
    assert.equal((await h.authorizeDevice(body, { origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await h.authorizeDevice({ ...body, callback: 'https://attacker.invalid' })).status, 400);
    assert.equal((await h.authorizeDevice(body, { workspaceId: 'other' })).status, 429);
    for (let index = 0; index < 5; index++) assert.equal((await h.authorizeDevice(body)).status, 200);
    assert.equal((await h.authorizeDevice(body)).status, 429);
    assert.equal((await h.db.prepare('SELECT count(*) AS count FROM device_authorization_codes').first())?.count, 5);
  } finally { await h.close(); }
});

test('PKCE and state bind redemption to the initiating phone and an uncertain exchange replays its session', async () => {
  const h = await seeded();
  try {
    const login = await authorize(h);
    assert.equal((await h.exchangeDevice({ ...login, verifier: randomBytes(32).toString('hex') })).status, 401);
    assert.equal((await h.exchangeDevice({ ...login, state: randomBytes(32).toString('hex') })).status, 401);
    const responses = await Promise.all([h.exchangeDevice(login), h.exchangeDevice(login)]);
    for (const response of responses) assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const first = await responses[0].json();
    assert.deepEqual(await responses[1].json(), first);
    assert.equal(first.identity.userId, 'owner');
    assert.equal(first.identity.workspaceId, 'test');
    assert.equal(first.identity.email, 'owner@example.com');
    assert.equal((await h.db.prepare('SELECT count(*) AS count FROM device_sessions').first())?.count, 1);
    const persisted = await h.db.prepare('SELECT * FROM device_sessions').first();
    assert.equal(JSON.stringify(persisted).includes(login.token), false);
    assert.equal(JSON.stringify(await h.db.prepare('SELECT * FROM device_authorization_codes').first()).includes(login.code), false);
    const identity = await h.deviceWorkspace(login.token);
    assert.equal(identity.deviceId, first.identity.deviceId);
    assert.equal(identity.role, 'owner');
    assert.equal((await h.exchangeDevice({ ...login, token: `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}` })).status, 409);
  } finally { await h.close(); }
});

test('concurrent redemptions with different secrets cannot replace the winning device credential', async () => {
  const h = await seeded();
  try {
    const first = await authorize(h);
    const second = { ...first, token: `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}` };
    const responses = await Promise.all([h.exchangeDevice(first), h.exchangeDevice(second)]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const winner = responses[0].status === 200 ? first : second;
    const loser = winner === first ? second : first;
    assert.equal((await h.deviceWorkspace(winner.token)).workspaceId, 'test');
    await assert.rejects(h.deviceWorkspace(loser.token), /no longer valid/);
    assert.equal((await h.db.prepare('SELECT count(*) AS count FROM device_sessions').first())?.count, 1);
  } finally { await h.close(); }
});

test('revocation, expiration and membership removal immediately reject device access without crossing tenants', async () => {
  const h = await seeded();
  try {
    const login = await authorize(h);
    const identity = (await (await h.exchangeDevice(login)).json()).identity;
    const owner = { userId: 'owner', workspaceId: 'test', lifecycle: 'active', authMethod: 'web' };
    const other = { ...owner, userId: 'outsider', workspaceId: 'other' };
    const listed = await h.deviceRoute(new Request('https://test.invalid/api/v1/devices'), other, ['v1', 'devices']);
    assert.deepEqual((await listed.json()).devices, []);
    assert.equal((await h.deviceRoute(deviceRequest(identity.deviceId, login.token, 'DELETE'), other, ['v1', 'devices', identity.deviceId])).status, 404);
    const device = { ...owner, authMethod: 'device', deviceId: identity.deviceId };
    assert.equal((await h.deviceRoute(deviceRequest('session', login.token), device, ['v1', 'devices', 'session'])).status, 200);
    assert.equal((await h.deviceRoute(deviceRequest('session', login.token, 'DELETE'), device, ['v1', 'devices', 'session'])).status, 200);
    await assert.rejects(h.deviceWorkspace(login.token), /no longer valid/);
    assert.equal((await h.exchangeDevice(login)).status, 409);
    const fresh = await authorize(h);
    await h.exchangeDevice(fresh);
    await h.db.prepare("DELETE FROM workspace_members WHERE workspace_id = 'test' AND user_id = 'owner'").run();
    await assert.rejects(h.deviceWorkspace(fresh.token), /no longer valid/);
    await h.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner')").run();
    await h.db.prepare("UPDATE device_sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    await assert.rejects(h.deviceWorkspace(fresh.token), /no longer valid/);
  } finally { await h.close(); }
});

test('expired codes, maintenance and the ten-device limit cannot leave a half-redeemed authorization', async () => {
  const h = await seeded();
  try {
    const expired = await authorize(h);
    await h.db.prepare("UPDATE device_authorization_codes SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    assert.equal((await h.exchangeDevice(expired)).status, 401);
    const current = await authorize(h);
    await h.db.prepare("UPDATE workspaces SET lifecycle = 'restoring' WHERE id = 'test'").run();
    assert.equal((await h.exchangeDevice(current)).status, 409);
    assert.equal((await h.db.prepare('SELECT device_id FROM device_authorization_codes WHERE state = ?').bind(current.state).first())?.device_id, null);
    await h.db.prepare("UPDATE workspaces SET lifecycle = 'active' WHERE id = 'test'").run();
    for (let index = 0; index < 10; index++) {
      const login = index === 0 ? current : await authorize(h);
      assert.equal((await h.exchangeDevice(login)).status, 200);
    }
    const extra = await authorize(h);
    assert.equal((await h.exchangeDevice(extra)).status, 409);
    assert.equal((await h.db.prepare('SELECT device_id FROM device_authorization_codes WHERE state = ?').bind(extra.state).first())?.device_id, null);
    assert.equal((await h.db.prepare('SELECT count(*) AS count FROM device_sessions').first())?.count, 10);
  } finally { await h.close(); }
});

test('device secrets stay out of CRM backups and erasure revokes existing devices and pending codes', async () => {
  const h = await seeded();
  try {
    const login = await authorize(h);
    await h.exchangeDevice(login);
    await authorize(h);
    const backup = (await h.call('settings/backups', { method: 'POST' })).body.backup;
    const snapshot = (await h.call(`settings/backups/${backup.filename}`)).body;
    assert.equal(snapshot.tables.device_sessions, undefined);
    assert.equal(snapshot.tables.device_authorization_codes, undefined);
    assert.equal(JSON.stringify(snapshot).includes(login.token), false);
    assert.equal((await h.call('settings/erase', { method: 'POST', body: { confirmation: WORKSPACE_ERASURE_CONFIRMATION } })).status, 200);
    await assert.rejects(h.deviceWorkspace(login.token), /no longer valid/);
    assert.equal((await h.db.prepare('SELECT count(*) AS count FROM device_authorization_codes').first())?.count, 0);
  } finally { await h.close(); }
});

test('native route and callback policy reject privilege expansion, response substitution and unsafe origins', () => {
  assert.equal(isNativeDeviceApiPath('/api/v1/device-sources/push'), true);
  assert.equal(isNativeDeviceApiPath('/api/v1/device-sources/unknown'), false);
  assert.equal(isNativeDeviceApiPath('/api/v1/sync/push'), true);
  for (const version of [2, 3, 4]) for (const action of ['bootstrap', 'pull', 'push']) assert.equal(isNativeDeviceApiPath(`/api/v${version}/sync/${action}`), true);
  assert.equal(isNativeDeviceApiPath('/api/v1/devices/session'), true);
  for (const path of ['/api/settings/erase', '/api/v1/devices/authorize', '/api/v1/devices', '/', '/api/contacts/1', '/api/v3/sync/unknown', '/api/v4/sync/unknown', '/api/v5/sync/push']) assert.equal(isNativeDeviceApiPath(path), false);
  assert.equal(nativeAccountOrigin('https://everclosecrm.com'), 'https://everclosecrm.com');
  assert.throws(() => nativeAccountOrigin('http://everclosecrm.com'), /HTTPS/);
  assert.throws(() => nativeAccountOrigin('https://everclosecrm.com/attacker'), /HTTPS/);
  assert.throws(() => nativeAccountOrigin('https://user:secret@everclosecrm.com'), /HTTPS/);
  assert.equal(nativeAccountOrigin('http://localhost:3100', true), 'http://localhost:3100');
  const state = 'a'.repeat(64);
  const code = 'b'.repeat(43);
  assert.equal(parseDeviceCallback(`bonds://auth?code=${code}&state=${state}`, state), code);
  assert.throws(() => parseDeviceCallback(`bonds://auth?code=${code}&state=${state}&code=${code}`, state), /does not match/);
  assert.throws(() => parseDeviceCallback(`bonds://auth?code=${code}&state=${'c'.repeat(64)}`, state), /does not match/);
  assert.throws(() => parseDeviceCallback(`https://auth?code=${code}&state=${state}`, state), /does not match/);
});
