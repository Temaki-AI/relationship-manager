import assert from 'node:assert/strict';
import test from 'node:test';
import { gmailChoices, gmailFixture } from './helpers/gmail-fixture.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';
import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';

test('reviewed Gmail choices are source-scoped, idempotent, default-private and require current labels and authorization', async () => {
  const f = await gmailFixture(); try {
    assert.equal(await f.h.gmailDownloads.reviewGmailSource(f.h.db, f.actor, f.connection.id), null);
    const saved = (await f.save())!; assert.equal(saved.settings_revision, 1); assert.equal(saved.choices.retain_subject, false);
    assert.equal((await f.save())!.settings_revision, 1);
    await assert.rejects(f.save({ ...gmailChoices, label_ids: ['Missing_Label'] }), /unavailable/);
    await assert.rejects(f.h.gmailDownloads.reviewGmailSource(f.h.db, { workspaceId: 'other', userId: 'second' }, f.connection.id), /Reconnect/);
    await assert.rejects(f.start('incremental'), /full scan/);
    await assert.rejects(f.h.gmailDownloads.startGmailDownload(f.h.db, f.actor, f.env, f.connection.id, {
      operation_id: crypto.randomUUID(), mode: ['full'], expected_epoch: f.epoch, expected_authorization_revision: 1, expected_settings_revision: 1,
    }), /Review current/);
    await assert.rejects(f.h.gmailDownloads.saveGmailChoices(f.h.db, f.actor, f.env, f.connection.id, { choices: gmailChoices, expected_epoch: f.epoch, expected_authorization_revision: 99, expected_settings_revision: 1 }, f.fetcher), /changed/);
  } finally { await f.h.close(); }
});

test('limited scans report missing coverage, reject page-token cycles and retain the previous published generation', async () => {
  const f = await gmailFixture(); try {
    for (let index = 0; index < 101; index++) f.message('message_' + index);
    f.lists.set('INBOX:', { messages: [...f.messages.keys()].slice(0, 100).map((id) => ({ id, threadId: 'thread_' + id })), nextPageToken: 'more' });
    await f.save({ ...gmailChoices, scan_limit: 100 }); const full = await f.start();
    assert.equal((await f.finish(full.run.id)).limited, true);
    const before = await f.review(); assert.equal(before.coverage, 'limited');
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_index').first())!.n, 100);
    f.lists.set('INBOX:', { messages: [{ id: 'message_0', threadId: 'thread_message_0' }], nextPageToken: 'cycle' });
    f.lists.set('INBOX:cycle', { messages: [{ id: 'message_0', threadId: 'thread_message_0' }], nextPageToken: 'cycle' });
    const next = await f.start(), failed = await f.finish(next.run.id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.issue, 'unsupported_or_over_limit'); assert.deepEqual(await f.review(), before);
  } finally { await f.h.close(); }
});

test('generation-pinned pages are stable at equal timestamps and reject old cursors, duplicate parameters and extra keys', async () => {
  const f = await gmailFixture(); try {
    const at = Date.now() - 1000; for (let index = 0; index < 55; index++) f.message('same_' + String(index).padStart(2, '0'), { at });
    await f.save(); const full = await f.start(); await f.finish(full.run.id);
    const first = await f.review(); assert.equal(first.messages.length, 50); assert.equal(first.more, true);
    const second = await f.review(new URLSearchParams({ generation: first.generation!, after: first.next! }));
    assert.equal(second.messages.length, 5); assert.equal(second.more, false);
    assert.equal(new Set([...first.messages, ...second.messages].map((message) => message.facts.id)).size, 55);
    for (const query of ['generation=' + first.generation + '&generation=' + first.generation, 'after=bad', 'token=secret', 'after=' + 'x'.repeat(1025)]) await assert.rejects(f.review(new URLSearchParams(query)), /current|first/);
    const refresh = await f.start('incremental'); await f.finish(refresh.run.id);
    await assert.rejects(f.review(new URLSearchParams({ generation: first.generation!, after: first.next! })), /changed/);
  } finally { await f.h.close(); }
});

