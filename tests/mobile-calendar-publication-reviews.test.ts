import assert from 'node:assert/strict';
import test from 'node:test';
import { mobileCalendarPublicationFixture } from './helpers/mobile-calendar-publication-fixture.ts';

test('fresh legacy verification shares only its marker/status and adopts one publication through actual authenticated routing', async () => {
  const f = await mobileCalendarPublicationFixture(); try {
    assert.equal((await f.review()).publication, null); const original = (await f.review()).receipt!;
    const queued = await f.queue(); assert.equal(queued.attempted, 0); assert.equal(queued.status, 'pending');
    const body = JSON.parse(queued.request_json); assert.equal(body.receipt_id, original.id); assert.equal(body.expected_reservation_revision, null);
    assert.ok(!/PRIVATE|private-apple|Coffee|Cafe/.test(queued.request_json));
    const facts = (await f.review()).receipt!.facts, core = f.phone.sqlite.prepare('SELECT * FROM sync_queue').all();
    assert.equal((await f.sync()).confirmed, 1); assert.equal((await f.review()).publicationReview!.status, 'confirmed');
    const shared = await f.cloud.db.prepare('SELECT * FROM calendar_publication_reservations WHERE id = ?').bind(original.id).first();
    assert.equal(shared!.status, 'saved'); assert.equal(shared!.attempted, 1); assert.equal(f.creates, 1); assert.equal(f.gets, 1);
    assert.equal((await f.review()).receipt!.facts, facts); assert.deepEqual(f.phone.sqlite.prepare('SELECT * FROM sync_queue').all(), core);
    assert.equal((await f.review()).plan!.notes, 'PRIVATE PLAN');
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM interactions').first<{ n: number }>())!.n, 0);
    await f.restart(); await assert.rejects(f.phone.appleCalendar.openAppleCalendarEditor(f.phone.db, f.account, original.id, (await f.review()).receipt!.revision, f.adapter, () => true, f.transport), /already attempted/);
    assert.equal((await f.review()).publicationReview!.request_json, queued.request_json);
  } finally { await f.close(); }
});

test('an unknown verification reply replays exactly after restart and does not reread or recreate Calendar or overwrite a later private edit', async () => {
  const f = await mobileCalendarPublicationFixture(); try {
    const queued = await f.queue(); let lose = true;
    const transport: typeof fetch = async (input, init) => {
      const response = await f.transport(input, init); if (init?.method === 'POST' && lose) { lose = false; throw new Error('lost reply'); } return response;
    };
    await assert.rejects(f.sync(transport), /Reconnect/); assert.equal((await f.review()).publicationReview!.attempted, 1);
    await f.restart(); const plan = (await f.review()).plan!;
    await f.phone.context.updateContext(f.phone.db, 'plan', plan, {
      type: plan.type, planned_date: plan.planned_date, summary: plan.summary, notes: 'A later private correction',
    });
    const pending = f.phone.sqlite.prepare('SELECT * FROM sync_queue ORDER BY rowid').all();
    assert.equal(pending.length, 1);
    await f.sync(transport); assert.equal((await f.review()).publicationReview!.status, 'confirmed'); assert.equal(f.creates, 1); assert.equal(f.gets, 1);
    assert.equal((await f.review()).plan!.notes, 'A later private correction');
    assert.deepEqual(f.phone.sqlite.prepare('SELECT * FROM sync_queue ORDER BY rowid').all(), pending);
    const writes = f.requests.filter((r) => r.path === '/api/v1/calendar-reservations' && r.body);
    assert.deepEqual(writes.map((r) => r.body), [queued.request_json, queued.request_json]);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM calendar_publication_reviews').first<{ n: number }>())!.n, 1);
  } finally { await f.close(); }
});

test('a new approved session freshly verifies a revoked publisher while retaining the original reservation binding and frozen body', async () => {
  const f = await mobileCalendarPublicationFixture(false); try {
    const original = (await f.review()).publication!, frozen = original.reserve_request_json, owner = f.account.deviceId;
    await f.cloud.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), owner).run();
    await f.signInAgain(); assert.notEqual(f.account.deviceId, owner); await f.queue(); await f.sync();
    const current = (await f.review()).publication!; assert.equal(current.device_id, owner); assert.equal(current.reserve_request_json, frozen);
    assert.equal(current.status, 'confirmed'); assert.equal((await f.review()).publicationReview!.status, 'confirmed');
    const cloud = await f.cloud.db.prepare('SELECT publisher_id, epoch, status FROM calendar_publication_reservations WHERE id = ?').bind(f.receipt.id).first();
    assert.equal(cloud!.publisher_id, owner); assert.equal(cloud!.epoch, original.epoch); assert.equal(cloud!.status, 'saved'); assert.equal(f.creates, 1);
  } finally { await f.close(); }
});

