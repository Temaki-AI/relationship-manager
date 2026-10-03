import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;

async function publish(h: Harness) {
  const started = await h.beginCapture();
  let capture = started;
  for (let attempt = 0; capture.state === 'capturing' && attempt < 100; attempt++) {
    capture = await h.advanceCapture(started.id);
  }
  assert.equal(capture.state, 'awaiting_verification');
  for (let attempt = 0; capture.state === 'awaiting_verification' && attempt < 100; attempt++) {
    capture = await h.advanceCaptureVerification(started.id);
  }
  assert.equal(capture.state, 'manifest_ready');
  return capture;
}

async function readAll(h: Harness, id: string) {
  let read = await h.advanceSnapshotRead(id);
  for (let attempt = 0; read.state === 'reading' && attempt < 100; attempt++) {
    read = await h.advanceSnapshotRead(id);
  }
  assert.equal(read.state, 'verified');
  return read;
}

test('independent reader validates a mixed snapshot from R2 after D1 chunk metadata is gone', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact;
    await h.db.prepare("INSERT INTO contact_groups (workspace_id, name) VALUES ('test', 'Family')").run();
    await h.db.prepare(`INSERT INTO contact_group_members (workspace_id, contact_id, group_id)
      SELECT 'test', ?, id FROM contact_groups WHERE workspace_id = 'test'`).bind(contact.id).run();
    await h.db.prepare(`INSERT INTO daily_snoozes (workspace_id, id, contact_id, until_date)
      VALUES ('test', ?, ?, '2026-10-10')`).bind(`birthday-${contact.id}`, contact.id).run();
    const capture = await publish(h);
    assert.ok(capture.chunk_count >= 3);
    await h.db.prepare('DELETE FROM cloud_snapshot_capture_chunks WHERE job_id = ?').bind(capture.id).run();
    await h.db.prepare("UPDATE contacts SET notes = 'Newer than snapshot' WHERE id = ?").bind(contact.id).run();
    const started = await h.beginSnapshotRead(capture.id);
    const verified = await readAll(h, started.id);
    const counts = JSON.parse(verified.row_counts);
    assert.equal(counts.contacts, 1);
    assert.equal(counts.contact_group_members, 1);
    assert.equal(counts.daily_snoozes, 1);
    assert.equal(verified.chunk_index, capture.chunk_count);
    assert.equal(verified.part_index, capture.manifest_part_count);
    assert.equal(verified.part_chain, capture.manifest_chain);
    assert.equal((await h.advanceSnapshotRead(started.id)).state, 'verified');
    await assert.rejects(h.beginSnapshotRead(capture.id, 'other'), /not found/i);
    await assert.rejects(h.advanceSnapshotRead(started.id, 'other'), /not found/i);
    assert.equal((await h.call('settings/backups')).body.backups.length, 0);
    await h.discardSnapshotRead(started.id);
    assert.ok(await h.assets.get(`test/recovery-jobs/${capture.id}/manifest-${capture.manifest_sha256}.json`));
    await assert.rejects(h.advanceSnapshotRead(started.id), /not found/i);
  } finally { await h.close(); }
});

test('reader rejects corrupted roots before starting and corrupted parts without advancing', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const capture = await publish(h);
    const rootKey = `test/recovery-jobs/${capture.id}/manifest-${capture.manifest_sha256}.json`;
    const root = await h.assets.get(rootKey);
    const originalRoot = new Uint8Array(await root!.arrayBuffer());
    await h.assets.put(rootKey, 'corrupt', { customMetadata: { sha256: capture.manifest_sha256!, workspaceId: 'test', jobId: capture.id } });
    await assert.rejects(h.beginSnapshotRead(capture.id), /manifest/i);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_snapshot_read_jobs')
      .first<{ count: number }>())?.count, 0);
    await h.assets.put(rootKey, originalRoot, { customMetadata: { sha256: capture.manifest_sha256!, workspaceId: 'test', jobId: capture.id } });
    const started = await h.beginSnapshotRead(capture.id);
    const partKey = `test/recovery-jobs/${capture.id}/manifest-parts/0.json`;
    await h.assets.put(partKey, 'corrupt', { customMetadata: { sha256: 'a'.repeat(64), workspaceId: 'test', jobId: capture.id } });
    await assert.rejects(h.advanceSnapshotRead(started.id), /part/i);
    const invalid = await h.db.prepare('SELECT state, chunk_index FROM cloud_snapshot_read_jobs WHERE id = ?')
      .bind(started.id).first<{ state: string; chunk_index: number }>();
    assert.equal(invalid?.state, 'invalid');
    assert.equal(invalid.chunk_index, 0);
  } finally { await h.close(); }
});