test('overlapping workers cannot claim a leased step; authorization and owner changes discard delayed provider replies', async () => {
  for (const change of ['authorization', 'owner'] as const) {
    const f = await gmailFixture(); try {
      f.message('one'); await f.save(); const started = await f.start(); await f.advance(started.run.id);
      let release!: () => void, entered!: () => void;
      const began = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
      f.setHook(async (url) => { if (!url.pathname.endsWith('/messages')) return null; entered(); await gate; return Response.json({ messages: [{ id: 'one', threadId: 'thread_one' }] }); });
      const pending = f.advance(started.run.id).then(() => null, (error: unknown) => error); await began;
      await assert.rejects(f.advance(started.run.id), /running/);
      if (change === 'authorization') await f.h.db.prepare('UPDATE provider_connections SET authorization_revision = authorization_revision + 1 WHERE id = ?').bind(f.connection.id).run();
      else await f.h.db.prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = 'test' AND user_id = 'owner'").run();
      release(); assert.match(String(await pending), /CLOUD_RECOVERY_CONFLICT/);
      assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_index').first())!.n, 0);
      assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_pending').first())!.n, 0);
    } finally { await f.h.close(); }
  }
});

test('SQL guards reject nested private fields, own addresses and invalid participant roles without partial writes', async () => {
  const f = await gmailFixture(); try {
    await f.save(); const started = await f.start();
    const run = (await f.h.db.prepare('SELECT * FROM provider_gmail_runs WHERE id = ?').bind(started.run.id).first())!;
    const at = Number(run.window_end) - 1;
    const facts = { id: 'safe', thread_id: 'thread_safe', received_at: at, direction: 'incoming', participants: [{ email: 'friend@example.test', roles: ['from'] }], participants_incomplete: false, subject: null, message_id: null };
    const insert = (value: unknown) => f.h.db.prepare('INSERT INTO provider_gmail_index(connection_id,generation,message_id,received_at,observed_at,facts) VALUES(?,?,?,?,?,?)').bind(f.connection.id, run.generation, 'safe', at, at + 1, JSON.stringify(value)).run();
    for (const bad of [
      { ...facts, body: 'PRIVATE BODY' }, { ...facts, subject: 'NOT CONSENTED' },
      { ...facts, participants: [{ email: 'friend@example.test', roles: ['from'], name: 'PRIVATE NAME' }] },
      { ...facts, participants: [{ email: 'owner@example.test', roles: ['to'] }] },
      { ...facts, participants: [{ email: 'friend@example.test', roles: ['body'] }] },
      { ...facts, participants: [{ email: 'friend@example.test', roles: ['from', 'from'] }] },
      { ...facts, participants: [...facts.participants, ...facts.participants] },
    ]) await assert.rejects(insert(bad), /PROVIDER_GMAIL_INVALID/);
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_index').first())!.n, 0);
    await insert(facts); assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_index').first())!.n, 1);
  } finally { await f.h.close(); }
});

test('privacy maintenance expires unfinished runs and old messages without touching people or active retained generations', async () => {
  const f = await gmailFixture(); try {
    f.message('one'); await f.save(); const full = await f.start(); await f.finish(full.run.id); const before = await f.review();
    assert.equal((await f.h.gmailDownloads.cancelGmailDownload(f.h.db, f.actor, f.connection.id, full.run.id)).status, 'complete');
    assert.deepEqual(await f.review(), before);
    const next = await f.start(); await f.advance(next.run.id); await f.advance(next.run.id);
    const now = Date.now() + 3600001; await f.h.gmailDownloads.pruneGmailCache(f.h.db, now);
    const expired = (await f.h.db.prepare('SELECT * FROM provider_gmail_runs WHERE id = ?').bind(next.run.id).first())!;
    assert.equal(expired.status, 'failed'); assert.equal(expired.issue, 'download_expired');
    assert.equal(expired.updated_at, new Date(now).toISOString()); assert.deepEqual(await f.review(), before);
    await f.h.gmailDownloads.pruneGmailCache(f.h.db, Date.now() + 91 * 86400000);
    assert.equal((await f.review()).messages.length, 0);
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_runs').first())!.n, 1);
  } finally { await f.h.close(); }
});

