import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;

async function readyRestore(h: Harness) {
  h.emailEnv.CLOUD_LARGE_RECOVERY_ENABLED = 'true';
  const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Before' } })).body.contact;
  const capture = await h.call('settings/large-recovery', { method: 'POST', body: { action: 'capture' } });
  assert.equal(capture.status, 201);
  const captureId = capture.body.capture.id as string;
  for (let index = 0; index < 100; index++) {
    const step = await h.call(`settings/large-recovery/${captureId}/step`, { method: 'POST' });
    assert.ok(step.status === 200 || step.status === 202, JSON.stringify(step.body));
    if (step.body.capture.state === 'manifest_ready') break;
  }
  await h.db.prepare("UPDATE contacts SET name = 'After' WHERE id = ?").bind(contact.id).run();
  const preparation = await h.call('settings/large-recovery', {
    method: 'POST', body: { action: 'prepare', targetCaptureId: captureId, confirmation: 'PREPARE' },
  });
  assert.equal(preparation.status, 201);
  const restoreId = preparation.body.restore.id as string;
  let ready = false;
  for (let index = 0; index < 120; index++) {
    const step = await h.call(`settings/large-recovery/${restoreId}/step`, { method: 'POST' });
    assert.ok(step.status === 200 || step.status === 202, JSON.stringify(step.body));
    if (step.body.restore.state === 'ready') { ready = true; break; }
  }
  assert.ok(ready, 'restore preparation must finish');
  return { contactId: contact.id as number, restoreId };
}

async function drain(h: Harness, restoreId: string, terminal: 'completed' | 'rolled_back') {
  for (let index = 0; index < 200; index++) {
    const result = await h.processNextRestoreMessage();
    assert.ok(result, 'background queue must keep publishing progress');
    assert.equal(result.outcome, 'ack');
    const row = await h.db.prepare('SELECT state, background_state FROM cloud_snapshot_restore_jobs WHERE id = ?')
      .bind(restoreId).first<{ state: string; background_state: string }>();
    if (row?.state === terminal) {
      assert.equal(row.background_state, 'complete');
      return;
    }
  }
  assert.fail(`queued restore did not reach ${terminal}`);
}

test('queued recovery completes without an open browser and ignores duplicate delivery', async () => {
  const h = await createCloudHarness();
  try {
    const { contactId, restoreId } = await readyRestore(h);
    const applied = await h.call(`settings/large-recovery/${restoreId}/apply`, {
      method: 'POST', body: { confirmation: 'RESTORE' },
    });
    assert.equal(applied.status, 202, JSON.stringify(applied.body));
    assert.equal(applied.body.restore.background, 'running');
    assert.equal(h.queueMessages.length, 1);
    h.queueMessages.push({ ...h.queueMessages[0] });
    assert.equal((await h.processNextRestoreMessage())?.outcome, 'ack');
    const beforeDuplicate = await h.db.prepare('SELECT background_version FROM cloud_snapshot_restore_jobs WHERE id = ?')
      .bind(restoreId).first<{ background_version: number }>();
    assert.equal((await h.processNextRestoreMessage())?.outcome, 'ack');
    const afterDuplicate = await h.db.prepare('SELECT background_version FROM cloud_snapshot_restore_jobs WHERE id = ?')
      .bind(restoreId).first<{ background_version: number }>();
    assert.equal(afterDuplicate?.background_version, beforeDuplicate?.background_version);
    await drain(h, restoreId, 'completed');
    assert.equal((await h.db.prepare('SELECT name FROM contacts WHERE id = ?').bind(contactId)
      .first<{ name: string }>())?.name, 'Before');
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'active');
  } finally { await h.close(); }
});

test('pause survives reload and resume invalidates queued messages', async () => {
  const h = await createCloudHarness();
  try {
    const { restoreId } = await readyRestore(h);
    await h.call(`settings/large-recovery/${restoreId}/apply`, {
      method: 'POST', body: { confirmation: 'RESTORE' },
    });
    const paused = await h.call(`settings/large-recovery/${restoreId}/pause`, {
      method: 'POST', lifecycle: 'restoring',
    });
    assert.equal(paused.body.restore.background, 'paused');
    assert.equal((await h.call('settings/large-recovery', { lifecycle: 'restoring' })).body.restore.background, 'paused');
    assert.equal((await h.processNextRestoreMessage())?.outcome, 'ack');
    assert.equal(h.queueMessages.length, 0);
    assert.equal((await h.call(`settings/large-recovery/${restoreId}/step`, {
      method: 'POST', lifecycle: 'restoring',
    })).status, 409);
    const resumed = await h.call(`settings/large-recovery/${restoreId}/resume`, {
      method: 'POST', lifecycle: 'restoring',
    });
    assert.equal(resumed.status, 202);
    assert.equal(resumed.body.restore.background, 'running');
    await drain(h, restoreId, 'completed');
  } finally { await h.close(); }
});