test('reader rejects a changed chunk even when the root and part remain intact', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const capture = await publish(h);
    const started = await h.beginSnapshotRead(capture.id);
    const part = await h.assets.get(`test/recovery-jobs/${capture.id}/manifest-parts/0.json`);
    const descriptor = JSON.parse(await part!.text()).chunks[0];
    await h.assets.put(`test/recovery-jobs/${capture.id}/chunks/0-${descriptor.sha256}.json`, 'changed', {
      customMetadata: { sha256: descriptor.sha256, workspaceId: 'test', jobId: capture.id, table: descriptor.table_name },
    });
    await assert.rejects(h.advanceSnapshotRead(started.id), /chunk/i);
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_read_jobs WHERE id = ?')
      .bind(started.id).first<{ state: string }>())?.state, 'invalid');
  } finally { await h.close(); }
});

test('root hash chain rejects a rehashed manifest part with valid chunks', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const capture = await publish(h);
    const started = await h.beginSnapshotRead(capture.id);
    const key = `test/recovery-jobs/${capture.id}/manifest-parts/0.json`;
    const original = await h.assets.get(key);
    const part = JSON.parse(await original!.text());
    part.extra = 'changed without touching the chunk list';
    const bytes = new TextEncoder().encode(JSON.stringify(part));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await h.assets.put(key, bytes, { customMetadata: { sha256, workspaceId: 'test', jobId: capture.id } });
    await assert.rejects(h.advanceSnapshotRead(started.id), /chain/i);
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_read_jobs WHERE id = ?')
      .bind(started.id).first<{ state: string }>())?.state, 'invalid');
  } finally { await h.close(); }
});

test('reader retries transient R2 outages without moving its durable cursor', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const capture = await publish(h);
    const started = await h.beginSnapshotRead(capture.id);
    h.faults.failGet = true;
    await assert.rejects(h.advanceSnapshotRead(started.id), /read outage/i);
    const pending = await h.db.prepare('SELECT state, chunk_index FROM cloud_snapshot_read_jobs WHERE id = ?')
      .bind(started.id).first<{ state: string; chunk_index: number }>();
    assert.equal(pending?.state, 'reading');
    assert.equal(pending.chunk_index, 0);
    h.faults.failGet = false;
    assert.equal((await readAll(h, started.id)).state, 'verified');
  } finally { await h.close(); }
});

test('active read leases protect private objects from discard and workspace erasure', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const capture = await publish(h);
    const started = await h.beginSnapshotRead(capture.id);
    await h.db.prepare('UPDATE cloud_snapshot_read_jobs SET lease_token = ?, lease_until = ? WHERE id = ?')
      .bind('active', new Date(Date.now() + 60_000).toISOString(), started.id).run();
    await assert.rejects(h.discardSnapshotRead(started.id), /still running/i);
    await assert.rejects(h.discardCapture(capture.id), /still running/i);
    const erase = () => h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } });
    assert.equal((await erase()).status, 409);
    await h.db.prepare('UPDATE cloud_snapshot_read_jobs SET lease_token = NULL, lease_until = NULL WHERE id = ?')
      .bind(started.id).run();
    const result = await erase();
    assert.equal(result.body.success, true, JSON.stringify(result.body));
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_snapshot_read_jobs')
      .first<{ count: number }>())?.count, 0);
    assert.equal((await h.assets.list({ prefix: 'test/recovery-jobs/' })).objects.length, 0);
  } finally { await h.close(); }
});

test('large multi-part manifest reads in bounded steps without D1 chunk metadata', {
  skip: process.env.CLOUD_TEST_RUNTIME === 'workerd' && 'Large-count boundary runs in the fast SQLite harness.',
}, async () => {
  const h = await createCloudHarness();
  try {
    for (let index = 0; index < 17; index++) {
      await h.db.prepare("INSERT INTO contacts (workspace_id, name, notes) VALUES ('test', ?, ?)")
        .bind(`Person ${index}`, 'x'.repeat(1_000_000)).run();
    }
    const capture = await publish(h);
    assert.ok(capture.manifest_part_count >= 2);
    await h.db.prepare('DELETE FROM cloud_snapshot_capture_chunks WHERE job_id = ?').bind(capture.id).run();
    const started = await h.beginSnapshotRead(capture.id);
    const verified = await readAll(h, started.id);
    assert.equal(JSON.parse(verified.row_counts).contacts, 17);
    assert.equal(verified.part_chain, capture.manifest_chain);
  } finally { await h.close(); }
});
