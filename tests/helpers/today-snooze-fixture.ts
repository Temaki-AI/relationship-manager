import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { createCloudHarness } from './cloud-harness.ts';
import { createMobileHarness } from './mobile-harness.ts';
import { DEVICE_TOKEN_PREFIX, parseDeviceCallback, readNativeAccount } from '../../packages/domain/src/devices.ts';
import { promptUntil, type PromptKind, type PromptMutation } from '../../packages/domain/src/today-snoozes.ts';

export async function todaySnoozeFixture() {
  const cloud = await createCloudHarness(), verifier = randomBytes(32).toString('hex'), state = randomBytes(32).toString('hex');
  await cloud.db.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@example.invalid', 1, 1, 1)").run();
  await cloud.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner')").run();
  const approved = await cloud.authorizeDevice({ challenge: createHash('sha256').update(verifier).digest('base64url'), state, deviceName: 'Prompt preferences QA iPhone' });
  assert.equal(approved.status, 200, JSON.stringify(await approved.clone().json()));
  const code = parseDeviceCallback((await approved.json()).callback, state), token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const exchanged = await cloud.exchangeDevice({ code, state, verifier, token }); assert.equal(exchanged.status, 200);
  const account = readNativeAccount({ ...(await exchanged.json()).identity, token, origin: 'https://everclosecrm.com' });
  let phone = await createMobileHarness(account);
  const requests: { path: string; body?: string }[] = [];
  const transport: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`);
    const url = new URL(String(input)), route = url.pathname.slice(5) + url.search, body = init?.body as string | undefined;
    requests.push({ path: route, body });
    const response = await cloud.call(route, { method: init?.method ?? 'GET', headers: { Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.parse(body) } : {}) });
    return Response.json(response.body, { status: response.status });
  };
  const core = () => phone.sync.syncWorkspace(phone.db, account, { fetcher: transport });
  const sync = (fetcher = transport, isCurrent = () => true) => phone.todaySnoozes.syncPromptSnoozes(phone.db, account, { fetcher, isCurrent, timeZone: 'UTC' });
  async function person(name = 'Ana') {
    const birthday = '1990-' + new Date().toISOString().slice(5, 10);
    const p = (await cloud.call('contacts', { method: 'POST', body: { name, email: 'ana@example.invalid', notes: 'Private memory', birthday } })).body.contact;
    const id = (await cloud.db.prepare('SELECT public_id FROM contacts WHERE workspace_id = ? AND id = ?').bind('test', p.id).first<{ public_id: string }>())!.public_id;
    return { ...p, publicId: id };
  }
  await core();
  const epoch = JSON.parse(phone.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'").get().value).epoch as string;
  const mutation = (kind: PromptKind, targetId: string, untilDate: string | null = promptUntil(7, new Date(), 'UTC'), baseUntilDate: string | null = null): PromptMutation =>
    ({ version: 1, operationId: crypto.randomUUID(), epoch, kind, targetId, untilDate, baseUntilDate, timeZone: 'UTC' });
  const push = (body: PromptMutation) => cloud.call('v1/today-snoozes', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
  return { cloud, account, requests, transport, core, sync, person, epoch, mutation, push,
    get phone() { return phone; },
    restart: async () => { const saved = phone.sqlite.serialize(); phone.close(); phone = await createMobileHarness(account, new Database(saved)); },
    close: async () => { phone.close(); await cloud.close(); } };
}
