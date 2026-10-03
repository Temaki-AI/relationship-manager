import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCSV } from '../lib/csv.ts';
import { parseVCards } from '../lib/vcard.ts';
import { createCloudHarness } from './helpers/cloud-harness.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
const advance = (h: Harness, id: string, workspace?: string) => h.call(`export/jobs/${id}`, { method: 'POST', workspace });
const decode = (body: number[]) => new TextDecoder().decode(new Uint8Array(body));

test('cloud export jobs resume by cursor and serve one complete tenant-scoped file', async () => {
  const h = await createCloudHarness();
  try {
    await h.db.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 27)
      INSERT INTO contacts(workspace_id, name) SELECT 'test', printf('Person %02d', n) FROM numbers`).run();
    await h.call('contacts', { method: 'POST', workspace: 'other', body: { name: 'Other workspace' } });
    const key = crypto.randomUUID();
    const created = await h.call('export/jobs', { method: 'POST', body: { format: 'csv' }, key });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.job.id;
    assert.equal((await h.call('export/jobs', { method: 'POST', body: { format: 'csv' }, key })).body.job.id, id);
    assert.equal((await h.call('export/jobs', { method: 'POST', body: { format: 'vcard' }, key })).status, 409);
    assert.equal((await h.call(`export/jobs/${id}`, { workspace: 'other' })).status, 404);
    assert.equal((await h.call(`export/jobs/${id}/download`)).status, 409);
    assert.equal((await advance(h, id)).body.job.exported, 25);
    assert.equal((await advance(h, id)).body.job.state, 'finalizing');
    assert.equal((await advance(h, id)).body.job.state, 'complete');
    const download = await h.call(`export/jobs/${id}/download`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('Cache-Control'), 'no-store');
    const rows = parseCSV(decode(download.body as number[]));
    assert.equal(rows.length, 28);
    assert.equal(rows[1][0], 'Person 01');
    assert.equal(rows[27][0], 'Person 27');
    assert.doesNotMatch(decode(download.body as number[]), /Other workspace/);
    assert.equal((await h.call(`export/jobs/${id}/download`, { workspace: 'other' })).status, 404);
  } finally { await h.close(); }
});

test('cloud export jobs reject changed workspaces and retry storage failures without advancing', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const created = await h.call('export/jobs', { method: 'POST', body: { format: 'vcard' } });
    const id = created.body.job.id;
    h.faults.failPut = true;
    assert.equal((await advance(h, id)).status, 503);
    assert.equal((await h.call(`export/jobs/${id}`)).body.job.exported, 0);
    h.faults.failPut = false;
    assert.equal((await advance(h, id)).body.job.state, 'finalizing');
    assert.equal((await advance(h, id)).body.job.state, 'complete');
    const cards = parseVCards(decode((await h.call(`export/jobs/${id}/download`)).body as number[]));
    assert.equal(cards[0].name, 'Ada');

    const second = await h.call('export/jobs', { method: 'POST', body: { format: 'csv' } });
    const secondId = second.body.job.id;
    await h.call('contacts', { method: 'POST', body: { name: 'Grace' } });
    const stale = await advance(h, secondId);
    assert.equal(stale.status, 409);
    assert.equal((await h.call(`export/jobs/${secondId}`)).body.job.state, 'invalid');
    assert.equal((await h.call(`export/jobs/${secondId}/download`)).status, 409);
  } finally { await h.close(); }
});

test('cloud export jobs assemble a file across multipart boundaries', async () => {
  const h = await createCloudHarness();
  try {
    await h.db.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 64)
      INSERT INTO contacts(workspace_id, name, notes, custom_fields)
      SELECT 'test', printf('Person %02d', n), printf('%0*d', 45000, 0),
        json_object('memo', printf('%0*d', 45000, 0)) FROM numbers`).run();
    const created = await h.call('export/jobs', { method: 'POST', body: { format: 'csv' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.job.id;
    let state = 'running';
    for (let attempt = 0; attempt < 6 && state !== 'complete'; attempt++) {
      const response = await advance(h, id);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      state = response.body.job.state;
    }
    assert.equal(state, 'complete');
    const download = await h.call(`export/jobs/${id}/download`);
    assert.equal(download.status, 200);
    assert.ok((download.body as number[]).length > 5 * 1024 * 1024);
    const rows = parseCSV(decode(download.body as number[]));
    assert.equal(rows.length, 65);
    assert.equal(rows[64][0], 'Person 64');
  } finally { await h.close(); }
});

test('export removal is resumable and workspace erasure removes unfinished uploads', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const created = await h.call('export/jobs', { method: 'POST', body: { format: 'csv' } });
    const id = created.body.job.id;
    await advance(h, id);
    for (let part = 0; part < 5; part++) {
      await h.assets.put(`test/exports/${id}/orphan-${part}`, 'old');
    }
    h.faults.listPageSize = 2;
    let status = 202;
    for (let attempt = 0; attempt < 5 && status === 202; attempt++) {
      status = (await h.call(`export/jobs/${id}`, { method: 'DELETE' })).status;
    }
    assert.equal(status, 200);
    assert.equal((await h.call(`export/jobs/${id}`)).status, 404);
    assert.equal((await h.assets.list({ prefix: `test/exports/${id}/` })).objects.length, 0);

    const unfinished = await h.call('export/jobs', { method: 'POST', body: { format: 'vcard' } });
    assert.equal(unfinished.status, 201);
    await advance(h, unfinished.body.job.id);
    h.faults.listPageSize = 1000;
    const erased = await h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } });
    assert.equal(erased.status, 200, JSON.stringify(erased.body));
    assert.equal((await h.db.prepare("SELECT COUNT(*) count FROM contact_export_jobs WHERE workspace_id = 'test'").first())?.count, 0);
    assert.equal((await h.assets.list({ prefix: 'test/exports/' })).objects.length, 0);
  } finally { await h.close(); }
});

