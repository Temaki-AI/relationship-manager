import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { gmailContextFixture } from './helpers/gmail-context-fixture.ts';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import * as schema from '../apps/mobile/src/data/schema.ts';
import { clearPrivateAccountCaches, registerPrivateAccountCache } from '../apps/mobile/src/native/private-account-cache.ts';
import { accountScope } from '../packages/domain/src/devices.ts';

test('reviewed Gmail metadata defaults off, survives restart offline, and never changes CRM history or outbox', async () => {
  const f = await gmailContextFixture(); let reopened: Awaited<ReturnType<typeof createMobileHarness>> | undefined;
  try {
    const requests = f.requests.length; await f.mobile.gmailContext.refreshGmailManifest(f.mobile.db, f.account, { fetcher: f.fetcher }); assert.equal(f.requests.length, requests);
    const before = JSON.stringify({ contacts: f.mobile.sqlite.prepare('SELECT * FROM contacts').all(), history: f.mobile.sqlite.prepare('SELECT * FROM interactions').all(), queue: f.mobile.sqlite.prepare('SELECT * FROM sync_queue').all() });
    await f.enable(); await f.download(); assert.equal((await f.read()).messages.length, 1);
    reopened = await createMobileHarness(f.account, new Database(f.mobile.sqlite.serialize()));
    const saved = await reopened.gmailContext.readGmailContext(reopened.db, f.account, f.connection.id, f.person.public_id); assert.equal(saved.messages.length, 1);
    await assert.rejects(reopened.gmailContext.refreshGmailManifest(reopened.db, f.account, { fetcher: async () => { throw new Error('Offline'); } }), /Offline/);
    assert.equal((await reopened.gmailContext.readGmailContext(reopened.db, f.account, f.connection.id, f.person.public_id)).messages.length, 1);
    assert.equal(JSON.stringify({ contacts: f.mobile.sqlite.prepare('SELECT * FROM contacts').all(), history: f.mobile.sqlite.prepare('SELECT * FROM interactions').all(), queue: f.mobile.sqlite.prepare('SELECT * FROM sync_queue').all() }), before);
  } finally { reopened?.close(); await f.close(); }
});
test('older reviewed pages publish atomically, reject repeated cursors and preserve cache on local transaction failure', async () => {
  const f = await gmailContextFixture(55); try {
    await f.enable(); await f.download(); const first = await f.read(); assert.equal(first.messages.length, 50);
    f.mobile.faults.sqlContains = 'INSERT OR REPLACE INTO gmail_person_context';
    await assert.rejects(f.download(first.next), /local database write failure/); assert.equal((await f.read()).messages.length, 50);
    f.mobile.faults.sqlContains = undefined; await f.download(first.next); assert.equal((await f.read()).messages.length, 55);
    await assert.rejects(f.download(first.next), /changed/); assert.equal((await f.read()).messages.length, 55);
  } finally { await f.close(); }
});
test('disabling email storage or changing accounts fences a delayed private page', async () => {
  const f = await gmailContextFixture(); try {
    await f.enable(); let release: (() => void) | undefined;
    const delayed: typeof fetch = async (input, init) => { const response = await f.fetcher(input, init); if (String(input).includes('person_id')) await new Promise<void>((resolve) => { release = resolve; }); return response; };
    const running = f.download(null, delayed); while (!release) await new Promise((resolve) => setImmediate(resolve));
    await f.mobile.gmailContext.setGmailContextEnabled(f.mobile.db, f.account, false); release(); await assert.rejects(running, /changed/);
    assert.equal((await f.read()).enabled, false); assert.equal(f.mobile.sqlite.prepare('SELECT COUNT(*) n FROM gmail_person_context').get()!.n, 0);
    await assert.rejects(f.mobile.gmailContext.readGmailContext(f.mobile.db, { ...f.account, userId: 'other' }), /changed/);
  } finally { await f.close(); }
});
test('an offline contact identity change clears all email projections and holds new reads until its queue is acknowledged', async () => {
  const f = await gmailContextFixture(); try {
    await f.enable(); await f.download();
    let opening = (await f.mobile.contacts.getContactForEditing(f.mobile.db, f.person.public_id))!;
    await f.mobile.contacts.updateContact(f.mobile.db, opening, { name: opening.name, email: opening.email, phone: opening.phone, notes: 'A private correction', contactFrequency: opening.contact_frequency }); assert.equal((await f.read()).messages.length, 1);
    opening = (await f.mobile.contacts.getContactForEditing(f.mobile.db, f.person.public_id))!;
    await f.mobile.contacts.updateContact(f.mobile.db, opening, { name: opening.name, email: 'changed@example.test', phone: opening.phone, notes: opening.notes, contactFrequency: opening.contact_frequency });
    assert.equal((await f.read()).pendingIdentity, true); assert.equal((await f.read()).messages.length, 0);
    await assert.rejects(f.mobile.gmailContext.refreshGmailManifest(f.mobile.db, f.account, { fetcher: f.fetcher }), /changed/);
    await f.mobile.sync.syncWorkspace(f.mobile.db, f.account, { fetcher: f.fetcher });
    await f.mobile.gmailContext.refreshGmailManifest(f.mobile.db, f.account, { fetcher: f.fetcher }); await f.download();
    assert.equal((await f.read()).messages.length, 0); assert.equal((await f.mobile.contacts.getContact(f.mobile.db, f.person.public_id))!.notes, 'A private correction');
  } finally { await f.close(); }
});
test('catalog changes and authorization denial erase cached metadata without erasing CRM records', async () => {
  const f = await gmailContextFixture(); try {
    await f.enable(); await f.download();
    await f.h.db.prepare('UPDATE provider_gmail_matching SET revision=revision+1 WHERE connection_id=?').bind(f.connection.id).run();
    await f.mobile.gmailContext.refreshGmailManifest(f.mobile.db, f.account, { fetcher: f.fetcher }); assert.equal((await f.read()).messages.length, 0);
    const person = await f.mobile.contacts.getContact(f.mobile.db, f.person.public_id);
    for (const status of [401, 403, 413]) {
      await f.mobile.gmailContext.refreshGmailManifest(f.mobile.db, f.account, { fetcher: f.fetcher }); await f.download();
      await assert.rejects(f.mobile.gmailContext.refreshGmailManifest(f.mobile.db, f.account, { fetcher: async () => Response.json({ error: 'Unavailable' }, { status }) }));
      assert.equal(f.mobile.sqlite.prepare('SELECT COUNT(*) n FROM gmail_person_context').get()!.n, 0); assert.deepEqual(await f.mobile.contacts.getContact(f.mobile.db, f.person.public_id), person);
    }
  } finally { await f.close(); }
});
test('offline email review expires and workspace recovery discards private context', async () => {
  const f = await gmailContextFixture(); try {
    await f.enable(); await f.download();
    f.mobile.sqlite.prepare("UPDATE gmail_context_state SET manifest=json_set(manifest,'$.valid_until',?)").run(Date.now() - 1);
    assert.equal((await f.read()).messages.length, 0);
    await f.mobile.gmailContext.refreshGmailManifest(f.mobile.db, f.account, { fetcher: f.fetcher });
    await f.mobile.db.withExclusiveTransactionAsync(async (tx) => f.mobile.gmailContext.discardGmailContextForEpoch(tx, crypto.randomUUID()));
    assert.equal(f.mobile.sqlite.prepare('SELECT COUNT(*) n FROM gmail_person_context').get()!.n, 0); assert.equal((await f.read()).manifest, null);
  } finally { await f.close(); }
});

