import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { gmailChoices, gmailFixture } from './helpers/gmail-fixture.ts';
import type { GmailQueueMessage } from '../lib/cloud/google-gmail-jobs';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';

type Fixture = Awaited<ReturnType<typeof gmailFixture>>;
async function schedule(f: Fixture, enabled = true, interval = 86400, id = f.connection.id) {
  const source = (await f.h.gmailDownloads.reviewGmailSource(f.h.db, f.actor, id))!;
  return f.h.gmailDownloads.changeGmailSchedule(f.h.db, f.actor, f.env, id, { enabled, interval, expected_epoch: f.epoch,
    expected_authorization_revision: f.connection.authorization_revision, expected_settings_revision: source.settings_revision, expected_schedule_revision: source.schedule.revision });
}
function queueFor(f: Fixture) {
  const pending: GmailQueueMessage[] = [];
  let failSend = false;
  const queue = { async send(body: GmailQueueMessage) { if (failSend) throw new Error('Fixture queue outage'); pending.push(body); } };
  const env = { ...f.h.emailEnv, ...f.env, DB: f.h.db, GOOGLE_GMAIL_QUEUE: queue } as unknown as CloudflareEnv;
  async function deliver(body: unknown = pending.shift()) {
    const events: Array<string | number> = [];
    await f.h.gmailJobs.processGmailMessage({ body, attempts: 1, ack: () => { events.push('ack'); }, retry: (options) => { events.push(options?.delaySeconds ?? 0); } }, env, f.fetcher);
    return events;
  }
  async function drain() { for (let step = 0; pending.length && step < 100; step++) assert.deepEqual(await deliver(), ['ack']); assert.equal(pending.length, 0); }
  return { pending, queue, env, deliver, drain, setFailSend(value: boolean) { failSend = value; } };
}

test('Gmail recurring reads start off, require explicit current consent and publish bounded metadata without changing the CRM', async () => {
  const f = await gmailFixture(); try {
    f.message('one'); await f.save();
    await f.h.db.prepare("INSERT INTO contacts(workspace_id,name,email,notes) VALUES('test','Kept person','friend@example.test','Private correction')").run();
    const people = (await f.h.db.prepare('SELECT * FROM contacts').all()).results;
    const q = queueFor(f), calls = f.calls.length;
    assert.deepEqual((await f.h.gmailDownloads.reviewGmailSource(f.h.db, f.actor, f.connection.id))!.schedule,
      { enabled: false, interval: 86400, revision: 0, next_at: 0, repair_required: false });
    assert.deepEqual(await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env), { scheduled: 0, enqueued: 0, expired: 0 });
    assert.equal(f.calls.length, calls);
    await schedule(f); assert.equal(f.calls.length, calls, 'saving opt-in does not read Google');
    const tick = await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env);
    assert.equal(tick.scheduled, 1); assert.equal(tick.enqueued, 1);
    const run = (await f.h.db.prepare('SELECT * FROM provider_gmail_runs').first())!;
    assert.equal(run.schedule_revision, 1); assert.equal(run.mode, 'full');
    assert.equal((await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env)).scheduled, 0);
    await q.drain();
    assert.equal((await f.review()).messages.length, 1);
    assert.deepEqual((await f.h.db.prepare('SELECT * FROM contacts').all()).results, people);
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM interactions').first())!.n, 0);
    assert.equal((await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env)).scheduled, 0);
  } finally { await f.h.close(); }
});

test('disabling a schedule fences delayed reads, clears staging and rejects queued replays while preserving the published context', async () => {
  const f = await gmailFixture(); try {
    f.message('one'); await f.save(); const first = await f.start(); await f.finish(first.run.id); const before = await f.review();
    await schedule(f); const q = queueFor(f); await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env);
    const body = q.pending.shift()!;
    let release!: () => void, entered!: () => void;
    const began = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    f.setHook(async (url) => { if (!url.pathname.endsWith('/profile')) return null; entered(); await gate; return null; });
    const delivery = q.deliver(body); await began;
    const off = await schedule(f, false); assert.equal(off!.schedule.enabled, false); release();
    assert.deepEqual(await delivery, ['ack']); assert.deepEqual(await f.review(), before);
    const calls = f.calls.length; assert.deepEqual(await q.deliver(body), ['ack']); assert.equal(f.calls.length, calls);
    assert.equal((await f.h.db.prepare("SELECT count(*) n FROM provider_gmail_runs WHERE status='active'").first())!.n, 0);
    assert.equal((await f.h.db.prepare('SELECT count(*) n FROM provider_gmail_pending').first())!.n, 0);
    const manual = await f.start('incremental'); await schedule(f, true, 3600); await schedule(f, false, 3600);
    assert.equal((await f.finish(manual.run.id)).status, 'complete', 'a separate explicit manual download remains authorized');
  } finally { await f.h.close(); }
});