test('export jobs include contact 10001 instead of truncating the file', { skip: process.env.CLOUD_TEST_RUNTIME === 'workerd' ? 'Large count is covered in the fast SQLite harness; binding behavior has smaller R2 tests.' : false }, async () => {
  const h = await createCloudHarness();
  try {
    await h.db.prepare(`WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
      numbers(n) AS (SELECT a.d * 1000 + b.d * 100 + c.d * 10 + e.d FROM digits a, digits b, digits c, digits e)
      INSERT INTO contacts(workspace_id, name)
      SELECT 'test', printf('Person %05d', n) FROM numbers`).run();
    await h.db.prepare("INSERT INTO contacts(workspace_id, name) VALUES ('test', 'Last person')").run();
    const created = await h.call('export/jobs', { method: 'POST', body: { format: 'csv' } });
    assert.equal(created.body.job.total, 10001);
    const id = created.body.job.id;
    let state = 'running';
    for (let attempt = 0; attempt < 405 && state !== 'complete'; attempt++) {
      const step = await advance(h, id);
      assert.equal(step.status, 200, JSON.stringify(step.body));
      state = step.body.job.state;
    }
    assert.equal(state, 'complete');
    const result = await h.call(`export/jobs/${id}/download`);
    assert.equal(result.status, 200);
    const rows = parseCSV(decode(result.body as number[]));
    assert.equal(rows.length, 10002);
    assert.equal(rows.at(-1)?.[0], 'Last person');
  } finally { await h.close(); }
});

test('a workspace edit during multipart completion leaves no downloadable file', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const created = await h.call('export/jobs', { method: 'POST', body: { format: 'csv' } });
    const id = created.body.job.id;
    assert.equal((await advance(h, id)).body.job.state, 'finalizing');
    h.faults.afterComplete = async () => {
      await h.db.prepare("UPDATE contacts SET name = 'Ada Changed' WHERE workspace_id = 'test'").run();
    };
    const result = await advance(h, id);
    assert.equal(result.status, 409);
    assert.equal((await h.call(`export/jobs/${id}`)).body.job.state, 'invalid');
    assert.equal((await h.call(`export/jobs/${id}/download`)).status, 409);
    assert.equal((await h.assets.list({ prefix: `test/exports/${id}/` })).objects.length, 1, 'only a scratch object may remain until removal');
  } finally { await h.close(); }
});