test('Gmail cloud routes are exact, no-store and reject foreign origins, unreviewed bodies and unauthorized readers', async () => {
  const f = await gmailFixture(); try {
    await f.save(); const started = await f.start(), base = '/api/connections/' + f.connection.id + '/gmail';
    for (const suffix of ['/settings', '/messages', '/downloads', '/downloads/' + started.run.id, '/downloads/' + started.run.id + '/step']) assert.equal(getCloudApiRewrite(base + suffix), (base + suffix).replace('/api/', '/api/cloud/'));
    for (const suffix of ['/settings/extra', '/messages/attachments', '/downloads/no-id', '/downloads/' + started.run.id + '/step/extra', '/downloads/' + started.run.id + '/attachment']) assert.equal(getCloudApiRewrite(base + suffix), null);
    async function api(suffix: string, method: string, body?: unknown, origin = f.env.BETTER_AUTH_URL, actor = f.actor) {
      return f.h.providerApi.handleProviderConnections(new Request(f.env.BETTER_AUTH_URL + base + suffix, { method,
        headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), actor, (base + suffix).split('?')[0].slice(5).split('/'));
    }
    const result = await api('/messages', 'GET'); assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await api('/downloads/' + started.run.id, 'DELETE', {}, 'https://attacker.invalid')).status, 403);
    assert.equal((await api('/downloads/' + started.run.id + '/step?token=private', 'POST', {})).status, 400);
    assert.equal((await api('/settings', 'PATCH', { extra: 'x'.repeat(17000) })).status, 413);
    assert.equal((await api('/downloads/' + started.run.id + '/step', 'POST', { extra: true })).status, 404);
    assert.equal((await api('/messages', 'GET', undefined, f.env.BETTER_AUTH_URL, { workspaceId: 'other', userId: 'second', authMethod: 'web' })).status, 409);
    assert.equal((await api('/downloads/' + started.run.id, 'DELETE', {})).status, 200);
  } finally { await f.h.close(); }
});

test('migration 46 preserves every existing table and field and introduces only empty, private Gmail cache tables', () => {
  const db = new Database(':memory:'); try {
    db.pragma('foreign_keys = ON'); const directory = new URL('../drizzle/', import.meta.url);
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '0046_').sort()) db.exec(readFileSync(new URL(name, directory), 'utf8'));
    db.exec("INSERT INTO workspaces(id,name) VALUES('upgrade','Upgrade'); INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('owner','Owner','owner@example.test',1,1,1); INSERT INTO workspace_members(workspace_id,user_id,role) VALUES('upgrade','owner','owner'); INSERT INTO contacts(workspace_id,name,notes,email) VALUES('upgrade','Kept person','Original private notes','friend@example.test');");
    const epoch = (db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id='upgrade'").get() as { epoch: string }).epoch;
    db.prepare("INSERT INTO provider_connections(id,workspace_id,user_id,provider,purpose,account_id,email,display_name,granted_scopes,status,dataset_epoch,credentials,revision,created_at,updated_at) VALUES(?,'upgrade','owner','google','gmail','subject','owner@example.test','Original','[]','connected',?,'unchanged-ciphertext',7,'2026-10-03','2026-10-03')").run(crypto.randomUUID(), epoch);
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    const before = tables.map((name) => ({ name, rows: db.prepare('SELECT * FROM "' + name + '"').all() }));
    db.exec(readFileSync(new URL('0046_google_gmail_downloads.sql', directory), 'utf8'));
    assert.deepEqual(tables.map((name) => ({ name, rows: db.prepare('SELECT * FROM "' + name + '"').all() })), before);
    for (const name of ['resources', 'runs', 'pending', 'index', 'pages']) assert.equal((db.prepare('SELECT count(*) n FROM provider_gmail_' + name).get() as { n: number }).n, 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []); assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally { db.close(); }
});

