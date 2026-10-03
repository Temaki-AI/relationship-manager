import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;

async function capture(h: Harness) {
  const started = await h.call('settings/large-recovery', { method: 'POST', body: { action: 'capture' } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const id = started.body.capture.id as string;
  for (let index = 0; index < 100; index++) {
    const step = await h.call(`settings/large-recovery/${id}/step`, { method: 'POST' });
    assert.ok(step.status === 200 || step.status === 202, JSON.stringify(step.body));
    if (step.body.capture.state === 'manifest_ready') return id;
  }
  assert.fail('Capture did not finish.');
}

async function prepare(h: Harness, targetCaptureId: string) {
  const started = await h.call('settings/large-recovery', {
    method: 'POST', body: { action: 'prepare', targetCaptureId, confirmation: 'PREPARE' },
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const id = started.body.restore.id as string;
  for (let index = 0; index < 120; index++) {
    const step = await h.call(`settings/large-recovery/${id}/step`, { method: 'POST' });
    assert.ok(step.status === 200 || step.status === 202, JSON.stringify(step.body));
    if (step.body.restore.state === 'ready') return id;
  }
  assert.fail('Restore preparation did not finish.');
}

async function advanceRestore(h: Harness, id: string, terminal: string) {
  for (let index = 0; index < 200; index++) {
    const step = await h.call(`settings/large-recovery/${id}/step`, {
      method: 'POST', lifecycle: 'restoring',
    });
    assert.ok(step.status === 200 || step.status === 202, JSON.stringify(step.body));
    if (step.body.restore.state === terminal) return step.body.restore;
  }
  assert.fail(`Restore did not reach ${terminal}.`);
}

test('advanced recovery is disabled by default and owner-only when enabled', async () => {
  const h = await createCloudHarness();
  try {
    assert.deepEqual((await h.call('settings/large-recovery')).body,
      { enabled: false, captures: [], restore: null });
    assert.equal((await h.call('settings/large-recovery', {
      method: 'POST', body: { action: 'capture' },
    })).status, 404);
    h.emailEnv.CLOUD_LARGE_RECOVERY_ENABLED = 'true';
    assert.equal((await h.call('settings/large-recovery', { role: 'viewer' })).status, 403);
    assert.equal((await h.call('settings/large-recovery', {
      method: 'POST', role: 'viewer', body: { action: 'capture' },
    })).status, 403);
    assert.equal((await h.call('settings/large-recovery')).body.enabled, true);
    const id = await capture(h);
    assert.equal((await h.call(`settings/large-recovery/${id}`, { workspace: 'other' })).status, 404);
    assert.equal((await h.call(`settings/large-recovery/${id}/step`, {
      method: 'POST', workspace: 'other',
    })).status, 404);
    assert.equal((await h.call('settings/large-recovery', {
      method: 'POST', body: { action: 'prepare', targetCaptureId: id, confirmation: 'wrong' },
    })).status, 400);
  } finally { await h.close(); }
});

test('owner can capture, prepare, and apply a large snapshot through bounded API steps', async () => {
  const h = await createCloudHarness();
  try {
    h.emailEnv.CLOUD_LARGE_RECOVERY_ENABLED = 'true';
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Original' } })).body.contact;
    const targetId = await capture(h);
    await h.db.prepare("UPDATE contacts SET name = 'Current' WHERE id = ?").bind(contact.id).run();
    const id = await prepare(h, targetId);
    assert.equal((await h.call(`settings/large-recovery/${id}/step`, { method: 'POST' })).body.restore.state, 'ready');
    assert.equal((await h.call(`settings/large-recovery/${id}/apply`, {
      method: 'POST', body: { confirmation: 'wrong' },
    })).status, 400);
    const applied = await h.call(`settings/large-recovery/${id}/apply`, {
      method: 'POST', body: { confirmation: 'RESTORE' },
    });
    assert.equal(applied.status, 202);
    assert.equal(applied.body.restore.state, 'deleting');
    assert.equal((await h.call('settings/large-recovery', { lifecycle: 'restoring' })).body.restore.id, id);
    await advanceRestore(h, id, 'completed');
    assert.equal((await h.db.prepare('SELECT name FROM contacts WHERE id = ?').bind(contact.id)
      .first<{ name: string }>())?.name, 'Original');
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'active');
    assert.equal((await h.call(`settings/large-recovery/${id}/rollback`, {
      method: 'POST', body: { confirmation: 'ROLL BACK' },
    })).status, 409);
  } finally { await h.close(); }
});

test('owner can roll back an interrupted apply even after new-job access is disabled', async () => {
  const h = await createCloudHarness();
  try {
    h.emailEnv.CLOUD_LARGE_RECOVERY_ENABLED = 'true';
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Original' } })).body.contact;
    const targetId = await capture(h);
    await h.db.prepare("UPDATE contacts SET name = 'Current' WHERE id = ?").bind(contact.id).run();
    const id = await prepare(h, targetId);
    await h.call(`settings/large-recovery/${id}/apply`, {
      method: 'POST', body: { confirmation: 'RESTORE' },
    });
    for (let index = 0; index < 50; index++) {
      const step = await h.call(`settings/large-recovery/${id}/step`, {
        method: 'POST', lifecycle: 'restoring',
      });
      if (step.body.restore?.state === 'writing') break;
      assert.equal(step.status, 202, JSON.stringify(step.body));
    }
    h.emailEnv.CLOUD_LARGE_RECOVERY_ENABLED = 'false';
    assert.equal((await h.call('settings/large-recovery', { lifecycle: 'restoring' })).body.enabled, false);
    assert.equal((await h.call('settings/large-recovery', {
      method: 'POST', lifecycle: 'restoring', body: { action: 'capture' },
    })).status, 409);
    assert.equal((await h.call(`settings/large-recovery/${id}/rollback`, {
      method: 'POST', lifecycle: 'restoring', body: { confirmation: 'wrong' },
    })).status, 400);
    const rollback = await h.call(`settings/large-recovery/${id}/rollback`, {
      method: 'POST', lifecycle: 'restoring', body: { confirmation: 'ROLL BACK' },
    });
    assert.equal(rollback.body.restore.source, 'rollback');
    await advanceRestore(h, id, 'rolled_back');
    assert.equal((await h.db.prepare('SELECT name FROM contacts WHERE id = ?').bind(contact.id)
      .first<{ name: string }>())?.name, 'Current');
  } finally { await h.close(); }
});