test('scheduled retention removes expired exports across workspaces without touching live downloads', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    await h.call('contacts', { method: 'POST', workspace: 'other', body: { name: 'Grace' } });
    const expired = await h.call('export/jobs', { method: 'POST', body: { format: 'csv' } });
    const live = await h.call('export/jobs', { method: 'POST', body: { format: 'vcard' } });
    const foreign = await h.call('export/jobs', { method: 'POST', workspace: 'other', body: { format: 'csv' } });
    for (const [id, workspace] of [[expired.body.job.id, 'test'], [live.body.job.id, 'test'], [foreign.body.job.id, 'other']] as const) {
      assert.equal((await advance(h, id, workspace)).body.job.state, 'finalizing');
      assert.equal((await advance(h, id, workspace)).body.job.state, 'complete');
    }
    await h.db.prepare("UPDATE contact_export_jobs SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id IN (?, ?)")
      .bind(expired.body.job.id, foreign.body.job.id).run();
    assert.equal((await h.call(`export/jobs/${expired.body.job.id}/download`)).status, 409);
    assert.deepEqual(await h.cleanupExpiredExports(), { attempted: 2, removed: 2, pending: 0, failed: 0 });
    assert.equal((await h.call(`export/jobs/${expired.body.job.id}`)).status, 404);
    assert.equal((await h.call(`export/jobs/${foreign.body.job.id}`, { workspace: 'other' })).status, 404);
    assert.equal((await h.assets.list({ prefix: `test/exports/${expired.body.job.id}/` })).objects.length, 0);
    assert.equal((await h.assets.list({ prefix: `other/exports/${foreign.body.job.id}/` })).objects.length, 0);
    assert.equal((await h.call(`export/jobs/${live.body.job.id}/download`)).status, 200);
  } finally { await h.close(); }
});

test('scheduled retention resumes partial cleanup and retries storage failures after leases', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const partial = await h.call('export/jobs', { method: 'POST', body: { format: 'csv' } });
    const id = partial.body.job.id;
    await advance(h, id);
    for (let part = 0; part < 3; part++) await h.assets.put(`test/exports/${id}/orphan-${part}`, 'old');
    await h.db.prepare("UPDATE contact_export_jobs SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(id).run();
    h.faults.listPageSize = 1;
    assert.deepEqual(await h.cleanupExpiredExports(), { attempted: 1, removed: 0, pending: 1, failed: 0 });
    assert.equal((await h.call(`export/jobs/${id}`)).body.job.state, 'deleting');
    for (let attempt = 0; attempt < 5 && (await h.call(`export/jobs/${id}`)).status !== 404; attempt++) await h.cleanupExpiredExports();
    assert.equal((await h.call(`export/jobs/${id}`)).status, 404);

    const retry = await h.call('export/jobs', { method: 'POST', body: { format: 'vcard' } });
    const retryId = retry.body.job.id;
    await advance(h, retryId);
    await h.db.prepare("UPDATE contact_export_jobs SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(retryId).run();
    h.faults.listPageSize = 1000;
    h.faults.failDelete = true;
    assert.deepEqual(await h.cleanupExpiredExports(), { attempted: 1, removed: 0, pending: 0, failed: 1 });
    assert.equal((await h.call(`export/jobs/${retryId}`)).body.job.state, 'deleting');
    h.faults.failDelete = false;
    assert.deepEqual(await h.cleanupExpiredExports(), { attempted: 1, removed: 1, pending: 0, failed: 0 });

    const leased = await h.call('export/jobs', { method: 'POST', body: { format: 'csv' } });
    const leasedId = leased.body.job.id;
    await h.db.prepare("UPDATE contact_export_jobs SET expires_at = '2020-01-01T00:00:00.000Z', lease_token = 'live', lease_until = '2099-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(leasedId).run();
    assert.equal((await h.cleanupExpiredExports()).attempted, 0);
    await h.db.prepare("UPDATE contact_export_jobs SET lease_until = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(leasedId).run();
    assert.equal((await h.cleanupExpiredExports()).removed, 1);
  } finally { await h.close(); }
});