test('connection review fences an ownership change after reading the source snapshot', async () => {
  const f = await gmailFixture(); try {
    f.message('one'); await f.save(); const full = await f.start(); await f.finish(full.run.id);
    let changed = false;
    const guarded = new Proxy(f.h.db, { get(target, key) {
      if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
        const result = await target.batch(...args);
        if (!changed) { changed = true; await target.prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id='test' AND user_id='owner'").run(); }
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await assert.rejects(f.h.gmailConnection.reviewGmailConnection(guarded, f.actor, f.connection.id), /CLOUD_RECOVERY_CONFLICT/);
    assert.equal(changed, true);
  } finally { await f.h.close(); }
});

test('failed publication rolls back the generation and checkpoint together and can retry the same durable step', async () => {
  const f = await gmailFixture(); try {
    f.message('one'); await f.save(); const full = await f.start(); await f.finish(full.run.id); const before = await f.review();
    f.message('two'); const next = await f.start();
    let staged = next.run; for (let count = 0; count < 100 && staged.phase !== 'publish'; count++) staged = await f.advance(next.run.id);
    assert.equal(staged.phase, 'publish');
    const checkpoint = (await f.h.db.prepare('SELECT checkpoint FROM provider_gmail_resources').first())!.checkpoint;
    await f.h.db.prepare("CREATE TRIGGER fixture_gmail_publish BEFORE UPDATE OF active_generation ON provider_gmail_resources BEGIN SELECT RAISE(ABORT,'FIXTURE_GMAIL_PUBLISH'); END").run();
    await assert.rejects(f.advance(next.run.id), /FIXTURE_GMAIL_PUBLISH/);
    assert.deepEqual(await f.review(), before); assert.equal((await f.h.db.prepare('SELECT checkpoint FROM provider_gmail_resources').first())!.checkpoint, checkpoint);
    assert.equal((await f.h.db.prepare('SELECT status FROM provider_gmail_runs WHERE id = ?').bind(next.run.id).first())!.status, 'active');
    await f.h.db.prepare('DROP TRIGGER fixture_gmail_publish').run();
    assert.equal((await f.advance(next.run.id)).status, 'complete');
    assert.deepEqual((await f.review()).messages.map((message) => message.facts.id).sort(), ['one', 'two']);
  } finally { await f.h.close(); }
});
test('staged label scans deduplicate messages, filter traffic and publish sanitized projections atomically without changing people', async () => {
  const f = await gmailFixture(); try {
    await f.h.call('contacts', { method: 'POST', body: { name: 'Kept friend', notes: 'Private relationship note' } });
    const contacts = (await f.h.db.prepare('SELECT * FROM contacts').all()).results;
    f.message('one'); f.message('bulk', { headers: [{ name: 'List-ID', value: '<bulk.test>' }] }); f.message('old', { at: Date.now() - 91 * 86400000 });
    await f.save(); const started = await f.start();
    assert.equal((await f.h.gmailDownloads.startGmailDownload(f.h.db, f.actor, f.env, f.connection.id, started.body)).id, started.run.id);
    await f.advance(started.run.id); await f.advance(started.run.id); await f.advance(started.run.id);
    assert.equal((await f.review()).messages.length, 0); assert.equal((await f.h.gmailDownloads.reviewGmailSource(f.h.db, f.actor, f.connection.id))!.generation, null);
    const complete = await f.finish(started.run.id); assert.equal(complete.status, 'complete'); assert.equal(complete.processed, 3);
    const result = await f.review(); assert.equal(result.coverage, 'scanned'); assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].facts.id, 'one'); assert.equal(result.messages[0].facts.subject, null); assert.equal(result.messages[0].facts.direction, 'incoming');
    const stored = JSON.stringify(await f.h.db.prepare('SELECT * FROM provider_gmail_index').all());
    for (const privateValue of ['BODY MUST NOT BE SAVED', 'PRIVATE ATTACHMENT', 'Optional fixture subject', 'owner@example.test']) assert.equal(stored.includes(privateValue), false);
    assert.deepEqual((await f.h.db.prepare('SELECT * FROM contacts').all()).results, contacts);
    assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM interactions').first())!.n, 0);
    assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM provider_gmail_pending').first())!.n, 0);
    assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM provider_gmail_pages').first())!.n, 0);
  } finally { await f.h.close(); }
});
test('messages arriving during a scan are retained before the exact history checkpoint advances', async () => {
  const f = await gmailFixture(); const original = Date.now; try {
    const now = original(); f.message('initial', { at: now - 1000 }); await f.save(); const started = await f.start();
    await f.advance(started.run.id); await f.advance(started.run.id);
    Date.now = () => now + 5000; f.message('arriving', { at: now + 1000 });
    f.histories.set('', { historyId: '9007199254740999', history: [{ id: '9007199254740997', messagesAdded: [{ message: { id: 'arriving', threadId: 'thread_arriving' } }] }] });
    assert.equal((await f.finish(started.run.id)).status, 'complete');
    assert.deepEqual((await f.review()).messages.map((message) => message.facts.id).sort(), ['arriving', 'initial']);
    assert.equal((await f.h.db.prepare('SELECT checkpoint FROM provider_gmail_resources').first())!.checkpoint, '9007199254740999');
  } finally { Date.now = original; await f.h.close(); }
});
test('incremental history reconciles current metadata and deletes while partial pages never advance the visible checkpoint', async () => {
  const f = await gmailFixture(); try {
    f.message('one'); f.message('deleted'); await f.save(); const full = await f.start(); await f.finish(full.run.id);
    const before = await f.review(); f.messages.delete('deleted'); f.message('two');
    f.histories.set('', { historyId: '9007199254741001', history: [{ id: '9007199254740995', messagesAdded: [{ message: { id: 'two', threadId: 'thread_two' } }] }], nextPageToken: 'page2' });
    f.histories.set('page2', { historyId: '9007199254741003', history: [{ id: '9007199254741000', messagesDeleted: [{ message: { id: 'deleted', threadId: 'thread_deleted' } }] }] });
    const run = await f.start('incremental'); await f.advance(run.run.id); await f.advance(run.run.id);
    assert.deepEqual(await f.review(), before); assert.equal((await f.h.db.prepare('SELECT checkpoint FROM provider_gmail_resources').first())!.checkpoint, '9007199254740993');
    assert.equal((await f.finish(run.run.id)).status, 'complete');
    assert.deepEqual((await f.review()).messages.map((item) => item.facts.id).sort(), ['one', 'two']);
    assert.equal((await f.h.db.prepare('SELECT checkpoint FROM provider_gmail_resources').first())!.checkpoint, '9007199254741003');
  } finally { await f.h.close(); }
});
test('expired history and retry failures preserve the old cache; cancellation and reconnect cannot publish late provider replies', async () => {
  const f = await gmailFixture(); try {
    f.message('one'); await f.save(); const full = await f.start(); await f.finish(full.run.id); const before = await f.review();
    f.histories.set('', 404); const incremental = await f.start('incremental'); const failed = await f.finish(incremental.run.id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.issue, 'history_repair_required'); assert.deepEqual(await f.review(), before);
    f.histories.delete(''); const next = await f.start(); await f.advance(next.run.id);
    f.setHook(async (url) => url.pathname.endsWith('/messages') ? Response.json({ error: {} }, { status: 429, headers: { 'Retry-After': '10' } }) : null);
    const retry = await f.advance(next.run.id); assert.equal(retry.status, 'active'); assert.equal(retry.issue, 'provider_retry'); assert.ok(retry.retry_at > Date.now()); assert.deepEqual(await f.review(), before);
    await f.h.gmailDownloads.cancelGmailDownload(f.h.db, f.actor, f.connection.id, next.run.id); f.setHook(undefined);
    const stopped = await f.advance(next.run.id); assert.equal(stopped.status, 'cancelled'); assert.deepEqual(await f.review(), before);
    const delayed = await f.start(); await f.advance(delayed.run.id); let release!: () => void, entered!: () => void;
    const began = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    f.setHook(async (url) => { if (!url.pathname.endsWith('/messages')) return null; entered(); await gate; return Response.json({ messages: [{ id: 'one', threadId: 'thread_one' }] }); });
    const pending = f.advance(delayed.run.id).then(() => null, (error: unknown) => error); await began;
    await f.h.gmailDownloads.cancelGmailDownload(f.h.db, f.actor, f.connection.id, delayed.run.id); release();
    assert.match(String(await pending), /CLOUD_RECOVERY_CONFLICT/); assert.deepEqual(await f.review(), before);
  } finally { await f.h.close(); }
});
test('changing retention/subject choices, revocation, owner loss and restore purge private projections and fence active downloads', async () => {
  for (const action of ['choices', 'disconnect', 'owner', 'restore'] as const) {
    const f = await gmailFixture(); try {
      f.message('one'); await f.save({ ...gmailChoices, retain_subject: true }); const full = await f.start(); await f.finish(full.run.id);
      assert.equal((await f.review()).messages[0].facts.subject, 'Optional fixture subject');
      if (action === 'choices') { await f.save(); assert.equal((await f.review()).messages.length, 0); }
      if (action === 'disconnect') await f.h.providers.disconnectGoogleConnection(f.h.db, f.actor, f.env, f.connection.id, 1, f.fetcher);
      if (action === 'owner') await f.h.db.prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = 'test' AND user_id = 'owner'").run();
      if (action === 'restore') {
        const backup = (await f.h.call('settings/backups', { method: 'POST' })).body.backup;
        const snapshot = (await f.h.call('settings/backups/' + backup.filename)).body;
        assert.equal(JSON.stringify(snapshot).includes('provider_gmail_'), false); assert.equal(JSON.stringify(snapshot).includes('Optional fixture subject'), false);
        assert.equal((await f.h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200);
      }
      assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM provider_gmail_index').first())!.n, 0);
      assert.equal((await f.h.db.prepare('SELECT COUNT(*) n FROM provider_gmail_pending').first())!.n, 0);
      if (action !== 'choices') await assert.rejects(f.review(), /Reconnect|owner/);
    } finally { await f.h.close(); }
  }
});
