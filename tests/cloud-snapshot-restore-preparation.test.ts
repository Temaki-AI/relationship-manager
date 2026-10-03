import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;

async function publish(h: Harness) {
  let job = await h.beginCapture();
  for (let index = 0; job.state === 'capturing' && index < 100; index++) job = await h.advanceCapture(job.id);
  for (let index = 0; job.state === 'awaiting_verification' && index < 100; index++) {
    job = await h.advanceCaptureVerification(job.id);
  }
  assert.equal(job.state, 'manifest_ready');
  return job;
}

test('restore preparation verifies target and current rollback point without changing contacts', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Before' } })).body.contact;
    const target = await publish(h);
    await h.db.prepare("UPDATE contacts SET name = 'Current' WHERE workspace_id = 'test' AND id = ?")
      .bind(contact.id).run();
    let prep = await h.beginRestorePreparation(target.id);
    assert.equal((await h.beginRestorePreparation(target.id)).id, prep.id);
    for (let index = 0; prep.state === 'preparing' && index < 100; index++) {
      prep = await h.advanceRestorePreparation(prep.id);
    }
    assert.equal(prep.state, 'ready');
    assert.ok(prep.target_read_job_id);
    assert.ok(prep.rollback_capture_job_id);
    assert.ok(prep.rollback_read_job_id);
    assert.notEqual(prep.rollback_capture_job_id, target.id);
    assert.equal((await h.db.prepare('SELECT name FROM contacts WHERE id = ?').bind(contact.id)
      .first<{ name: string }>())?.name, 'Current');
    const rollback = await h.db.prepare('SELECT state, revision FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(prep.rollback_capture_job_id).first<{ state: string; revision: number }>();
    assert.equal(rollback?.state, 'manifest_ready');
    assert.equal(rollback?.revision, prep.base_revision);
    await assert.rejects(h.discardCapture(target.id), /restore preparation/i);
    await assert.rejects(h.discardCapture(prep.rollback_capture_job_id!), /restore preparation/i);
    await assert.rejects(h.discardSnapshotRead(prep.target_read_job_id!), /restore preparation/i);
    const sweep = await h.cleanupStaleSnapshots(new Date(Date.now() + 2 * 24 * 60 * 60_000));
    assert.equal(sweep.readJobsRemoved, 0);
    await h.cancelRestorePreparation(prep.id);
    const released = await h.cleanupStaleSnapshots(new Date(Date.now() + 2 * 24 * 60 * 60_000));
    assert.equal(released.readJobsRemoved, 2);
    assert.ok(await h.assets.get(`test/recovery-jobs/${target.id}/manifest-${target.manifest_sha256}.json`));
  } finally { await h.close(); }
});

test('workspace edits invalidate a preparation before any rollback capture begins', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Before' } })).body.contact;
    const target = await publish(h);
    const prep = await h.beginRestorePreparation(target.id);
    await assert.rejects(h.advanceRestorePreparation(prep.id, 'other'), /not found/i);
    await assert.rejects(h.beginRestorePreparation(target.id, 'other'), /unavailable|running/i);
    await h.db.prepare("UPDATE contacts SET name = 'Edited' WHERE workspace_id = 'test' AND id = ?")
      .bind(contact.id).run();
    await assert.rejects(h.advanceRestorePreparation(prep.id), /changed/i);
    const invalid = await h.db.prepare('SELECT state, rollback_capture_job_id FROM cloud_snapshot_restore_jobs WHERE id = ?')
      .bind(prep.id).first<{ state: string; rollback_capture_job_id: string | null }>();
    assert.equal(invalid?.state, 'invalid');
    assert.equal(invalid.rollback_capture_job_id, null);
    assert.equal((await h.db.prepare('SELECT name FROM contacts WHERE id = ?').bind(contact.id)
      .first<{ name: string }>())?.name, 'Edited');
  } finally { await h.close(); }
});

test('a transient R2 read failure resumes the same preparation and read cursor', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Before' } });
    const target = await publish(h);
    const prep = await h.beginRestorePreparation(target.id);
    const started = await h.advanceRestorePreparation(prep.id);
    assert.ok(started.target_read_job_id);
    h.faults.failGet = true;
    await assert.rejects(h.advanceRestorePreparation(prep.id), /read outage/i);
    h.faults.failGet = false;
    const resumed = await h.advanceRestorePreparation(prep.id);
    assert.equal(resumed.target_read_job_id, started.target_read_job_id);
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_read_jobs WHERE id = ?')
      .bind(started.target_read_job_id).first<{ state: string }>())?.state, 'verified');
  } finally { await h.close(); }
});