test('expired Gmail history schedules one bounded full repair and keeps the previous generation until atomic replacement', async () => {
  const f = await gmailFixture(); try {
    f.message('deleted'); await f.save(); const initial = await f.start(); await f.finish(initial.run.id); const before = await f.review();
    await schedule(f, true, 3600); const q = queueFor(f); await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env);
    f.histories.set('', 404); await q.drain();
    assert.deepEqual(await f.review(), before);
    const source = (await f.h.gmailDownloads.reviewGmailSource(f.h.db, f.actor, f.connection.id))!;
    assert.equal(source.schedule.repair_required, true); assert.equal(source.run!.issue, 'history_repair_required');
    f.messages.delete('deleted'); f.histories.clear(); f.setHistory('9007199254741009');
    const repair = await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env); assert.equal(repair.scheduled, 1);
    assert.equal((await f.h.gmailDownloads.reviewGmailSource(f.h.db, f.actor, f.connection.id))!.run!.mode, 'full');
    assert.deepEqual(await f.review(), before); await q.drain();
    assert.equal((await f.review()).messages.length, 0);
    assert.equal((await f.h.db.prepare('SELECT checkpoint FROM provider_gmail_resources').first())!.checkpoint, '9007199254741009');
    assert.equal((await f.h.gmailDownloads.reviewGmailSource(f.h.db, f.actor, f.connection.id))!.schedule.repair_required, false);
  } finally { await f.h.close(); }
});

test('a queue send outage retains its committed checkpoint and Cron resumes the next step without rereading the completed one', async () => {
  const f = await gmailFixture(); try {
    f.message('one'); await f.save(); await schedule(f); const q = queueFor(f); await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env);
    const body = q.pending.shift()!; q.setFailSend(true); await assert.rejects(q.deliver(body), /queue outage/);
    assert.equal((await f.h.db.prepare('SELECT phase FROM provider_gmail_runs WHERE id=?').bind(body.runId).first())!.phase, 'list');
    const profiles = f.calls.filter((call) => call.url.endsWith('/profile')).length;
    q.setFailSend(false); const recovered = await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env);
    assert.equal(recovered.scheduled, 0); assert.equal(recovered.enqueued, 1); assert.equal(q.pending[0].runId, body.runId);
    await q.drain(); assert.equal(f.calls.filter((call) => call.url.endsWith('/profile')).length, profiles);
    assert.equal((await f.review()).messages.length, 1);
  } finally { await f.h.close(); }
});

test('changed mailbox choices and revoked ownership discard automatic consent and queued deliveries', async () => {
  for (const change of ['choices', 'owner', 'grant', 'epoch'] as const) {
    const f = await gmailFixture(); try {
      await f.save(); await schedule(f); const q = queueFor(f); await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env); const body = q.pending.shift()!;
      if (change === 'choices') { const source = (await f.save({ ...gmailChoices, past_days: 30 }))!; assert.equal(source.schedule.enabled, false); assert.equal(source.schedule.next_at, 0); }
      else if (change === 'owner') await f.h.db.prepare("UPDATE workspace_members SET role='member' WHERE workspace_id='test' AND user_id='owner'").run();
      else if (change === 'grant') await f.h.db.prepare('UPDATE provider_connections SET authorization_revision=authorization_revision+1 WHERE id=?').bind(f.connection.id).run();
      else await f.h.db.prepare("UPDATE workspace_sync_state SET epoch=? WHERE workspace_id='test'").bind(crypto.randomUUID()).run();
      const calls = f.calls.length; assert.deepEqual(await q.deliver(body), ['ack']); assert.equal(f.calls.length, calls);
      assert.equal((await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env)).scheduled, 0);
    } finally { await f.h.close(); }
  }
});

