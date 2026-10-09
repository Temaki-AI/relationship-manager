import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { gmailFixture, gmailChoices } from './helpers/gmail-fixture.ts';
import { gmailMatchStatus } from '../packages/domain/src/gmail-matching.ts';
import { readContactMethods } from '../packages/domain/src/contact-methods.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';

type Fixture = Awaited<ReturnType<typeof gmailFixture>>;
async function person(f: Fixture, email = 'friend@example.test', name = 'Friend', workspace = 'test') {
  const publicId = crypto.randomUUID();
  await f.h.db.prepare('INSERT INTO contacts(workspace_id,public_id,name,email,notes) VALUES(?,?,?,?,?)').bind(workspace, publicId, name, email, 'Private original note').run();
  return (await f.h.db.prepare('SELECT id,public_id,name FROM contacts WHERE workspace_id=? AND public_id=?').bind(workspace, publicId).first<{ id: number; public_id: string; name: string }>())!;
}
async function prepare(f: Fixture) {
  for (let count = 0; count < 100; count++) { const state = await f.h.gmailMatching.prepareGmailMatching(f.h.db, f.actor, f.connection.id); if (state.directory_ready) return state; }
  throw new Error('Contact index did not become ready within its bound');
}
const review = (f: Fixture, query = new URLSearchParams()) => f.h.gmailMatching.reviewGmailMatches(f.h.db, f.actor, f.connection.id, query);
async function downloaded(f: Fixture) { await f.save(); const started = await f.start(); await f.finish(started.run.id); }
async function decision(f: Fixture, email: string, action: 'link' | 'exclude' | 'clear', target: string | null = null) {
  const snapshot = await review(f);
  return { operation_id: crypto.randomUUID(), action, email, target_public_id: target, expected_epoch: snapshot.epoch,
    expected_authorization_revision: snapshot.authorization_revision, expected_settings_revision: snapshot.settings_revision,
    expected_generation: snapshot.generation!, expected_directory_revision: snapshot.directory_revision, expected_matching_revision: snapshot.matching_revision };
}
const decide = (f: Fixture, body: Awaited<ReturnType<typeof decision>>) => f.h.gmailMatching.decideGmailMatch(f.h.db, f.actor, f.connection.id, body);
const context = (f: Fixture, id: string, query = new URLSearchParams()) => f.h.gmailMatching.reviewGmailPersonContext(f.h.db, f.actor, f.connection.id, id, query);

test('reviewed Gmail matching requires explicit decisions and preserves people, notes and confirmed activity', async () => {
  const f = await gmailFixture(); try {
    const p = await person(f); f.message('one'); f.message('self', { from: 'owner@example.test' }); f.message('bulk', { headers: [{ name: 'List-Id', value: '<bulk.test>' }] });
    const people = (await f.h.db.prepare('SELECT * FROM contacts').all()).results;
    const history = (await f.h.db.prepare('SELECT * FROM interactions').all()).results;
    await downloaded(f); assert.equal((await f.h.gmailDirectory.gmailDirectoryState(f.h.db, f.actor)).ready, false);
    assert.equal((await review(f)).directory_ready, true);
    const r = await review(f); assert.equal(r.correspondents.length, 1); assert.equal(r.correspondents[0].status, 'suggested'); assert.equal(r.correspondents[0].messages, 1);
    assert.equal((await context(f, p.public_id)).messages.length, 0);
    const receipt = await decide(f, await decision(f, 'friend@example.test', 'link', p.public_id));
    assert.equal(receipt.action, 'link'); assert.equal((await review(f)).correspondents[0].status, 'linked');
    const saved = await context(f, p.public_id); assert.equal(saved.messages.length, 1); assert.deepEqual(saved.messages[0].linked_addresses, ['friend@example.test']);
    assert.equal(saved.messages[0].facts.subject, null); assert.equal(JSON.stringify(saved).includes('BODY MUST NOT BE SAVED'), false);
    assert.deepEqual((await f.h.db.prepare('SELECT * FROM contacts').all()).results, people);
    assert.deepEqual((await f.h.db.prepare('SELECT * FROM interactions').all()).results, history);
  } finally { await f.h.close(); }
});

