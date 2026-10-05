import assert from 'node:assert/strict';
import test from 'node:test';
import { gmailContextFixture } from './helpers/gmail-context-fixture.ts';
import { isNativeDeviceApiPath } from '../packages/domain/src/devices.ts';
import { readGmailContextManifest, readGmailContextPage } from '../packages/domain/src/gmail-context.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';

test('the read-only Gmail protocol verifies a real owner device session without granting provider management', async () => {
  const f = await gmailContextFixture(); try {
    const calls = f.calls.length, headers = { Authorization: `Bearer ${f.account.token}` };
    const manifest = await f.h.call('v1/gmail-context', { headers }); assert.equal(manifest.status, 200); assert.equal(manifest.headers.get('cache-control'), 'no-store');
    const m = readGmailContextManifest(manifest.body), page = await f.page(m.scope);
    assert.equal(readGmailContextPage(page, m, f.connection.id, f.person.public_id).messages[0].subject, null);
    const serialized = JSON.stringify(page); for (const omitted of ['participants', 'message_id', 'BODY MUST NOT', 'Private original note', 'credentials', 'fixture-access']) assert.equal(serialized.includes(omitted), false);
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) assert.equal((await f.h.call('v1/gmail-context', { headers, method })).status, 405);
    await assert.rejects(f.h.providers.requireProviderOwner(f.h.db, { ...f.actor, authMethod: 'device' }), /web app/);
    assert.equal(f.calls.length, calls); assert.equal(isNativeDeviceApiPath('/api/v1/gmail-context'), true);
    assert.equal(isNativeDeviceApiPath('/api/v1/gmail-context/anything'), false); assert.equal(getCloudApiRewrite('/api/v1/gmail-context'), '/api/cloud/v1/gmail-context');
    await f.h.db.prepare("UPDATE device_sessions SET revoked_at='2026-10-05T00:00:00Z' WHERE id=?").bind(f.account.deviceId).run();
    assert.equal((await f.h.call('v1/gmail-context', { headers })).status, 401);
  } finally { await f.close(); }
});
test('Gmail context paging is source/person/catalog bound and counts an observed message once', async () => {
  const f = await gmailContextFixture(55); try {
    const m = await f.manifest(), first = await f.page(m.scope); assert.equal(first.messages.length, 50); assert.ok(first.next);
    const second = await f.page(m.scope, first.next!); assert.equal(second.messages.length, 5); assert.equal(second.next, null);
    assert.equal(new Set([...first.messages, ...second.messages].map((message) => message.id)).size, 55);
    assert.deepEqual(first.messages[0].linked_addresses, ['friend@example.test']);
    const query = new URLSearchParams({ scope: m.scope, source_id: f.connection.id, person_id: crypto.randomUUID(), after: first.next! });
    await assert.rejects(f.h.gmailContext.gmailContextPage(f.h.db, f.actor, query), /changed/);
    query.set('person_id', f.person.public_id); query.append('scope', m.scope);
    await assert.rejects(f.h.gmailContext.gmailContextPage(f.h.db, f.actor, query), /changed/);
    assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM interactions').first())!.n, 0);
  } finally { await f.close(); }
});
test('changed matches, email candidates, expiry and revocation invalidate the complete Gmail catalog', async () => {
  const f = await gmailContextFixture(); try {
    const original = await f.manifest();
    await f.h.db.prepare('INSERT INTO contacts(workspace_id,name,email) VALUES(?,?,?)').bind('test', 'Shared address', 'friend@example.test').run();
    await assert.rejects(f.page(original.scope), /changed/);
    const shared = await f.manifest(); assert.notEqual(shared.scope, original.scope); assert.equal((await f.page(shared.scope)).messages.length, 0);
    await f.h.db.prepare('UPDATE provider_gmail_matching SET revision=revision+1 WHERE connection_id=?').bind(f.connection.id).run();
    await assert.rejects(f.page(shared.scope), /changed/);
    const beforeExpiry = await f.manifest();
    await f.h.db.prepare('UPDATE provider_connections SET refresh_expires_at=? WHERE id=?').bind(Date.now() - 1000, f.connection.id).run();
    await assert.rejects(f.page(beforeExpiry.scope), /changed/); assert.deepEqual((await f.manifest()).sources, []);
    await f.h.db.prepare('UPDATE provider_connections SET refresh_expires_at=NULL,status=?,credentials=NULL,authorization_revision=authorization_revision+1 WHERE id=?').bind('disconnected', f.connection.id).run();
    assert.deepEqual((await f.manifest()).sources, []);
    await f.h.db.prepare("UPDATE workspace_members SET role='member' WHERE workspace_id='test' AND user_id='owner'").run();
    await assert.rejects(f.manifest(), /unavailable/);
  } finally { await f.close(); }
});
test('private Gmail transport readers reject subjects without consent, raw participants and foreign identities', async () => {
  const f = await gmailContextFixture(); try {
    const manifest = await f.manifest(), page = await f.page(manifest.scope);
    assert.throws(() => readGmailContextPage({ ...page, messages: [{ ...page.messages[0], subject: 'Unconsented subject' }] }, manifest, f.connection.id, f.person.public_id));
    assert.throws(() => readGmailContextPage({ ...page, messages: [{ ...page.messages[0], participants: [] }] }, manifest, f.connection.id, f.person.public_id));
    assert.throws(() => readGmailContextPage({ ...page, person_id: crypto.randomUUID() }, manifest, f.connection.id, f.person.public_id));
    assert.throws(() => readGmailContextManifest({ ...manifest, sources: [...manifest.sources, ...manifest.sources] }));
    assert.throws(() => readGmailContextPage({ ...page, messages: [...page.messages, ...page.messages] }, manifest, f.connection.id, f.person.public_id));
  } finally { await f.close(); }
});

test('atomic Gmail catalog fences reject an owner device revoked during the read', async () => {
  const f = await gmailContextFixture(); try {
    const original = f.h.db;
    const racing = { prepare: original.prepare.bind(original), batch: async (statements: Parameters<typeof original.batch>[0]) => {
      await original.prepare('UPDATE device_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(), f.account.deviceId).run();
      return original.batch(statements);
    } } as typeof original;
    await assert.rejects(f.h.gmailContext.gmailContextManifest(racing, { ...f.actor, authMethod: 'device', deviceId: f.account.deviceId }));
    assert.equal((await original.prepare('SELECT COUNT(*) n FROM cloud_maintenance_guards').first())!.n, 0);
    await assert.rejects(f.manifest(), /Sign in again/);
  } finally { await f.close(); }
});