test('Gmail retry deadlines, wrong-workspace deliveries and stale schedules cannot advance an unauthorized step', async () => {
  const f = await gmailFixture(); try {
    await f.save(); const enabled = (await schedule(f))!; const q = queueFor(f); await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env); const body = q.pending.shift()!;
    const calls = f.calls.length; assert.deepEqual(await q.deliver({ ...body, workspaceId: 'other' }), ['ack']);
    assert.deepEqual(await q.deliver({ ...body, token: 'must not be accepted' }), ['ack']); assert.equal(f.calls.length, calls);
    await f.h.db.prepare('UPDATE provider_gmail_runs SET retry_at=? WHERE id=?').bind(Date.now() + 60000, body.runId).run();
    const wait = await q.deliver(body); assert.equal(wait.length, 1); assert.ok(Number(wait[0]) > 0 && Number(wait[0]) <= 900); assert.equal(f.calls.length, calls);
    const request = { enabled: false, interval: 86400, expected_epoch: f.epoch, expected_authorization_revision: f.connection.authorization_revision, expected_settings_revision: enabled.settings_revision, expected_schedule_revision: 0 };
    await assert.rejects(f.h.gmailDownloads.changeGmailSchedule(f.h.db, f.actor, f.env, f.connection.id, request), /Refresh/);
    await assert.rejects(f.h.gmailDownloads.changeGmailSchedule(f.h.db, { ...f.actor, authMethod: 'device' }, f.env, f.connection.id, { ...request, expected_schedule_revision: 1 }), /browser|owner|web/i);
    assert.equal((await f.h.gmailDownloads.reviewGmailSource(f.h.db, f.actor, f.connection.id))!.schedule.enabled, true);
  } finally { await f.h.close(); }
});

test('Gmail schedule routes are exact and no-store, reject foreign origins and compare reviewed revisions', async () => {
  const f = await gmailFixture(); try {
    await f.save(); const base = '/api/connections/' + f.connection.id + '/gmail/schedule';
    assert.equal(getCloudApiRewrite(base), base.replace('/api/', '/api/cloud/')); assert.equal(getCloudApiRewrite(base + '/extra'), null);
    const body = { enabled: true, interval: 86400, expected_epoch: f.epoch, expected_authorization_revision: 1, expected_settings_revision: 1, expected_schedule_revision: 0 };
    const call = (value: unknown, origin = f.env.BETTER_AUTH_URL) => f.h.providerApi.handleProviderConnections(new Request(f.env.BETTER_AUTH_URL + base,
      { method: 'PATCH', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value) }), f.actor, base.slice(5).split('/'));
    assert.equal((await call(body, 'https://attacker.invalid')).status, 403);
    assert.equal((await call({ ...body, interval: 60 })).status, 409);
    const result = await call(body); assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await call(body)).status, 409);
    assert.equal((await call({ ...body, expected_schedule_revision: 1, extra: true })).status, 409);
  } finally { await f.h.close(); }
});

test('Gmail schedule cancellation rolls back the policy, lease and run together when its transaction fails', async () => {
  const f = await gmailFixture(); try {
    await f.save(); await schedule(f); const q = queueFor(f); await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env);
    const before = await f.h.gmailDownloads.reviewGmailSource(f.h.db, f.actor, f.connection.id);
    await f.h.db.prepare("CREATE TRIGGER fixture_cancel_failure BEFORE UPDATE OF status ON provider_gmail_runs WHEN NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'FIXTURE_CANCEL_FAULT'); END").run();
    await assert.rejects(schedule(f, false), /FIXTURE_CANCEL_FAULT/);
    assert.deepEqual(await f.h.gmailDownloads.reviewGmailSource(f.h.db, f.actor, f.connection.id), before);
    await f.h.db.prepare('DROP TRIGGER fixture_cancel_failure').run(); await schedule(f, false);
    const calls = f.calls.length; await q.drain(); assert.equal(f.calls.length, calls);
  } finally { await f.h.close(); }
});

test('Gmail maintenance starts and dispatches at most five accounts, rotates ties fairly and releases expired runs', async () => {
  const f = await gmailFixture(); try {
    await f.save(); await schedule(f);
    for (let index = 0; index < 6; index++) {
      const id = crypto.randomUUID();
      await f.h.db.prepare(`INSERT INTO provider_connections(id,workspace_id,user_id,provider,purpose,account_id,email,display_name,granted_scopes,status,dataset_epoch,credentials,revision,created_at,updated_at)
        SELECT ?,workspace_id,user_id,provider,purpose,?,email,display_name,granted_scopes,status,dataset_epoch,credentials,revision,created_at,updated_at FROM provider_connections WHERE id=?`)
        .bind(id, 'budget-fixture-' + index, f.connection.id).run();
      await f.h.db.prepare(`INSERT INTO provider_gmail_resources(connection_id,workspace_id,user_id,dataset_epoch,authorization_revision,choices)
        SELECT ?,workspace_id,user_id,dataset_epoch,authorization_revision,choices FROM provider_gmail_resources WHERE connection_id=?`).bind(id, f.connection.id).run();
      await schedule(f, true, 86400, id);
    }
    const q = queueFor(f), calls = f.calls.length;
    for (let tick = 0; tick < 3; tick++) {
      const result = await f.h.gmailJobs.reconcileGmailDownloads(f.h.db, q.queue, f.env);
      assert.ok(result.scheduled <= 5); assert.ok(result.enqueued <= 5);
    }
    assert.equal(new Set(q.pending.map((body) => body.connectionId)).size, 7);
    assert.equal((await f.h.db.prepare("SELECT count(*) n FROM provider_gmail_runs WHERE status='active'").first())!.n, 7);
    assert.equal(f.calls.length, calls, 'dispatch and recovery do not fetch provider data');
    const source = q.pending[0];
    // A future maintenance clock expires the actual runs; old deliveries must
    // then be ignored without fetching another provider page.
    await f.h.gmailDownloads.pruneGmailCache(f.h.db, Date.now() + 3600001);
    assert.deepEqual(await q.deliver(source), ['ack']); assert.equal(f.calls.length, calls);
    assert.equal((await f.h.db.prepare("SELECT count(*) n FROM provider_gmail_runs WHERE status='active'").first())!.n, 0);
  } finally { await f.h.close(); }
});