test('a ready rollback point is not reusable after the workspace changes', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Before' } })).body.contact;
    const target = await publish(h);
    let prep = await h.beginRestorePreparation(target.id);
    for (let index = 0; prep.state === 'preparing' && index < 100; index++) {
      prep = await h.advanceRestorePreparation(prep.id);
    }
    assert.equal(prep.state, 'ready');
    await h.db.prepare("UPDATE contacts SET name = 'New revision' WHERE id = ?").bind(contact.id).run();
    await assert.rejects(h.advanceRestorePreparation(prep.id), /changed/i);
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_restore_jobs WHERE id = ?')
      .bind(prep.id).first<{ state: string }>())?.state, 'invalid');
    await h.db.prepare('UPDATE cloud_snapshot_restore_jobs SET updated_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(), prep.id).run();
    assert.equal((await h.cleanupStaleSnapshots()).restorePreparationsRemoved, 1);
    const next = await h.beginRestorePreparation(target.id);
    assert.notEqual(next.id, prep.id);
    await h.cancelRestorePreparation(next.id);
    assert.equal((await h.db.prepare('SELECT name FROM contacts WHERE id = ?').bind(contact.id)
      .first<{ name: string }>())?.name, 'New revision');
  } finally { await h.close(); }
});

test('idle preparations release their read pins, but live restore leases block erasure', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Before' } });
    const target = await publish(h);
    const prep = await h.beginRestorePreparation(target.id);
    const started = await h.advanceRestorePreparation(prep.id);
    const now = new Date();
    await h.db.prepare('UPDATE cloud_snapshot_restore_jobs SET lease_token = ?, lease_until = ? WHERE id = ?')
      .bind('active', new Date(now.getTime() + 60_000).toISOString(), prep.id).run();
    const erase = () => h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } });
    assert.equal((await erase()).status, 409);
    await h.db.prepare('UPDATE cloud_snapshot_restore_jobs SET lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?')
      .bind(new Date(now.getTime() - 8 * 24 * 60 * 60_000).toISOString(), prep.id).run();
    await h.db.prepare('UPDATE cloud_snapshot_read_jobs SET updated_at = ? WHERE id = ?')
      .bind(new Date(now.getTime() - 2 * 24 * 60 * 60_000).toISOString(), started.target_read_job_id).run();
    const sweep = await h.cleanupStaleSnapshots(now);
    assert.equal(sweep.restorePreparationsRemoved, 1);
    assert.equal(sweep.readJobsRemoved, 1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_snapshot_restore_jobs')
      .first<{ count: number }>())?.count, 0);
  } finally { await h.close(); }
});

test('an idle ready preparation expires after seven days and releases both read pins', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Before' } });
    const target = await publish(h);
    let prep = await h.beginRestorePreparation(target.id);
    for (let index = 0; prep.state === 'preparing' && index < 100; index++) {
      prep = await h.advanceRestorePreparation(prep.id);
    }
    assert.equal(prep.state, 'ready');
    const now = new Date();
    await h.db.prepare('UPDATE cloud_snapshot_restore_jobs SET updated_at = ? WHERE id = ?')
      .bind(new Date(now.getTime() - 8 * 24 * 60 * 60_000).toISOString(), prep.id).run();
    await h.db.prepare('UPDATE cloud_snapshot_read_jobs SET updated_at = ? WHERE id IN (?, ?)')
      .bind(new Date(now.getTime() - 2 * 24 * 60 * 60_000).toISOString(),
        prep.target_read_job_id, prep.rollback_read_job_id).run();
    const sweep = await h.cleanupStaleSnapshots(now);
    assert.equal(sweep.restorePreparationsRemoved, 1);
    assert.equal(sweep.readJobsRemoved, 2);
    assert.equal((await h.db.prepare('SELECT 1 FROM cloud_snapshot_restore_jobs WHERE id = ?')
      .bind(prep.id).first()), null);
    assert.ok(await h.assets.get(`test/recovery-jobs/${target.id}/manifest-${target.manifest_sha256}.json`));
  } finally { await h.close(); }
});
