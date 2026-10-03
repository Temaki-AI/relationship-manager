import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
const now = new Date('2026-10-02T12:00:00.000Z');
const old = '2026-09-20T12:00:00.000Z';

async function publish(h: Harness) {
  const started = await h.beginCapture();
  let job = started;
  for (let attempt = 0; job.state === 'capturing' && attempt < 50; attempt++) job = await h.advanceCapture(started.id);
  assert.equal(job.state, 'awaiting_verification');
  for (let attempt = 0; job.state === 'awaiting_verification' && attempt < 50; attempt++) {
    job = await h.advanceCaptureVerification(started.id);
  }
  assert.equal(job.state, 'manifest_ready');
  return job;
}

test('cleanup preserves published manifests and recent work while removing invalid artifacts and old read cursors', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const invalid = await h.beginCapture();
    await h.advanceCapture(invalid.id);
    await h.db.prepare("UPDATE cloud_snapshot_capture_jobs SET state = 'invalid', updated_at = ? WHERE id = ?")
      .bind(old, invalid.id).run();
    const ready = await publish(h);
    await h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET updated_at = ? WHERE id = ?')
      .bind(old, ready.id).run();
    const oldRead = await h.beginSnapshotRead(ready.id);
    const leasedRead = await h.beginSnapshotRead(ready.id);
    await h.db.prepare('UPDATE cloud_snapshot_read_jobs SET updated_at = ? WHERE id = ?').bind(old, oldRead.id).run();
    await h.db.prepare('UPDATE cloud_snapshot_read_jobs SET updated_at = ?, lease_token = ?, lease_until = ? WHERE id = ?')
      .bind(old, 'active', new Date(now.getTime() + 60_000).toISOString(), leasedRead.id).run();
    const recent = await h.beginCapture();
    const cleaned = await h.cleanupStaleSnapshots(now);
    assert.equal(cleaned.readJobsRemoved, 1);
    assert.equal(cleaned.captureJobsRemoved, 1);
    assert.equal(cleaned.capturesInvalidated, 0);
    assert.equal(cleaned.failed, 0);
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${invalid.id}/` })).objects.length, 0);
    assert.ok(await h.assets.get(`test/recovery-jobs/${ready.id}/manifest-${ready.manifest_sha256}.json`));
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(ready.id).first<{ state: string }>())?.state, 'manifest_ready');
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(recent.id).first<{ state: string }>())?.state, 'capturing');
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_snapshot_read_jobs WHERE id = ?')
      .bind(oldRead.id).first<{ count: number }>())?.count, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_snapshot_read_jobs WHERE id = ?')
      .bind(leasedRead.id).first<{ count: number }>())?.count, 1);
  } finally { await h.close(); }
});

test('unfinished capture expires after seven idle days but an active lease protects it', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const job = await h.beginCapture();
    await h.advanceCapture(job.id);
    await h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET updated_at = ?, lease_token = ?, lease_until = ? WHERE id = ?')
      .bind(old, 'active', new Date(now.getTime() + 60_000).toISOString(), job.id).run();
    assert.equal((await h.cleanupStaleSnapshots(now)).capturesInvalidated, 0);
    assert.ok(await h.assets.get((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/` })).objects[0].key));
    await h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET lease_until = ? WHERE id = ?')
      .bind(new Date(now.getTime() - 60_000).toISOString(), job.id).run();
    const cleaned = await h.cleanupStaleSnapshots(now);
    assert.equal(cleaned.capturesInvalidated, 1);
    assert.equal(cleaned.captureJobsRemoved, 1);
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/` })).objects.length, 0);
  } finally { await h.close(); }
});

test('failed R2 deletion keeps an invalid job for the next cleanup pass', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const job = await h.beginCapture();
    await h.advanceCapture(job.id);
    await h.db.prepare("UPDATE cloud_snapshot_capture_jobs SET state = 'invalid' WHERE id = ?")
      .bind(job.id).run();
    h.faults.failDelete = true;
    const failed = await h.cleanupStaleSnapshots(now);
    assert.equal(failed.failed, 1);
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(job.id).first<{ state: string }>())?.state, 'invalid');
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/` })).objects.length, 1);
    h.faults.failDelete = false;
    assert.equal((await h.cleanupStaleSnapshots(now)).captureJobsRemoved, 1);
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/` })).objects.length, 0);
  } finally { await h.close(); }
});

test('large invalid object sets are cleaned in bounded resumable Cron passes', {
  skip: process.env.CLOUD_TEST_RUNTIME === 'workerd' && 'Large-count boundary runs in the fast SQLite harness.',
}, async () => {
  const h = await createCloudHarness();
  try {
    const job = await h.beginCapture();
    await h.db.prepare("UPDATE cloud_snapshot_capture_jobs SET state = 'invalid' WHERE id = ?")
      .bind(job.id).run();
    for (let index = 0; index < 405; index++) {
      await h.assets.put(`test/recovery-jobs/${job.id}/orphan-${index}`, 'orphan');
    }
    const first = await h.cleanupStaleSnapshots(now);
    assert.equal(first.pending, 1);
    assert.equal(first.captureJobsRemoved, 0);
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/` })).objects.length, 5);
    const second = await h.cleanupStaleSnapshots(now);
    assert.equal(second.captureJobsRemoved, 1);
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/` })).objects.length, 0);
  } finally { await h.close(); }
});