test('migration 48 preserves all existing fields and starts old Gmail grants, caches and frozen runs with automatic checks off', () => {
  const db = new Database(':memory:'); try {
    db.pragma('foreign_keys=ON'); const directory = new URL('../drizzle/', import.meta.url);
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '0048_').sort()) db.exec(readFileSync(new URL(name, directory), 'utf8'));
    db.exec("INSERT INTO workspaces(id,name) VALUES('kept','Kept'); INSERT INTO contacts(workspace_id,name,email,notes) VALUES('kept','Person','friend@example.test','Private correction'); INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('owner','Owner','owner@example.test',1,1,1); INSERT INTO workspace_members(workspace_id,user_id,role) VALUES('kept','owner','owner');");
    const epoch = (db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id='kept'").get() as { epoch: string }).epoch;
    const connection = crypto.randomUUID(), generation = crypto.randomUUID(), run = crypto.randomUUID(), now = Date.now();
    db.prepare("INSERT INTO provider_connections(id,workspace_id,user_id,provider,purpose,account_id,email,display_name,granted_scopes,status,dataset_epoch,credentials,revision,created_at,updated_at) VALUES(?,'kept','owner','google','gmail','subject','owner@example.test','Kept','[]','connected',?,'unchanged-ciphertext',7,'2026-10-03','2026-10-03')").run(connection, epoch);
    db.prepare("INSERT INTO provider_gmail_resources(connection_id,workspace_id,user_id,dataset_epoch,authorization_revision,choices) VALUES(?,'kept','owner',?,1,?)").run(connection, epoch, JSON.stringify(gmailChoices));
    db.prepare("INSERT INTO provider_gmail_runs(id,connection_id,workspace_id,user_id,dataset_epoch,authorization_revision,settings_revision,fingerprint,generation,mode,window_start,window_end,created_at,updated_at) VALUES(?,?,'kept','owner',?,1,1,'frozen-request',?,'full',?,?,?,?)").run(run, connection, epoch, generation, now - 90 * 86400000, now, new Date(now).toISOString(), new Date(now).toISOString());
    const facts = { id: 'kept', thread_id: 'kept_thread', received_at: now - 1000, direction: 'incoming', participants: [{ email: 'friend@example.test', roles: ['from'] }], participants_incomplete: false, subject: null, message_id: null };
    db.prepare('INSERT INTO provider_gmail_index(connection_id,generation,message_id,received_at,observed_at,facts) VALUES(?,?,?,?,?,?)').run(connection, generation, facts.id, facts.received_at, now, JSON.stringify(facts));
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => ({ name, columns: (db.prepare('PRAGMA table_info("' + name + '")').all() as Array<{ name: string }>).map(({ name }) => name) }));
    const snapshot = () => tables.map(({ name, columns }) => ({ name, rows: db.prepare('SELECT ' + columns.map((column) => '"' + column + '"').join(',') + ' FROM "' + name + '"').all() }));
    const before = snapshot(); db.exec(readFileSync(new URL('0048_gmail_recurring.sql', directory), 'utf8')); assert.deepEqual(snapshot(), before);
    assert.deepEqual(db.prepare('SELECT sync_enabled,sync_interval,sync_revision,next_sync_at,repair_required FROM provider_gmail_resources').get(), { sync_enabled: 0, sync_interval: 86400, sync_revision: 0, next_sync_at: 0, repair_required: 0 });
    assert.deepEqual(db.prepare('SELECT schedule_revision FROM provider_gmail_runs').get(), { schedule_revision: null });
    assert.deepEqual(db.pragma('foreign_key_check'), []); assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally { db.close(); }
});