test('private account cleanup clears and disables email storage before disconnect completes', async () => {
  const f = await gmailContextFixture(); try {
    await f.enable(); await f.download();
    const unregister = registerPrivateAccountCache(accountScope(f.account), () => f.mobile.gmailContext.clearGmailContext(f.mobile.db, true));
    await clearPrivateAccountCaches('another-account'); assert.equal((await f.read()).messages.length, 1);
    await clearPrivateAccountCaches(accountScope(f.account)); assert.equal((await f.read()).enabled, false); assert.equal((await f.read()).messages.length, 0);
    unregister(); assert.ok(await f.mobile.contacts.getContact(f.mobile.db, f.person.public_id));
  } finally { await f.close(); }
});

test('a genuine schema-14 upgrade preserves every existing table and frozen queued operation', async () => {
  const f = await gmailContextFixture(); const sqlite = new Database(':memory:'); let upgraded: Awaited<ReturnType<typeof createMobileHarness>> | undefined;
  try {
    for (const sql of [schema.MOBILE_SCHEMA_SQL, schema.MOBILE_SYNC_MIGRATION_SQL, schema.MOBILE_ENTITY_SYNC_MIGRATION_SQL, schema.MOBILE_CONTEXT_SYNC_MIGRATION_SQL, schema.MOBILE_CONTACT_ALIAS_MIGRATION_SQL, schema.MOBILE_CONTACT_METHODS_MIGRATION_SQL, schema.MOBILE_CONTACT_SOURCES_MIGRATION_SQL, schema.MOBILE_PROVIDER_SOURCES_MIGRATION_SQL, schema.MOBILE_DEVICE_CONTACT_REVIEW_MIGRATION_SQL, schema.MOBILE_DEVICE_SOURCE_SYNC_MIGRATION_SQL, schema.MOBILE_DEVICE_CONTACT_POLICY_MIGRATION_SQL, schema.MOBILE_CALENDAR_CONTEXT_MIGRATION_SQL, schema.MOBILE_CALENDAR_LINKS_MIGRATION_SQL, schema.MOBILE_APPLE_CALENDAR_MIGRATION_SQL]) sqlite.exec(sql);
    sqlite.pragma('user_version = 14'); const id = crypto.randomUUID(), now = new Date().toISOString();
    sqlite.prepare('INSERT INTO contacts(id,name,email,notes,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, 'Saved native person', 'native@example.test', 'Private existing note', now, now);
    sqlite.prepare('INSERT INTO sync_queue(id,entity_type,entity_id,operation,payload,request_json,created_at) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), 'contact', id, 'update', '{"notes":"Offline correction"}', '{"protocol":4,"frozen":"Keep exact bytes"}', now);
    sqlite.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?)').run('sync-cursor-v4', JSON.stringify({ epoch: f.epoch, sequence: 42 }), now);
    sqlite.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?)').run('private-form-draft', '{"notes":"Existing unsent form"}', now);
    const metadata = sqlite.prepare("SELECT * FROM app_metadata WHERE key IN('sync-cursor-v4','private-form-draft') ORDER BY key").all();
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='app_metadata' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    const before = tables.map((name) => ({ name, rows: sqlite.prepare('SELECT * FROM "' + name + '"').all() }));
    upgraded = await createMobileHarness(f.account, sqlite);
    assert.equal(sqlite.pragma('user_version', { simple: true }), 16);
    assert.deepEqual(tables.map((name) => ({ name, rows: sqlite.prepare('SELECT * FROM "' + name + '"').all() })), before);
    assert.deepEqual(sqlite.prepare("SELECT * FROM app_metadata WHERE key IN('sync-cursor-v4','private-form-draft') ORDER BY key").all(), metadata);
    assert.equal((await upgraded.gmailContext.readGmailContext(upgraded.db, f.account)).enabled, false);
    assert.equal(sqlite.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { if (upgraded) upgraded.close(); else sqlite.close(); await f.close(); }
});

test('a catalog change after a page response discards its private projection instead of publishing it', async () => {
  const f = await gmailContextFixture(); try {
    await f.enable(); let changed = false;
    const racing: typeof fetch = async (input, init) => {
      const response = await f.fetcher(input, init);
      if (!changed && String(input).includes('person_id')) { changed = true; await f.h.db.prepare('UPDATE provider_gmail_matching SET revision=revision+1 WHERE connection_id=?').bind(f.connection.id).run(); }
      return response;
    };
    await assert.rejects(f.download(null, racing), /changed/); assert.equal((await f.read()).messages.length, 0);
    assert.equal(f.mobile.sqlite.prepare('SELECT COUNT(*) n FROM gmail_person_context').get()!.n, 0);
  } finally { await f.close(); }
});

test('offline email cache limits preserve the last complete page instead of overwriting it', async () => {
  const f = await gmailContextFixture(); try {
    await f.enable(); const manifest = (await f.read()).manifest!, base = Date.now() - 1000;
    const synthetic: typeof fetch = async (input, init) => {
      const query = new URL(String(input)).searchParams;
      if (!query.has('person_id')) return f.fetcher(input, init);
      const offset = query.has('after') ? Number(JSON.parse(JSON.parse(query.get('after')!).cursor).id.slice(7)) + 1 : 0;
      const messages = Array.from({ length: 50 }, (_, index) => { const n = offset + index; return { id: 'budget_' + String(n).padStart(4, '0'), thread_id: 'thread_' + n, received_at: base - n * 1000, direction: 'incoming', subject: null, linked_addresses: ['friend@example.test'] }; });
      const last = messages.at(-1)!;
      return Response.json({ protocol: 1, scope: manifest.scope, source_id: f.connection.id, person_id: f.person.public_id, messages,
        next: JSON.stringify({ scope: manifest.scope, source_id: f.connection.id, person_id: f.person.public_id, cursor: JSON.stringify({ at: last.received_at, id: last.id }) }) });
    };
    let next: string | null = null;
    for (let page = 0; page < 10; page++) { await f.download(next, synthetic); next = (await f.read()).next; }
    assert.equal((await f.read()).messages.length, 500);
    await assert.rejects(f.download(next, synthetic), /500 messages/);
    assert.equal((await f.read()).messages.length, 500); assert.equal((await f.read()).next, next);
    await assert.rejects(f.download(null, async () => Response.json({ oversized: 'é'.repeat(600000) })), /too large/);
    assert.equal((await f.read()).messages.length, 500);
  } finally { await f.close(); }
});
