import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { gmailFixture } from './gmail-fixture.ts';
import { createMobileHarness } from './mobile-harness.ts';
import { DEVICE_TOKEN_PREFIX, parseDeviceCallback, readNativeAccount } from '../../packages/domain/src/devices.ts';
export async function gmailContextFixture(count = 1) {
  const f = await gmailFixture();
  const person = (await f.h.call('contacts', { method: 'POST', body: { name: 'Email person', email: 'friend@example.test', notes: 'Private original note' } })).body.contact;
  for (let i = 0; i < count; i++) f.message('message_' + String(i).padStart(3, '0'), { at: Date.now() - 1000 - i * 1000 });
  await f.save(); await f.finish((await f.start()).run.id);
  for (let step = 0; step < 5; step++) { if ((await f.h.gmailMatching.prepareGmailMatching(f.h.db, f.actor, f.connection.id)).directory_ready) break; }
  const match = await f.h.gmailMatching.reviewGmailMatches(f.h.db, f.actor, f.connection.id);
  await f.h.gmailMatching.decideGmailMatch(f.h.db, f.actor, f.connection.id, { operation_id: crypto.randomUUID(), action: 'link', email: 'friend@example.test', target_public_id: person.public_id,
    expected_epoch: match.epoch, expected_authorization_revision: match.authorization_revision, expected_settings_revision: match.settings_revision, expected_generation: match.generation,
    expected_directory_revision: match.directory_revision, expected_matching_revision: match.matching_revision });
  const verifier = randomBytes(32).toString('hex'), state = randomBytes(32).toString('hex'), token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const approval = await f.h.authorizeDevice({ challenge: createHash('sha256').update(verifier).digest('base64url'), state, deviceName: 'Email test phone' });
  assert.equal(approval.status, 200);
  const code = parseDeviceCallback((await approval.json()).callback, state);
  const exchange = await f.h.exchangeDevice({ code, state, verifier, token }); assert.equal(exchange.status, 200);
  const account = readNativeAccount({ ...(await exchange.json()).identity, origin: 'https://test.invalid', token });
  const mobile = await createMobileHarness(account), requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, account.origin); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    const authorization = new Headers(init?.headers).get('Authorization'); assert.equal(authorization, `Bearer ${token}`);
    const path = url.pathname.slice('/api/'.length) + url.search; requests.push(path);
    const response = await f.h.call(path, { method: init?.method, headers: { Authorization: authorization! }, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return Response.json(response.body, { status: response.status, headers: response.headers });
  };
  await mobile.sync.syncWorkspace(mobile.db, account, { fetcher });
  const manifest = () => f.h.gmailContext.gmailContextManifest(f.h.db, { ...f.actor, authMethod: 'device', deviceId: account.deviceId });
  const page = async (scope: string, after?: string) => f.h.gmailContext.gmailContextPage(f.h.db, { ...f.actor, authMethod: 'device', deviceId: account.deviceId }, new URLSearchParams({ scope, source_id: f.connection.id, person_id: person.public_id, ...(after ? { after } : {}) }));
  const enable = async () => { await mobile.gmailContext.setGmailContextEnabled(mobile.db, account, true); await mobile.gmailContext.refreshGmailManifest(mobile.db, account, { fetcher }); };
  const download = (after: string | null = null, transport = fetcher) => mobile.gmailContext.refreshGmailPerson(mobile.db, account, f.connection.id, person.public_id, after, { fetcher: transport });
  const read = () => mobile.gmailContext.readGmailContext(mobile.db, account, f.connection.id, person.public_id);
  return { ...f, mobile, account, requests, fetcher, person, manifest, page, enable, download, read, close: async () => { mobile.close(); await f.h.close(); } };
}