test('contacts created later find retained metadata without rereading Gmail and unknown senders require review-inbox mode', async () => {
  const f = await gmailFixture(); try {
    f.message('before-person', { from: 'NEW@EXAMPLE.TEST' }); await downloaded(f); await prepare(f);
    assert.equal((await review(f)).correspondents.length, 0);
    const calls = f.calls.length, p = await person(f, 'new@example.test', 'Created later');
    assert.equal((await f.h.gmailDirectory.gmailDirectoryState(f.h.db, f.actor)).ready, false);
    // The next ordinary cache review reconciles the new person's email, without
    // a provider read or a separate manual index step for this bounded change.
    assert.equal((await review(f)).correspondents[0].status, 'suggested');
    await decide(f, await decision(f, 'new@example.test', 'link', p.public_id)); assert.equal((await context(f, p.public_id)).messages[0].facts.id, 'before-person');
    assert.equal(f.calls.length, calls);
    await f.save({ ...gmailChoices, mode: 'review_inbox' }); const full = await f.start(); await f.finish(full.run.id);
    f.message('unknown', { from: 'unknown@example.test' }); const refresh = await f.start(); await f.finish(refresh.run.id);
    assert.equal((await review(f)).correspondents.find((row) => row.email === 'unknown@example.test')?.status, 'unmatched');
    await decide(f, await decision(f, 'unknown@example.test', 'exclude')); assert.equal((await review(f)).correspondents.find((row) => row.email === 'unknown@example.test')?.status, 'excluded');
    const people = (await f.h.db.prepare('SELECT count(*) n FROM contacts').first())!.n; assert.equal(people, 1);
  } finally { await f.h.close(); }
});

test('shared addresses never attach automatically, changed candidates suspend reviewed context, and explicit reset preserves exact retries', async () => {
  const f = await gmailFixture(); try {
    const one = await person(f), two = await person(f, 'friend@example.test', 'Second'); f.message('one'); await downloaded(f); await prepare(f);
    assert.equal((await review(f)).correspondents[0].status, 'ambiguous'); assert.equal((await context(f, one.public_id)).messages.length, 0);
    const link = await decision(f, 'friend@example.test', 'link', one.public_id); const saved = await decide(f, link);
    assert.equal((await context(f, one.public_id)).messages.length, 1); assert.equal((await context(f, two.public_id)).messages.length, 0);
    const three = await person(f, 'friend@example.test', 'Third'); await prepare(f);
    assert.equal((await review(f)).correspondents[0].status, 'needs_review'); assert.equal((await context(f, one.public_id)).messages.length, 0);
    assert.deepEqual(await decide(f, link), saved);
    const exclude = await decision(f, 'friend@example.test', 'exclude'); await decide(f, exclude);
    assert.equal((await review(f)).correspondents[0].status, 'excluded');
    assert.deepEqual(await decide(f, link), saved); assert.equal((await review(f)).correspondents[0].status, 'excluded');
    await assert.rejects(decide(f, { ...link, target_public_id: three.public_id }), /different choice/);
    await decide(f, await decision(f, 'friend@example.test', 'clear')); assert.equal((await review(f)).correspondents[0].status, 'ambiguous');
    await f.h.db.prepare('DELETE FROM contacts WHERE public_id=?').bind(three.public_id).run(); await prepare(f);
  } finally { await f.h.close(); }
});

test('email methods preserve Unicode normalization and plus/dot identity; removed methods immediately hold context', async () => {
  const f = await gmailFixture(); try {
    const p = await person(f, 'other@example.test');
    const method = { id: crypto.randomUUID(), kind: 'email', value: 'ÉLISE+FAMILY@EXAMPLE.TEST', label: 'Family', country: null, preferred: false };
    // Real contact-method API supplies the established metadata shape.
    const current = (await f.h.call('contacts/' + p.id)).body.contact;
    const updated = await f.h.call('contacts/' + p.id, { method: 'PATCH', body: { contact_methods: [...readContactMethods(current.contact_methods), method], expected_edit_revision: current.edit_revision } });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    f.message('unicode', { from: 'e\u0301lise+family@example.test' }); f.message('different', { from: 'élise@example.test' }); await downloaded(f); await prepare(f);
    const r = await review(f); assert.equal(r.correspondents.length, 1); assert.equal(r.correspondents[0].email, 'élise+family@example.test');
    await decide(f, await decision(f, r.correspondents[0].email, 'link', p.public_id)); assert.equal((await context(f, p.public_id)).messages.length, 1);
    await f.h.db.prepare("UPDATE contacts SET email='changed@example.test',contact_methods='[]' WHERE public_id=?").bind(p.public_id).run();
    assert.equal((await context(f, p.public_id)).directory_ready, true); await prepare(f);
    assert.equal((await review(f)).correspondents[0].status, 'needs_review'); assert.equal((await context(f, p.public_id)).messages.length, 0);
  } finally { await f.h.close(); }
});

