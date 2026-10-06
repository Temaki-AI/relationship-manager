import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import { accountScope, DEVICE_TOKEN_PREFIX, parseDeviceCallback, readNativeAccount } from '../packages/domain/src/devices.ts';
import { MAX_CACHED_CONTACT_PHOTOS, MAX_CONTACT_PHOTO_RESPONSE_BYTES, readContactPhotoTransfer } from '../packages/domain/src/contact-photo-transfer.ts';
import { readContactPhotoMutation } from '../packages/domain/src/contact-photo-mutation.ts';

const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
async function fixture() {
  const cloud = await createCloudHarness();
  await cloud.db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
    VALUES ('owner', 'Owner', 'owner@example.test', 1, 1, 1)`).run();
  await cloud.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner')").run();
  const verifier = randomBytes(32).toString('hex'), state = randomBytes(32).toString('hex');
  const approval = await cloud.authorizeDevice({ challenge: createHash('sha256').update(verifier).digest('base64url'), state, deviceName: 'Photo test iPhone' });
  const code = parseDeviceCallback((await approval.json()).callback, state), token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const exchange = await cloud.exchangeDevice({ code, state, verifier, token });
  const account = readNativeAccount({ ...(await exchange.json()).identity, origin: 'https://everclosecrm.com', token });
  const person = (await cloud.call('contacts', { method: 'POST', body: { name: 'Photo person', email: 'photo.person@example.test', notes: 'Original private note', photo_url: PHOTO } })).body.contact;
  const mobile = await createMobileHarness(account), requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    assert.equal(url.origin, account.origin); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    assert.equal(headers.get('Authorization'), `Bearer ${account.token}`);
    const path = url.pathname.slice('/api/'.length) + url.search; requests.push(path);
    const response = await cloud.call(path, { method: init?.method, headers: { Authorization: headers.get('Authorization')! },
      ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) });
    return Response.json(response.body, { status: response.status, headers: response.headers });
  };
  await mobile.sync.syncWorkspace(mobile.db, account, { fetcher });
  const epoch = (await cloud.call('v4/sync/bootstrap')).body.cursor.epoch;
  const revision = (await cloud.db.prepare('SELECT revision FROM sync_contact_records WHERE workspace_id = ? AND public_id = ?').bind('test', person.public_id).first())!.revision;
  const url = (id = person.public_id, query = `epoch=${epoch}&revision=${revision}`) => `v1/contact-photos/${id}?${query}`;
  const download = (custom = fetcher, isCurrent?: () => boolean) => mobile.photos.loadContactPhoto(mobile.db, account, person.public_id, { fetcher: custom, isCurrent });
  const cacheCount = () => mobile.sqlite.prepare("SELECT count(*) n FROM app_metadata WHERE key LIKE 'contact-photo:v1:%'").get()!.n;
  const webEdit = async (body: Record<string, unknown>) => {
    const current = (await cloud.call('contacts/' + person.id)).body.contact;
    const result = await cloud.call('contacts/' + person.id, { method: 'PATCH', body: { ...body, expected_edit_revision: current.edit_revision } });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result;
  };
  return { cloud, mobile, account, person, epoch, revision, requests, fetcher, url, download, cacheCount, webEdit,
    async close() { mobile.close(); await cloud.close(); } };
}

test('hosted photos download separately, survive restart offline and never become contact mutations', async () => {
  const f = await fixture(); let reopened: Awaited<ReturnType<typeof createMobileHarness>> | undefined;
  try {
    const before = await f.mobile.contacts.getContact(f.mobile.db, f.person.public_id);
    assert.equal(await f.mobile.photos.cachedContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account)), null);
    assert.equal(await f.download(), PHOTO); assert.equal(await f.download(), PHOTO);
    assert.equal(f.requests.filter((path) => path.startsWith('v1/contact-photos/')).length, 1);
    assert.deepEqual(await f.mobile.contacts.getContact(f.mobile.db, f.person.public_id), before);
    assert.equal(f.mobile.sqlite.prepare('SELECT count(*) n FROM sync_queue').get()!.n, 0);
    reopened = await createMobileHarness(f.account, new Database(f.mobile.sqlite.serialize()));
    assert.equal(await reopened.photos.loadContactPhoto(reopened.db, f.account, f.person.public_id, { fetcher: async () => { throw new Error('Offline'); } }), PHOTO);
    assert.equal(reopened.sqlite.pragma('user_version', { simple: true }), 17);
    assert.equal((await f.cloud.call('contacts/' + f.person.id)).body.contact.notes, 'Original private note');
  } finally { reopened?.close(); await f.close(); }
});

test('a saved photo draft and offline removal survive restart; its exact request retries after a lost reply', async () => {
  const f = await fixture(); let reopened: Awaited<ReturnType<typeof createMobileHarness>> | undefined;
  try {
    await f.download();
    const opening = (await f.mobile.photoOutbox.openContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account))).opening;
    await f.mobile.photoOutbox.saveContactPhotoDraft(f.mobile.db, opening, null);
    reopened = await createMobileHarness(f.account, new Database(f.mobile.sqlite.serialize()));
    assert.equal((await reopened.photoOutbox.openContactPhoto(reopened.db, f.person.public_id, accountScope(f.account))).draft!.photo, null);
    await reopened.photoOutbox.queueContactPhoto(reopened.db, opening, null);
    assert.equal((await reopened.sync.syncSummary(reopened.db)).pending, 1);
    const sent: string[] = [];
    const lostReply: typeof fetch = async (input, init) => {
      if (String(input).includes('/contact-photos/') && init?.method === 'POST') {
        sent.push(String(init.body)); await f.fetcher(input, init); throw new Error('Reply lost');
      }
      return f.fetcher(input, init);
    };
    await assert.rejects(reopened.sync.syncWorkspace(reopened.db, f.account, { fetcher: lostReply }), /reach Everclose/);
    const pending = await reopened.photoOutbox.queuedContactPhoto(reopened.db, f.person.public_id, accountScope(f.account));
    assert.equal(pending!.request_json, sent[0]);
    await assert.rejects(reopened.photoOutbox.discardQueuedContactPhoto(reopened.db, f.person.public_id, accountScope(f.account), pending!.id), /unconfirmed/);
    const appliedRevision = (await f.cloud.db.prepare('SELECT revision FROM sync_contact_records WHERE public_id = ?').bind(f.person.public_id).first())!.revision;
    await f.webEdit({ photo_url: PHOTO, notes: 'New web note' });
    await reopened.sync.syncWorkspace(reopened.db, f.account, { fetcher: async (input, init) => {
      if (String(input).includes('/contact-photos/') && init?.method === 'POST') sent.push(String(init.body));
      return f.fetcher(input, init);
    } });
    assert.deepEqual(sent, [sent[0], sent[0]]);
    assert.equal(await reopened.photoOutbox.queuedContactPhoto(reopened.db, f.person.public_id, accountScope(f.account)), null);
    assert.equal((await f.cloud.call('contacts/' + f.person.id)).body.contact.photo_url, PHOTO);
    assert.equal((await reopened.contacts.getContact(reopened.db, f.person.public_id))!.notes, 'New web note');
    assert.equal((await f.cloud.db.prepare('SELECT revision FROM sync_contact_records WHERE public_id = ?').bind(f.person.public_id).first())!.revision, appliedRevision + 1);
    assert.equal(await reopened.photos.cachedContactPhoto(reopened.db, f.person.public_id, accountScope(f.account)), null); // An old receipt never supplies a newer photo.
    assert.equal(await reopened.photos.loadContactPhoto(reopened.db, f.account, f.person.public_id, { fetcher: f.fetcher }), PHOTO);
  } finally { reopened?.close(); await f.close(); }
});

test('photo digest allows a concurrent note edit but holds a changed photo for explicit review', async () => {
  const f = await fixture(); try {
    await f.download();
    const base = (await f.mobile.photoOutbox.openContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account))).opening;
    await f.mobile.photoOutbox.queueContactPhoto(f.mobile.db, base, null);
    await f.webEdit({ notes: 'Disjoint edit' });
    await f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: f.fetcher });
    assert.equal((await f.cloud.call('contacts/' + f.person.id)).body.contact.photo_url, null);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, f.person.public_id))!.notes, 'Disjoint edit');
    const fresh = (await f.mobile.photoOutbox.openContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account))).opening;
    await f.mobile.photoOutbox.queueContactPhoto(f.mobile.db, fresh, PHOTO);
    const newer = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==';
    await f.webEdit({ photo_url: newer });
    await f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: f.fetcher });
    const held = (await f.mobile.photoOutbox.photoSyncReviews(f.mobile.db))[0];
    assert.equal(held.photo, PHOTO); assert.equal(held.error, 'photo_changed');
    assert.equal((await f.cloud.call('contacts/' + f.person.id)).body.contact.photo_url, newer);
    assert.equal((await f.mobile.sync.syncSummary(f.mobile.db)).conflicts, 1);
    await f.mobile.photos.loadContactPhoto(f.mobile.db, f.account, f.person.public_id, { fetcher: f.fetcher });
    const reviewed = (await f.mobile.photoOutbox.openContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account), true)).opening;
    await f.mobile.photoOutbox.queueContactPhoto(f.mobile.db, reviewed, PHOTO);
    await f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: f.fetcher });
    assert.equal((await f.cloud.call('contacts/' + f.person.id)).body.contact.photo_url, PHOTO);
  } finally { await f.close(); }
});

test('photo selection for a newly created offline person waits for the person acknowledgement', async () => {
  const f = await fixture(); try {
    const person = await f.mobile.contacts.createContact(f.mobile.db, { name: 'Offline photo person', email: '', phone: '', notes: '', contactFrequency: 14 });
    const opening = (await f.mobile.photoOutbox.openContactPhoto(f.mobile.db, person.id, accountScope(f.account))).opening;
    assert.equal(opening.epoch, null);
    await f.mobile.photoOutbox.queueContactPhoto(f.mobile.db, opening, PHOTO);
    await f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: f.fetcher });
    const remote = await f.cloud.db.prepare('SELECT photo_url FROM contacts WHERE public_id = ? AND workspace_id = ?').bind(person.id, 'test').first();
    assert.equal(remote!.photo_url, PHOTO);
    assert.equal(await f.mobile.photos.cachedContactPhoto(f.mobile.db, person.id, accountScope(f.account)), PHOTO);
    assert.equal(await f.mobile.photoOutbox.queuedContactPhoto(f.mobile.db, person.id, accountScope(f.account)), null);
  } finally { await f.close(); }
});

test('photo draft and queue failures roll back and late account changes never acknowledge another cache', async () => {
  const f = await fixture(); try {
    await f.download();
    const opening = (await f.mobile.photoOutbox.openContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account))).opening;
    await f.mobile.photoOutbox.saveContactPhotoDraft(f.mobile.db, opening, null);
    f.mobile.faults.sqlContains = 'DELETE FROM app_metadata';
    await assert.rejects(f.mobile.photoOutbox.queueContactPhoto(f.mobile.db, opening, null), /Simulated/);
    assert.equal(await f.mobile.photoOutbox.queuedContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account)), null);
    assert.ok((await f.mobile.photoOutbox.openContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account))).draft);
    f.mobile.faults.sqlContains = undefined;
    await f.mobile.photoOutbox.queueContactPhoto(f.mobile.db, opening, null);
    let active = true;
    await assert.rejects(f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { isCurrent: () => active, fetcher: async (input, init) => {
      const response = await f.fetcher(input, init);
      if (String(input).includes('/contact-photos/') && init?.method === 'POST') active = false;
      return response;
    } }), /account changed/);
    assert.ok((await f.mobile.photoOutbox.queuedContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account)))!.request_json);
    await f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: f.fetcher });
    assert.equal(await f.mobile.photoOutbox.queuedContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account)), null);
  } finally { await f.close(); }
});

test('atomic photo write rechecks revoked sessions and a database failure leaves no resource write or receipt', async () => {
  const f = await fixture(); try {
    const session = await f.cloud.db.prepare('SELECT id FROM device_sessions WHERE workspace_id = ?').bind('test').first();
    const actor = { workspaceId: 'test', userId: 'owner', authMethod: 'device' as const, deviceId: session!.id as string, lifecycle: 'active' };
    const mutation = readContactPhotoMutation({ version: 1, operation_id: crypto.randomUUID(), epoch: f.epoch, contact_id: f.person.public_id,
      base_digest: createHash('sha256').update(PHOTO).digest('hex'), photo: null });
    const original = f.cloud.db;
    const racing = { prepare: original.prepare.bind(original), batch: async (statements: Parameters<typeof original.batch>[0]) => {
      await original.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), actor.deviceId).run();
      return original.batch(statements);
    } } as typeof original;
    await assert.rejects(f.cloud.contactPhotos.uploadContactPhoto(racing, actor, mutation), /session is no longer valid/);
    assert.equal((await f.cloud.call('contacts/' + f.person.id)).body.contact.photo_url, PHOTO);
    assert.equal((await original.prepare('SELECT count(*) n FROM sync_mutation_receipts WHERE operation_id = ?').bind(mutation.operation_id).first())!.n, 0);
    await original.prepare('UPDATE device_sessions SET revoked_at = NULL WHERE id = ?').bind(actor.deviceId).run();
    await original.prepare("CREATE TRIGGER test_photo_failure BEFORE UPDATE OF photo_url ON contacts BEGIN SELECT RAISE(ABORT, 'simulated photo failure'); END").run();
    const failed = await f.cloud.call('v1/contact-photos/' + f.person.public_id, { method: 'POST', headers: { Authorization: `Bearer ${f.account.token}` }, body: mutation });
    assert.equal(failed.status, 503);
    assert.equal((await original.prepare('SELECT count(*) n FROM sync_mutation_receipts WHERE operation_id = ?').bind(mutation.operation_id).first())!.n, 0);
    await original.prepare('DROP TRIGGER test_photo_failure').run();
    const applied = await f.cloud.call('v1/contact-photos/' + f.person.public_id, { method: 'POST', headers: { Authorization: `Bearer ${f.account.token}` }, body: mutation });
    assert.equal(applied.body.status, 'applied');
    const reused = await f.cloud.call('v1/contact-photos/' + f.person.public_id, { method: 'POST', headers: { Authorization: `Bearer ${f.account.token}` }, body: { ...mutation, photo: PHOTO } });
    assert.equal(reused.status, 409); assert.equal(reused.body.code, 'operation_reused');
  } finally { await f.close(); }
});

test('restored or removed people retain queued photo intent without recreating a contact', async () => {
  const f = await fixture(); try {
    await f.download();
    const opening = (await f.mobile.photoOutbox.openContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account))).opening;
    await f.mobile.photoOutbox.queueContactPhoto(f.mobile.db, opening, null);
    const backup = await f.cloud.call('settings/backups', { method: 'POST' });
    await f.cloud.call('settings/restore', { method: 'POST', body: { filename: backup.body.backup.filename, confirmation: 'RESTORE' } });
    await f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: f.fetcher });
    const held = (await f.mobile.photoOutbox.photoSyncReviews(f.mobile.db))[0];
    assert.equal(held.error, 'epoch_changed'); assert.equal(held.photo, null);
    assert.equal((await f.cloud.call('contacts/' + f.person.id)).body.contact.photo_url, PHOTO);
    await f.mobile.photoOutbox.discardQueuedContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account), held.id);
    await f.mobile.photos.loadContactPhoto(f.mobile.db, f.account, f.person.public_id, { fetcher: f.fetcher });
    const fresh = (await f.mobile.photoOutbox.openContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account))).opening;
    await f.mobile.photoOutbox.queueContactPhoto(f.mobile.db, fresh, null);
    await f.cloud.call('contacts/' + f.person.id, { method: 'DELETE' });
    await f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: f.fetcher });
    assert.equal((await f.mobile.photoOutbox.photoSyncReviews(f.mobile.db))[0].error, 'person_missing');
    assert.equal((await f.cloud.call('contacts/' + f.person.id)).status, 404);
  } finally { await f.close(); }
});

test('a lost photo acknowledgement remains retryable after its original person is merged', async () => {
  const f = await fixture(); try {
    await f.download();
    const opening = (await f.mobile.photoOutbox.openContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account))).opening;
    await f.mobile.photoOutbox.queueContactPhoto(f.mobile.db, opening, null);
    await assert.rejects(f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: async (input, init) => {
      const result = await f.fetcher(input, init);
      if (String(input).includes('/contact-photos/') && init?.method === 'POST') throw new Error('Lost response');
      return result;
    } }));
    const survivor = (await f.cloud.call('contacts', { method: 'POST', body: { name: 'Photo person', email: f.person.email, photo_url: PHOTO } })).body.contact;
    const review = await f.cloud.call('contacts/duplicates');
    assert.equal((await f.cloud.call('contacts/duplicates', { method: 'POST', body: { primaryId: survivor.id, duplicateIds: [f.person.id], expectedRevision: review.body.revision } })).status, 200);
    await f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: f.fetcher });
    assert.equal(await f.mobile.photoOutbox.queuedContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account)), null);
    assert.equal((await f.cloud.call('contacts/' + survivor.id)).body.contact.photo_url, PHOTO);
    assert.equal((await f.cloud.call('contacts/' + f.person.id)).status, 404);
    assert.equal(await f.mobile.photos.cachedContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account)), null);
  } finally { await f.close(); }
});

test('invalid photo changes, oversized bodies and cross-account writes are rejected without changing data', async () => {
  const f = await fixture(); try {
    const body = { version: 1, operation_id: crypto.randomUUID(), epoch: f.epoch, contact_id: f.person.public_id,
      base_digest: createHash('sha256').update(PHOTO).digest('hex'), photo: null };
    const headers = { Authorization: `Bearer ${f.account.token}` }, path = 'v1/contact-photos/' + f.person.public_id;
    for (const photo of ['https://example.test/photo.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,AAAA']) {
      assert.equal((await f.cloud.call(path, { method: 'POST', headers, body: { ...body, photo } })).status, 400);
    }
    assert.equal((await f.cloud.call(path, { method: 'POST', headers, body: { ...body, photo: 'a'.repeat(MAX_CONTACT_PHOTO_RESPONSE_BYTES) } })).status, 413);
    const other = (await f.cloud.call('contacts', { workspace: 'other', method: 'POST', body: { name: 'Foreign person', photo_url: PHOTO } })).body.contact;
    const denied = await f.cloud.call('v1/contact-photos/' + other.public_id, { method: 'POST', headers, body: { ...body, contact_id: other.public_id } });
    assert.equal(denied.body.status, 'conflict'); assert.equal(denied.body.transfer, null);
    assert.equal((await f.cloud.call('contacts/' + other.id, { workspace: 'other' })).body.contact.photo_url, PHOTO);
    assert.equal((await f.cloud.call('contacts/' + f.person.id)).body.contact.photo_url, PHOTO);
    assert.equal((await f.cloud.call(path, { method: 'POST', headers, body: { ...body, contact_id: crypto.randomUUID() } })).status, 400);
  } finally { await f.close(); }
});

test('photo reads recheck owner/session, maintenance, epoch, revision and deleted identities', async () => {
  const f = await fixture(); try {
    const options = { headers: { Authorization: `Bearer ${f.account.token}` } };
    const first = await f.cloud.call(f.url(), options);
    assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'private, no-store');
    const photo = readContactPhotoTransfer(first.body, { epoch: f.epoch, contactId: f.person.public_id, revision: f.revision });
    assert.equal(photo.digest, createHash('sha256').update(PHOTO).digest('hex'));
    await f.cloud.db.prepare("INSERT INTO workspaces (id, name) VALUES ('foreign', 'Other account')").run();
    const foreign = (await f.cloud.call('contacts', { workspace: 'foreign', method: 'POST', body: { name: 'Other person', photo_url: PHOTO } })).body.contact;
    assert.equal((await f.cloud.call(f.url(foreign.public_id), options)).status, 404);
    assert.equal((await f.cloud.call(f.url(crypto.randomUUID()), options)).status, 404);
    assert.equal((await f.cloud.call(f.url(undefined, `epoch=${crypto.randomUUID()}&revision=${f.revision}`), options)).body.code, 'epoch_changed');
    assert.equal((await f.cloud.call(f.url(undefined, `epoch=${f.epoch}&revision=${f.revision + 1}`), options)).body.code, 'photo_changed');
    assert.equal((await f.cloud.call(f.url(undefined, `epoch=${f.epoch}&epoch=${f.epoch}&revision=${f.revision}`), options)).status, 400);
    assert.equal((await f.cloud.call(f.url(), { ...options, method: 'DELETE' })).status, 405);
    await f.cloud.db.prepare("UPDATE workspaces SET lifecycle = 'restoring' WHERE id = 'test'").run();
    assert.equal((await f.cloud.call(f.url(), options)).status, 423);
    await f.cloud.db.prepare("UPDATE workspaces SET lifecycle = 'active' WHERE id = 'test'").run();
    await f.cloud.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), f.account.deviceId).run();
    assert.equal((await f.cloud.call(f.url(), options)).status, 401);
    assert.equal(f.cacheCount(), 0);
  } finally { await f.close(); }
});

test('wrong identities, formats, hashes and excessive photo responses never enter the cache', async () => {
  const f = await fixture(); try {
    const valid = (await f.cloud.call(f.url(), { headers: { Authorization: `Bearer ${f.account.token}` } })).body;
    for (const value of [{ ...valid, contact_id: crypto.randomUUID() }, { ...valid, epoch: crypto.randomUUID() },
      { ...valid, revision: valid.revision + 1 }, { ...valid, photo: 'data:image/png;base64,PGh0bWw+PC9odG1sPg==' },
      { ...valid, digest: '0'.repeat(64) }, { ...valid, photo: PHOTO + 'A'.repeat(180_000) }]) {
      await assert.rejects(f.download(async () => Response.json(value))); assert.equal(f.cacheCount(), 0);
    }
    await assert.rejects(f.download(async () => new Response(' '.repeat(MAX_CONTACT_PHOTO_RESPONSE_BYTES + 1))), /too large/);
    await assert.rejects(f.download(async () => Response.json(valid, { headers: { 'content-length': String(MAX_CONTACT_PHOTO_RESPONSE_BYTES + 1) } })), /too large/);
    assert.equal(f.cacheCount(), 0);
    const corrupted = { ...valid, digest: '0'.repeat(64) };
    f.mobile.sqlite.prepare('INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)').run('contact-photo:v1:' + f.person.public_id, JSON.stringify(corrupted), new Date().toISOString());
    assert.equal(await f.mobile.photos.cachedContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account)), null);
    assert.equal(await f.download(), PHOTO);
  } finally { await f.close(); }
});

test('account switches and contact changes reject late photo downloads without touching private notes', async () => {
  const f = await fixture(); try {
    let current = true;
    await assert.rejects(f.download(async (input, init) => { const reply = await f.fetcher(input, init); current = false; return reply; }, () => current), /account changed/);
    assert.equal(f.cacheCount(), 0);
    await assert.rejects(f.download(async (input, init) => {
      const reply = await f.fetcher(input, init);
      const original = (await f.cloud.call('contacts/' + f.person.id)).body.contact;
      const changed = await f.cloud.call('contacts/' + f.person.id, { method: 'PATCH', body: { notes: 'A web edit after opening', photo_url: null, expected_edit_revision: original.edit_revision } });
      assert.equal(changed.status, 200);
      await f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: f.fetcher });
      return reply;
    }), /changed during/);
    assert.equal(f.cacheCount(), 0); assert.equal(await f.download(), null);
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, f.person.public_id))!.notes, 'A web edit after opening');
    await assert.rejects(f.mobile.photos.cachedContactPhoto(f.mobile.db, f.person.public_id, accountScope({ ...f.account, workspaceId: 'another-workspace' })), /account changed/);
  } finally { await f.close(); }
});

test('cache write and pruning failures roll back together; a bounded cache keeps drafts intact', async () => {
  const f = await fixture(); try {
    f.mobile.faults.sqlContains = 'DELETE FROM app_metadata WHERE key LIKE';
    await assert.rejects(f.download(), /Simulated/); assert.equal(f.cacheCount(), 0);
    f.mobile.faults.sqlContains = undefined;
    for (let index = 0; index < MAX_CACHED_CONTACT_PHOTOS + 5; index++) f.mobile.sqlite.prepare('INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)')
      .run('contact-photo:v1:' + crypto.randomUUID(), JSON.stringify({ old: true }), new Date(index).toISOString());
    f.mobile.sqlite.prepare('INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)').run('journal-form:v1:plan:new:any', 'Private unfinished plan', new Date().toISOString());
    assert.equal(await f.download(), PHOTO); assert.equal(f.cacheCount(), MAX_CACHED_CONTACT_PHOTOS);
    assert.equal(f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'journal-form:v1:plan:new:any'").get()!.value, 'Private unfinished plan');
    assert.equal(await f.mobile.photos.cachedContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account)), PHOTO);
  } finally { await f.close(); }
});

test('removed and restored people never reuse a cached photo from an earlier identity or dataset', async () => {
  const f = await fixture(); try {
    assert.equal(await f.download(), PHOTO);
    const oldCache = f.mobile.sqlite.prepare("SELECT value FROM app_metadata WHERE key = ?").get('contact-photo:v1:' + f.person.public_id)!.value;
    const backup = await f.cloud.call('settings/backups', { method: 'POST' });
    assert.equal(backup.status, 201);
    const restored = await f.cloud.call('settings/restore', { method: 'POST', body: { filename: backup.body.backup.filename, confirmation: 'RESTORE' } });
    assert.equal(restored.status, 200);
    await f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: f.fetcher });
    assert.equal(f.cacheCount(), 0);
    f.mobile.sqlite.prepare('INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)').run('contact-photo:v1:' + f.person.public_id, oldCache, new Date().toISOString());
    assert.equal(await f.mobile.photos.cachedContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account)), null);
    assert.equal(await f.download(), PHOTO);
    await f.cloud.call('contacts/' + f.person.id, { method: 'DELETE' });
    await f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: f.fetcher });
    assert.equal(await f.mobile.photos.cachedContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account)), null);
    assert.equal(await f.download(), null);
  } finally { await f.close(); }
});

test('merging a photographed person follows the survivor identity and never shows the retired cache', async () => {
  const f = await fixture(); try {
    assert.equal(await f.download(), PHOTO);
    const survivor = (await f.cloud.call('contacts', { method: 'POST', body: { name: 'Photo person', email: f.person.email, notes: 'Survivor note' } })).body.contact;
    const review = await f.cloud.call('contacts/duplicates');
    const merged = await f.cloud.call('contacts/duplicates', { method: 'POST', body: { primaryId: survivor.id, duplicateIds: [f.person.id], expectedRevision: review.body.revision } });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    await f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: f.fetcher });
    assert.equal((await f.mobile.contacts.getContact(f.mobile.db, f.person.public_id))!.id, survivor.public_id);
    assert.equal(await f.mobile.photos.cachedContactPhoto(f.mobile.db, f.person.public_id, accountScope(f.account)), null);
    assert.equal(await f.mobile.photos.cachedContactPhoto(f.mobile.db, survivor.public_id, accountScope(f.account)), null);
    const current = (await f.cloud.call('contacts/' + survivor.id)).body.contact;
    const copied = await f.mobile.photos.loadContactPhoto(f.mobile.db, f.account, survivor.public_id, { fetcher: f.fetcher });
    assert.equal(copied, current.photo_url); // Merge may intentionally preserve the original photo on the survivor.
  } finally { await f.close(); }
});