test('an actual restore holds original receipts and a fresh verified marker confirms them under the new epoch without moving identity', async () => {
  const f = await mobileCalendarPublicationFixture(false); try {
    const original = (await f.review()).publication!, backup = (await f.cloud.call('settings/backups', { method: 'POST' })).body.backup;
    assert.equal((await f.cloud.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200);
    await f.run(); assert.equal((await f.review()).receipt!.status, 'held'); assert.notEqual((await f.review()).epoch, original.epoch);
    await f.queue(); await f.sync(); const final = await f.review();
    assert.equal(final.publicationReview!.status, 'confirmed'); assert.equal(final.publication!.epoch, original.epoch);
    assert.equal(final.publicationReview!.server_creation_epoch, original.epoch); assert.equal(final.publication!.status, 'confirmed');
    assert.equal(f.creates, 1); assert.equal(final.plan!.notes, 'PRIVATE PLAN');
  } finally { await f.close(); }
});

test('stale private facts hold an unsent review, while a fresh review archives its immutable predecessor without transferring a session', async () => {
  const f = await mobileCalendarPublicationFixture(); try {
    const first = await f.queue(); await f.verify(); await assert.rejects(f.sync(), /Verify the original event again/);
    assert.equal((await f.review()).publicationReview!.status, 'held'); assert.equal((await f.review()).publicationReview!.attempted, 0);
    await f.signInAgain(); const second = await f.queue(); assert.notEqual(second.id, first.id); await f.sync();
    const old = f.phone.sqlite.prepare('SELECT * FROM apple_calendar_publication_reviews WHERE id = ?').get(first.id);
    assert.equal(old.status, 'superseded'); assert.equal(old.request_json, first.request_json); assert.equal((await f.review()).publicationReview!.status, 'confirmed');
    assert.equal(f.creates, 1);
  } finally { await f.close(); }
});

test('local acknowledgement failure retains the exact review for retry without another provider read or Calendar effect', async () => {
  const f = await mobileCalendarPublicationFixture(); try {
    const queued = await f.queue(); f.phone.faults.sqlContains = "UPDATE apple_calendar_publication_reviews SET status = 'confirmed'";
    await assert.rejects(f.sync()); assert.equal((await f.review()).publicationReview!.request_json, queued.request_json);
    assert.equal((await f.review()).publicationReview!.status, 'pending'); f.phone.faults.sqlContains = undefined;
    await f.restart(); await f.sync(); assert.equal((await f.review()).publicationReview!.status, 'confirmed'); assert.equal(f.creates, 1); assert.equal(f.gets, 1);
    assert.equal((await f.cloud.db.prepare('SELECT COUNT(*) n FROM calendar_publication_reviews').first<{ n: number }>())!.n, 1);
  } finally { await f.close(); }
});

test('schema 17 upgrades preserve all 24 existing data tables, original source receipts, account identity and frozen requests', async () => {
  const f = await mobileCalendarPublicationFixture(false); try {
    await f.verify(); f.phone.sqlite.exec('DROP TABLE apple_calendar_publication_reviews; PRAGMA user_version = 17;');
    const names = f.phone.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'app_metadata' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    assert.equal(names.length, 24);
    const rows = new Map(names.map(({ name }) => [name, f.phone.sqlite.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()]));
    const metadata = f.phone.sqlite.prepare("SELECT key, value FROM app_metadata WHERE key != 'schema-version' ORDER BY key").all();
    await f.restart(); assert.equal(f.phone.sqlite.pragma('user_version', { simple: true }), 18);
    for (const [name, value] of rows) assert.deepEqual(f.phone.sqlite.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all(), value, name);
    assert.deepEqual(f.phone.sqlite.prepare("SELECT key, value FROM app_metadata WHERE key != 'schema-version' ORDER BY key").all(), metadata);
    assert.equal((await f.review()).publicationReview, null); assert.equal(f.phone.sqlite.pragma('quick_check', { simple: true }), 'ok');
    assert.equal(f.creates, 1);
  } finally { await f.close(); }
});

test('a session change after committed verification keeps its unknown reply and requires fresh event review before the new session can confirm status', async () => {
  const f = await mobileCalendarPublicationFixture(); try {
    const queued = await f.queue(); let current = true;
    const transport: typeof fetch = async (input, init) => { const response = await f.transport(input, init); if (init?.method === 'POST') current = false; return response; };
    await assert.rejects(f.sync(transport, () => current), /active account changed/);
    assert.equal((await f.review()).publicationReview!.request_json, queued.request_json); assert.equal((await f.review()).publicationReview!.status, 'pending');
    const originalDevice = f.account.deviceId, before = f.requests.length; await f.signInAgain();
    await assert.rejects(f.sync(), /earlier sign-in/); assert.equal(f.requests.length, before);
    const fresh = await f.queue(); assert.notEqual(fresh.id, queued.id); await f.sync();
    const original = f.phone.sqlite.prepare('SELECT * FROM apple_calendar_publication_reviews WHERE id = ?').get(queued.id);
    assert.equal(original.request_json, queued.request_json); assert.equal(original.status, 'superseded');
    const row = await f.cloud.db.prepare('SELECT publisher_id FROM calendar_publication_reservations WHERE id = ?').bind(f.receipt.id).first();
    assert.equal(row!.publisher_id, originalDevice); assert.equal(f.creates, 1); assert.equal(f.gets, 2);
  } finally { await f.close(); }
});