test('genuine merges resolve reviewed identities while deleted or unrelated people cannot inherit context', async () => {
  const f = await gmailFixture(); try {
    const old = await person(f), survivor = await person(f, 'friend@example.test', 'Survivor'); f.message('one'); await downloaded(f); await prepare(f);
    await decide(f, await decision(f, 'friend@example.test', 'link', old.public_id));
    await f.h.db.prepare('DELETE FROM contacts WHERE public_id=?').bind(old.public_id).run();
    await f.h.db.prepare('UPDATE contacts SET merge_aliases=? WHERE public_id=?').bind(JSON.stringify([old.public_id]), survivor.public_id).run(); await prepare(f);
    assert.equal((await review(f)).correspondents[0].status, 'linked'); assert.equal((await context(f, old.public_id)).person.public_id, survivor.public_id);
    assert.equal((await context(f, survivor.public_id)).messages.length, 1);
    await f.h.db.prepare('DELETE FROM contacts WHERE public_id=?').bind(survivor.public_id).run(); const recycled = await person(f, 'friend@example.test', 'Unrelated'); await prepare(f);
    assert.equal((await review(f)).correspondents[0].status, 'needs_review'); assert.equal((await context(f, recycled.public_id)).messages.length, 0);
  } finally { await f.h.close(); }
});

test('review and person context page with generation and candidate/rule revisions; replaced generations reject old cursors', async () => {
  const f = await gmailFixture(); try {
    const p = await person(f); const at = Date.now() - 1000;
    for (let n = 0; n < 55; n++) f.message('same_' + String(n).padStart(2, '0'), { at });
    await downloaded(f); await prepare(f); await decide(f, await decision(f, 'friend@example.test', 'link', p.public_id));
    const first = await context(f, p.public_id); assert.equal(first.messages.length, 50); assert.equal(first.more, true);
    const query = new URLSearchParams({ generation: first.generation!, directory_revision: String(first.directory_revision), matching_revision: String(first.matching_revision), after: first.next! });
    const second = await context(f, p.public_id, query); assert.equal(second.messages.length, 5); assert.equal(second.more, false);
    assert.equal(new Set([...first.messages, ...second.messages].map((row) => row.facts.id)).size, 55);
    for (const bad of ['after=bad', 'generation=bad', 'token=secret', 'matching_revision=0&matching_revision=0']) await assert.rejects(review(f, new URLSearchParams(bad)), /changed/);
    const refresh = await f.start('incremental'); await f.finish(refresh.run.id); await assert.rejects(context(f, p.public_id, query), /changed/);
    assert.equal((await context(f, p.public_id)).messages.length, 50);
  } finally { await f.h.close(); }
});