test('rollback fences old target messages and restores pre-apply data', async () => {
  const h = await createCloudHarness();
  try {
    const { contactId, restoreId } = await readyRestore(h);
    await h.call(`settings/large-recovery/${restoreId}/apply`, {
      method: 'POST', body: { confirmation: 'RESTORE' },
    });
    assert.equal((await h.processNextRestoreMessage())?.outcome, 'ack');
    const paused = await h.call(`settings/large-recovery/${restoreId}/pause`, {
      method: 'POST', lifecycle: 'restoring',
    });
    assert.equal(paused.body.restore.background, 'paused');
    const rollback = await h.call(`settings/large-recovery/${restoreId}/rollback`, {
      method: 'POST', lifecycle: 'restoring', body: { confirmation: 'ROLL BACK' },
    });
    assert.equal(rollback.status, 202, JSON.stringify(rollback.body));
    assert.equal(rollback.body.restore.source, 'rollback');
    assert.equal((await h.processNextRestoreMessage())?.outcome, 'ack');
    await drain(h, restoreId, 'rolled_back');
    assert.equal((await h.db.prepare('SELECT name FROM contacts WHERE id = ?').bind(contactId)
      .first<{ name: string }>())?.name, 'After');
  } finally { await h.close(); }
});

test('a lost queue message is republished by scheduled reconciliation', async () => {
  const h = await createCloudHarness();
  try {
    const { restoreId } = await readyRestore(h);
    await h.call(`settings/large-recovery/${restoreId}/apply`, {
      method: 'POST', body: { confirmation: 'RESTORE' },
    });
    h.queueMessages.length = 0;
    await h.db.prepare("UPDATE cloud_snapshot_restore_jobs SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ?")
      .bind(restoreId).run();
    assert.equal(await h.reconcileRestoreQueue(), 1);
    await drain(h, restoreId, 'completed');
  } finally { await h.close(); }
});

test('queue send outage leaves a resumable failed job, not a silent locked spinner', async () => {
  const h = await createCloudHarness();
  try {
    const { restoreId } = await readyRestore(h);
    h.faults.failQueueSend = true;
    const failed = await h.call(`settings/large-recovery/${restoreId}/apply`, {
      method: 'POST', body: { confirmation: 'RESTORE' },
    });
    assert.equal(failed.status, 503);
    assert.equal((await h.call('settings/large-recovery', { lifecycle: 'restoring' })).body.restore.background, 'failed');
    h.faults.failQueueSend = false;
    const resumed = await h.call(`settings/large-recovery/${restoreId}/resume`, {
      method: 'POST', lifecycle: 'restoring',
    });
    assert.equal(resumed.status, 202);
    await drain(h, restoreId, 'completed');
  } finally { await h.close(); }
});

test('failed resume stays visible even while an earlier step still holds its lease', async () => {
  const h = await createCloudHarness();
  try {
    const { restoreId } = await readyRestore(h);
    await h.call(`settings/large-recovery/${restoreId}/apply`, {
      method: 'POST', body: { confirmation: 'RESTORE' },
    });
    await h.call(`settings/large-recovery/${restoreId}/pause`, {
      method: 'POST', lifecycle: 'restoring',
    });
    await h.db.prepare(`UPDATE cloud_snapshot_restore_jobs SET lease_token = 'in-flight', lease_until = ? WHERE id = ?`)
      .bind(new Date(Date.now() + 60_000).toISOString(), restoreId).run();
    h.faults.failQueueSend = true;
    assert.equal((await h.call(`settings/large-recovery/${restoreId}/resume`, {
      method: 'POST', lifecycle: 'restoring',
    })).status, 503);
    assert.equal((await h.call('settings/large-recovery', {
      lifecycle: 'restoring',
    })).body.restore.background, 'failed');
    await h.db.prepare('UPDATE cloud_snapshot_restore_jobs SET lease_token = NULL, lease_until = NULL WHERE id = ?')
      .bind(restoreId).run();
    h.faults.failQueueSend = false;
    assert.equal((await h.call(`settings/large-recovery/${restoreId}/resume`, {
      method: 'POST', lifecycle: 'restoring',
    })).status, 202);
    await drain(h, restoreId, 'completed');
  } finally { await h.close(); }
});

test('repeated snapshot read failures stop automatic retries and remain owner-resumable', async () => {
  const h = await createCloudHarness();
  try {
    const { restoreId } = await readyRestore(h);
    await h.call(`settings/large-recovery/${restoreId}/apply`, {
      method: 'POST', body: { confirmation: 'RESTORE' },
    });
    for (let index = 0; index < 50; index++) {
      const row = await h.db.prepare('SELECT state FROM cloud_snapshot_restore_jobs WHERE id = ?')
        .bind(restoreId).first<{ state: string }>();
      if (row?.state === 'awaiting_write') break;
      assert.equal((await h.processNextRestoreMessage())?.outcome, 'ack');
    }
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_restore_jobs WHERE id = ?')
      .bind(restoreId).first<{ state: string }>())?.state, 'awaiting_write');
    h.faults.failGet = true;
    for (let attempt = 1; attempt <= 10; attempt++) {
      const delivered = await h.processNextRestoreMessage();
      assert.equal(delivered?.attempts, attempt);
      assert.equal(delivered?.outcome, 'retry');
    }
    assert.equal((await h.call('settings/large-recovery', { lifecycle: 'restoring' })).body.restore.background, 'failed');
    assert.equal(h.queueMessages.length, 0);
    assert.equal(h.deadLetterMessages.length, 1);
    h.faults.failGet = false;
    assert.equal((await h.call(`settings/large-recovery/${restoreId}/resume`, {
      method: 'POST', lifecycle: 'restoring',
    })).status, 202);
    await drain(h, restoreId, 'completed');
  } finally { await h.close(); }
});