test('matching fences late reads and mutations against changed methods, owners, grants and restore epochs', async () => {
  for (const change of ['methods', 'owner', 'authorization', 'epoch'] as const) {
    const f = await gmailFixture(); try {
      const p = await person(f); f.message('one'); await downloaded(f); await prepare(f);
      const body = await decision(f, 'friend@example.test', 'link', p.public_id);
      let changed = false;
      const db = new Proxy(f.h.db, { get(target, key) {
        if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
          // Directory-state reads complete their own guard first. Race the final matching guard.
          if (!changed && args[0].length > 2) {
            changed = true;
            if (change === 'methods') await target.prepare("UPDATE contacts SET email='new@example.test' WHERE public_id=?").bind(p.public_id).run();
            else if (change === 'owner') await target.prepare("UPDATE workspace_members SET role='member' WHERE workspace_id='test' AND user_id='owner'").run();
            else if (change === 'authorization') await target.prepare('UPDATE provider_connections SET authorization_revision=authorization_revision+1 WHERE id=?').bind(f.connection.id).run();
            else await target.prepare("UPDATE workspace_sync_state SET epoch=? WHERE workspace_id='test'").bind(crypto.randomUUID()).run();
          }
          return target.batch(...args);
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await assert.rejects(f.h.gmailMatching.decideGmailMatch(db, f.actor, f.connection.id, body), /CLOUD_RECOVERY_CONFLICT/);
      assert.equal(changed, true); assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_match_rules').first())!.n, 0);
      assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_match_receipts').first())!.n, 0);
    } finally { await f.h.close(); }
  }
});

test('atomic review receipts roll back on a fault and authorization/settings changes erase private matching state', async () => {
  const f = await gmailFixture(); try {
    const p = await person(f); f.message('one'); await downloaded(f); await prepare(f);
    const body = await decision(f, 'friend@example.test', 'link', p.public_id);
    await f.h.db.prepare("CREATE TRIGGER fixture_match_receipt BEFORE INSERT ON provider_gmail_match_receipts BEGIN SELECT RAISE(ABORT,'FIXTURE_MATCH'); END").run();
    await assert.rejects(decide(f, body), /FIXTURE_MATCH/); assert.equal((await review(f)).matching_revision, 0); assert.equal((await review(f)).correspondents[0].status, 'suggested');
    await f.h.db.prepare('DROP TRIGGER fixture_match_receipt').run(); await decide(f, body);
    await f.save({ ...gmailChoices, past_days: 30 });
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_match_rules').first())!.n, 0);
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_match_receipts').first())!.n, 0); await assert.rejects(decide(f, body), /changed/);
    const full = await f.start(); await f.finish(full.run.id); await decide(f, await decision(f, 'friend@example.test', 'link', p.public_id));
    await f.h.db.prepare('UPDATE provider_connections SET authorization_revision=authorization_revision+1 WHERE id=?').bind(f.connection.id).run();
    for (const table of ['participants', 'matching', 'match_rules', 'match_receipts']) assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_' + table).first())!.n, 0);
  } finally { await f.h.close(); }
});

test('cached matching replies are suppressed when ownership changes after candidate reads', async () => {
  for (const read of ['matches', 'person'] as const) {
    const f = await gmailFixture(); try {
      const p = await person(f); f.message('one'); await downloaded(f); await prepare(f);
      await decide(f, await decision(f, 'friend@example.test', 'link', p.public_id));
      let guards = 0;
      const db = new Proxy(f.h.db, { get(target, key) {
        if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
          if (++guards === 2) await target.prepare("UPDATE workspace_members SET role='member' WHERE workspace_id='test' AND user_id='owner'").run();
          return target.batch(...args);
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await assert.rejects(read === 'matches' ? f.h.gmailMatching.reviewGmailMatches(db, f.actor, f.connection.id)
        : f.h.gmailMatching.reviewGmailPersonContext(db, f.actor, f.connection.id, p.public_id), /CLOUD_RECOVERY_CONFLICT/);
      assert.equal(guards, 2);
    } finally { await f.h.close(); }
  }
});

test('correspondent pages are bounded and stale candidate revisions cannot attach foreign people or expired metadata', async () => {
  const f = await gmailFixture(); try {
    const foreign = await person(f, 'sender00@example.test', 'Foreign', 'other');
    for (let n = 0; n < 55; n++) f.message('sender_' + n, { from: 'sender' + String(n).padStart(2, '0') + '@example.test' });
    await f.save({ ...gmailChoices, mode: 'review_inbox' }); const full = await f.start(); await f.finish(full.run.id); await prepare(f);
    const first = await review(f); assert.equal(first.correspondents.length, 50); assert.equal(first.more, true);
    const query = new URLSearchParams({ generation: first.generation!, directory_revision: String(first.directory_revision), matching_revision: String(first.matching_revision), after: first.next! });
    assert.equal((await review(f, query)).correspondents.length, 5); assert.equal(first.correspondents[0].candidates.length, 0);
    await assert.rejects(decide(f, await decision(f, 'sender00@example.test', 'link', foreign.public_id)), /current person/);
    const own = await person(f, 'sender00@example.test'); await prepare(f); await assert.rejects(review(f, query), /changed/);
    const stale = await decision(f, 'sender00@example.test', 'link', own.public_id);
    await person(f, 'sender00@example.test', 'New shared address'); await prepare(f);
    await assert.rejects(decide(f, stale), /changed/);
    await decide(f, await decision(f, 'sender00@example.test', 'link', own.public_id));
    const expired = await decision(f, 'sender00@example.test', 'exclude');
    await f.h.gmailDownloads.pruneGmailCache(f.h.db, Date.now() + 91 * 86400000);
    await assert.rejects(decide(f, expired), /changed/);
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_match_rules').first())!.n, 0);
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_match_receipts').first())!.n, 0);
  } finally { await f.h.close(); }
});

test('matching routes are exact, same-origin, no-store and available only to the web owner', async () => {
  const f = await gmailFixture(); try {
    const p = await person(f); f.message('one'); await downloaded(f); await prepare(f);
    const base = '/api/connections/' + f.connection.id + '/gmail';
    for (const suffix of ['/matches', '/matches/directory', '/people/' + p.public_id]) assert.equal(getCloudApiRewrite(base + suffix), (base + suffix).replace('/api/', '/api/cloud/'));
    for (const suffix of ['/matches/more', '/matches/directory/extra', '/people/no-id', '/people/' + p.public_id + '/attachments']) assert.equal(getCloudApiRewrite(base + suffix), null);
    async function api(suffix: string, method: string, body?: unknown, origin = f.env.BETTER_AUTH_URL, actor = f.actor) {
      return f.h.providerApi.handleProviderConnections(new Request(f.env.BETTER_AUTH_URL + base + suffix, { method,
        headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), actor, (base + suffix).split('?')[0].slice(5).split('/'));
    }
    const r = await api('/matches', 'GET'); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal((await api('/people/' + p.public_id, 'GET')).status, 200);
    assert.equal((await api('/matches/directory', 'POST', {})).status, 200);
    const body = await decision(f, 'friend@example.test', 'link', p.public_id);
    assert.equal((await api('/matches', 'POST', body, 'https://attacker.invalid')).status, 403);
    assert.equal((await api('/matches?token=private', 'POST', body)).status, 400);
    assert.equal((await api('/matches', 'POST', { ...body, extra: true })).status, 409);
    assert.equal((await api('/matches', 'POST', body)).status, 200);
    assert.equal((await api('/matches', 'GET', undefined, f.env.BETTER_AUTH_URL, { ...f.actor, userId: 'second' })).status, 403);
    assert.equal((await api('/matches', 'GET', undefined, f.env.BETTER_AUTH_URL, { ...f.actor, authMethod: 'device' as 'web' })).status, 403);
  } finally { await f.h.close(); }
});

test('large contact indexes progress in bounded batches and shared-address overflow never selects a hidden candidate', async () => {
  const f = await gmailFixture(); try {
    const rows = Array.from({ length: 201 }, (_, n) => ({ id: crypto.randomUUID(), name: 'Person ' + n }));
    await f.h.db.prepare("INSERT INTO contacts(workspace_id,public_id,name,email) SELECT 'test',json_extract(value,'$.id'),json_extract(value,'$.name'),'friend@example.test' FROM json_each(?)").bind(JSON.stringify(rows)).run();
    f.message('one'); await downloaded(f);
    const first = await f.h.gmailMatching.prepareGmailMatching(f.h.db, f.actor, f.connection.id); assert.equal(first.directory_ready, false);
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM gmail_contact_directory_entries').first())!.n, 100);
    await prepare(f); const r = await review(f); assert.equal(r.correspondents[0].candidates.length, 20); assert.equal(r.correspondents[0].candidates_more, true);
    assert.equal(r.correspondents[0].status, 'ambiguous'); await assert.rejects(decide(f, await decision(f, 'friend@example.test', 'link', rows[0].id)), /twenty/);
    await f.h.db.prepare("DELETE FROM workspaces WHERE id='test'").run();
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM gmail_contact_directory_entries').first())!.n, 0);
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM gmail_contact_directory_pending').first())!.n, 0);
  } finally { await f.h.close(); }
});

test('match status needs complete candidate evidence and follows merge aliases without inventing a person', () => {
  const candidate = { public_id: crypto.randomUUID(), id: 1, name: 'One' };
  assert.equal(gmailMatchStatus([candidate], false, null), 'suggested'); assert.equal(gmailMatchStatus([], false, null), 'unmatched');
  assert.equal(gmailMatchStatus([candidate], false, { action: 'link', target: candidate.public_id, basis: [candidate.public_id, candidate.public_id] }), 'linked');
  assert.equal(gmailMatchStatus([candidate], false, { action: 'link', target: candidate.public_id, basis: [null] }), 'needs_review');
  assert.equal(gmailMatchStatus([candidate], true, { action: 'link', target: candidate.public_id, basis: [candidate.public_id] }), 'needs_review');
});

test('migration 47 preserves all previous CRM/source fields while backfilling only the derived matching index', () => {
  const db = new Database(':memory:'); try {
    db.pragma('foreign_keys=ON'); const directory = new URL('../drizzle/', import.meta.url);
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '0047_').sort()) db.exec(readFileSync(new URL(name, directory), 'utf8'));
    db.exec("INSERT INTO workspaces(id,name) VALUES('kept','Kept'); INSERT INTO contacts(workspace_id,name,email,notes) VALUES('kept','Person','friend@example.test','Private note');");
    db.exec("INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('owner','Owner','owner@example.test',1,1,1); INSERT INTO workspace_members(workspace_id,user_id,role) VALUES('kept','owner','owner');");
    const epoch = (db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id='kept'").get() as { epoch: string }).epoch;
    const connection = crypto.randomUUID(), generation = crypto.randomUUID(), run = crypto.randomUUID(), now = Date.now();
    db.prepare("INSERT INTO provider_connections(id,workspace_id,user_id,provider,purpose,account_id,email,display_name,granted_scopes,status,dataset_epoch,credentials,revision,created_at,updated_at) VALUES(?,'kept','owner','google','gmail','subject','owner@example.test','Original mailbox','[]','connected',?,'unchanged-fixture-ciphertext',7,'2026-10-03','2026-10-03')").run(connection, epoch);
    db.prepare("INSERT INTO provider_gmail_resources(connection_id,workspace_id,user_id,dataset_epoch,authorization_revision,choices) VALUES(?,'kept','owner',?,1,?)").run(connection, epoch, JSON.stringify(gmailChoices));
    db.prepare("INSERT INTO provider_gmail_runs(id,connection_id,workspace_id,user_id,dataset_epoch,authorization_revision,settings_revision,fingerprint,generation,mode,window_start,window_end,created_at,updated_at) VALUES(?,?,'kept','owner',?,1,1,'frozen',?,'full',?,?,?,?)").run(run, connection, epoch, generation, now - 90 * 86400000, now, new Date(now).toISOString(), new Date(now).toISOString());
    const facts = { id: 'kept_message', thread_id: 'kept_thread', received_at: now - 1000, direction: 'incoming', participants: [{ email: 'friend@example.test', roles: ['from'] }], participants_incomplete: false, subject: null, message_id: null };
    db.prepare('INSERT INTO provider_gmail_index(connection_id,generation,message_id,received_at,observed_at,facts) VALUES(?,?,?,?,?,?)').run(connection, generation, facts.id, facts.received_at, now, JSON.stringify(facts));
    db.prepare("UPDATE provider_gmail_runs SET status='complete' WHERE id=?").run(run);
    db.prepare("UPDATE provider_gmail_resources SET active_generation=?,checkpoint='9007199254740993',coverage='scanned' WHERE connection_id=?").run(generation, connection);
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    const before = tables.map((name) => ({ name, rows: db.prepare('SELECT * FROM "' + name + '"').all() }));
    db.exec(readFileSync(new URL('0047_gmail_matching.sql', directory), 'utf8'));
    assert.deepEqual(tables.map((name) => ({ name, rows: db.prepare('SELECT * FROM "' + name + '"').all() })), before);
    assert.equal((db.prepare('SELECT count(*) n FROM gmail_contact_directory').get() as { n: number }).n,
      (db.prepare('SELECT count(*) n FROM workspaces').get() as { n: number }).n);
    assert.deepEqual(db.prepare('SELECT email,roles,received_at FROM provider_gmail_participants').all(), [{ email: 'friend@example.test', roles: '["from"]', received_at: facts.received_at }]);
    assert.equal((db.prepare('SELECT revision FROM provider_gmail_matching').get() as { revision: number }).revision, 0);
    assert.equal((db.prepare('SELECT count(*) n FROM provider_gmail_match_rules').get() as { n: number }).n, 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []); assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally { db.close(); }
});
