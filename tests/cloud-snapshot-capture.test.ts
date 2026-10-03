import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

async function captureAll(h: Awaited<ReturnType<typeof createCloudHarness>>, id: string) {
  let job = await h.advanceCapture(id);
  for (let attempt = 0; job.state === 'capturing' && attempt < 100; attempt++) {
    job = await h.advanceCapture(id);
  }
  assert.equal(job.state, 'awaiting_verification', 'capture must reach a private, non-restorable checkpoint');
  return job;
}

async function verifyAll(h: Awaited<ReturnType<typeof createCloudHarness>>, id: string) {
  let job = await h.advanceCaptureVerification(id);
  for (let attempt = 0; job.state === 'awaiting_verification' && attempt < 100; attempt++) {
    job = await h.advanceCaptureVerification(id);
  }
  assert.equal(job.state, 'manifest_ready', 'verification must produce a private root manifest');
  return job;
}

test('bounded capture walks integer, text, and composite keys without listing a backup', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact;
    await h.db.prepare("INSERT INTO contact_groups (workspace_id, name) VALUES ('test', 'Family'), ('test', 'Friends')").run();
    await h.db.prepare(`INSERT INTO contact_group_members (workspace_id, contact_id, group_id)
      SELECT 'test', ?, id FROM contact_groups WHERE workspace_id = 'test'`).bind(contact.id).run();
    await h.db.prepare(`INSERT INTO daily_snoozes (workspace_id, id, contact_id, until_date)
      VALUES ('test', ?, ?, '2026-10-10'), ('test', ?, ?, '2026-10-11')`)
      .bind(`birthday-${contact.id}`, contact.id, `overdue-${contact.id}`, contact.id).run();
    const other = (await h.call('contacts', { workspace: 'other', method: 'POST', body: { name: 'Private' } })).body.contact;
    const started = await h.beginCapture();
    assert.equal((await h.beginCapture()).id, started.id, 'starting again reuses the active capture');
    const overlapping = await Promise.all([h.beginCapture(), h.beginCapture()]);
    assert.ok(overlapping.every((job) => job.id === started.id));
    const finished = await captureAll(h, started.id);
    const counts = JSON.parse(finished.row_counts) as Record<string, number>;
    assert.equal(counts.contacts, 1);
    assert.equal(counts.contact_group_members, 2);
    assert.equal(counts.daily_snoozes, 2);
    const chunks = await h.db.prepare(`SELECT sequence, table_name, cursor_key, row_count, byte_length, sha256
      FROM cloud_snapshot_capture_chunks WHERE job_id = ? ORDER BY sequence`).bind(started.id)
      .all<{ sequence: number; table_name: string; cursor_key: string; row_count: number; byte_length: number; sha256: string }>();
    assert.equal(chunks.results.length, finished.chunk_count);
    assert.equal(chunks.results.reduce((sum, chunk) => sum + chunk.row_count, 0), 7);
    assert.deepEqual(chunks.results.map((chunk) => chunk.sequence), chunks.results.map((_, index) => index));
    const snoozes = chunks.results.find((chunk) => chunk.table_name === 'daily_snoozes');
    assert.equal(snoozes?.cursor_key, `overdue-${contact.id}`);
    const members = chunks.results.find((chunk) => chunk.table_name === 'contact_group_members');
    assert.match(members?.cursor_key || '', /^\[\d+,\d+\]$/);
    for (const chunk of chunks.results) {
      const object = await h.assets.get(`test/recovery-jobs/${started.id}/chunks/${chunk.sequence}-${chunk.sha256}.json`);
      assert.equal(object?.size, chunk.byte_length);
      assert.equal(object?.customMetadata?.sha256, chunk.sha256);
      const payload = JSON.parse(await object!.text());
      assert.equal(payload.workspaceId, 'test');
      assert.equal(payload.rows.length, chunk.row_count);
      assert.ok(payload.rows.every((row: { workspace_id: string }) => row.workspace_id === 'test'));
    }
    assert.equal((await h.call('settings/backups')).body.backups.length, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_backup_files').first<{ count: number }>())?.count, 0);
    assert.equal(other.name, 'Private');
    assert.equal((await h.advanceCapture(started.id)).state, 'awaiting_verification');
    assert.equal((await verifyAll(h, started.id)).state, 'manifest_ready');
    assert.equal((await h.advanceCapture(started.id)).state, 'manifest_ready');
  } finally { await h.close(); }
});

test('large capture and manifest parts exceed 16 MB without one large read', {
  skip: process.env.CLOUD_TEST_RUNTIME === 'workerd' && 'Large-count boundary runs in the fast SQLite harness.',
}, async () => {
  const h = await createCloudHarness();
  try {
    for (let index = 0; index < 17; index++) {
      await h.db.prepare("INSERT INTO contacts (workspace_id, name, notes) VALUES ('test', ?, ?)")
        .bind(`Person ${index}`, 'x'.repeat(1_000_000)).run();
    }
    const job = await h.beginCapture();
    const finished = await captureAll(h, job.id);
    assert.equal(JSON.parse(finished.row_counts).contacts, 17);
    const totals = await h.db.prepare(`SELECT COUNT(*) AS chunks, SUM(byte_length) AS bytes
      FROM cloud_snapshot_capture_chunks WHERE job_id = ?`).bind(job.id)
      .first<{ chunks: number; bytes: number }>();
    assert.ok(totals!.chunks >= 9);
    assert.ok(totals!.bytes > 16 * 1024 * 1024);
    const largest = await h.db.prepare('SELECT MAX(byte_length) AS bytes FROM cloud_snapshot_capture_chunks WHERE job_id = ?')
      .bind(job.id).first<{ bytes: number }>();
    assert.ok(largest!.bytes <= 3_001_024);
    assert.equal((await h.call('settings/backups')).body.backups.length, 0);
    const verified = await verifyAll(h, job.id);
    assert.ok(verified.manifest_part_count >= 2);
    let chain = '';
    let described = 0;
    for (let index = 0; index < verified.manifest_part_count; index++) {
      const part = await h.assets.get(`test/recovery-jobs/${job.id}/manifest-parts/${index}.json`);
      assert.ok(part);
      const bytes = new Uint8Array(await part.arrayBuffer());
      const hash = createHash('sha256').update(bytes).digest('hex');
      const value = JSON.parse(new TextDecoder().decode(bytes));
      assert.ok(value.chunks.length <= 8);
      described += value.chunks.reduce((sum: number, chunk: { row_count: number }) => sum + chunk.row_count, 0);
      chain = createHash('sha256').update(`${chain}:${hash}`).digest('hex');
    }
    assert.equal(described, 17);
    const root = await h.assets.get(`test/recovery-jobs/${job.id}/manifest-${verified.manifest_sha256}.json`);
    assert.equal(JSON.parse(await root!.text()).partsChainSha256, chain);
  } finally { await h.close(); }
});

test('an edit during R2 capture cannot commit a chunk or retain a usable job', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact;
    const job = await h.beginCapture();
    h.faults.afterPut = async (key) => {
      if (!key.startsWith('test/recovery-jobs/')) return;
      await h.db.prepare("UPDATE contacts SET notes = 'Changed' WHERE id = ?").bind(contact.id).run();
    };
    await assert.rejects(h.advanceCapture(job.id), /changed/i);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_snapshot_capture_chunks').first<{ count: number }>())?.count, 0);
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/` })).objects.length, 0);
    h.faults.afterPut = undefined;
    await assert.rejects(h.advanceCapture(job.id), /changed/i);
    const invalid = await h.db.prepare('SELECT state FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(job.id).first<{ state: string }>();
    assert.equal(invalid?.state, 'invalid');
    assert.notEqual((await h.beginCapture()).id, job.id);
  } finally { await h.close(); }
});

test('a completed private capture is invalidated when source data changes', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact;
    const job = await h.beginCapture();
    await captureAll(h, job.id);
    await h.db.prepare("UPDATE contacts SET notes = 'Later edit' WHERE id = ?").bind(contact.id).run();
    await assert.rejects(h.advanceCapture(job.id), /changed/i);
    const invalid = await h.db.prepare('SELECT state FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(job.id).first<{ state: string }>();
    assert.equal(invalid?.state, 'invalid');
    assert.notEqual((await h.beginCapture()).id, job.id);
  } finally { await h.close(); }
});

test('only one active capture job can exist per workspace', async () => {
  const h = await createCloudHarness();
  try {
    const job = await h.beginCapture();
    await assert.rejects(h.db.prepare(`INSERT INTO cloud_snapshot_capture_jobs (id, workspace_id, revision)
      VALUES (?, 'test', ?)`).bind(crypto.randomUUID(), job.revision).run(), /UNIQUE constraint failed/i);
  } finally { await h.close(); }
});

test('an expired lease retry keeps the winning content-addressed chunk', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const job = await h.beginCapture();
    let retried = false;
    h.faults.afterPut = async (key) => {
      if (retried || !key.startsWith(`test/recovery-jobs/${job.id}/`)) return;
      retried = true;
      h.faults.afterPut = undefined;
      await h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET lease_until = ? WHERE id = ?')
        .bind(new Date(Date.now() - 60_000).toISOString(), job.id).run();
      await h.advanceCapture(job.id);
    };
    const advanced = await h.advanceCapture(job.id);
    assert.equal(advanced.chunk_count, 1);
    const chunk = await h.db.prepare('SELECT sha256 FROM cloud_snapshot_capture_chunks WHERE job_id = ? AND sequence = 0')
      .bind(job.id).first<{ sha256: string }>();
    assert.ok(await h.assets.get(`test/recovery-jobs/${job.id}/chunks/0-${chunk?.sha256}.json`));
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/chunks/` })).objects.length, 1);
  } finally { await h.close(); }
});

test('capture chunk metadata rejects foreign-workspace associations', async () => {
  const h = await createCloudHarness();
  try {
    const job = await h.beginCapture();
    await h.db.prepare("UPDATE cloud_snapshot_capture_jobs SET lease_token = 'test-token' WHERE id = ?")
      .bind(job.id).run();
    await assert.rejects(h.db.prepare(`INSERT INTO cloud_snapshot_capture_chunks
      (job_id, workspace_id, sequence, table_name, cursor_key, row_count, byte_length, sha256)
      VALUES (?, 'other', 0, 'contacts', '1', 1, 10, ?)`).bind(job.id, 'a'.repeat(64)).run(), /CLOUD_RECOVERY_CONFLICT/);
  } finally { await h.close(); }
});

test('discard waits for an active lease and removes private chunks before job metadata', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const job = await h.beginCapture();
    await h.advanceCapture(job.id);
    await h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET lease_token = ?, lease_until = ? WHERE id = ?')
      .bind('active', new Date(Date.now() + 60_000).toISOString(), job.id).run();
    await assert.rejects(h.discardCapture(job.id), /still running/i);
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/chunks/` })).objects.length, 1);
    await h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET lease_until = ? WHERE id = ?')
      .bind(new Date(Date.now() - 60_000).toISOString(), job.id).run();
    assert.deepEqual(await h.discardCapture(job.id), { pending: false });
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/` })).objects.length, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_snapshot_capture_chunks WHERE job_id = ?')
      .bind(job.id).first<{ count: number }>())?.count, 0);
    await assert.rejects(h.advanceCapture(job.id), /not found/i);
  } finally { await h.close(); }
});

test('discard cleans large object sets in bounded resumable pages', {
  skip: process.env.CLOUD_TEST_RUNTIME === 'workerd' && 'Large-count boundary runs in the fast SQLite harness.',
}, async () => {
  const h = await createCloudHarness();
  try {
    const job = await h.beginCapture();
    for (let index = 0; index < 105; index++) {
      await h.assets.put(`test/recovery-jobs/${job.id}/orphan-${index}`, 'orphan');
    }
    assert.deepEqual(await h.discardCapture(job.id), { pending: true });
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/` })).objects.length, 5);
    assert.deepEqual(await h.discardCapture(job.id), { pending: false });
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/` })).objects.length, 0);
  } finally { await h.close(); }
});

test('workspace erasure waits for active capture and removes all capture artifacts', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const job = await h.beginCapture();
    await h.advanceCapture(job.id);
    await h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET lease_token = ?, lease_until = ? WHERE id = ?')
      .bind('active', new Date(Date.now() + 60_000).toISOString(), job.id).run();
    const erase = () => h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } });
    assert.equal((await erase()).status, 409);
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/chunks/` })).objects.length, 1);
    await h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET lease_token = NULL, lease_until = NULL WHERE id = ?')
      .bind(job.id).run();
    const result = await erase();
    assert.equal(result.body.success, true, JSON.stringify(result.body));
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/` })).objects.length, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_snapshot_capture_jobs WHERE workspace_id = ?')
      .bind('test').first<{ count: number }>())?.count, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_snapshot_capture_chunks WHERE workspace_id = ?')
      .bind('test').first<{ count: number }>())?.count, 0);
  } finally { await h.close(); }
});

test('private manifest verifies chunks, counts, and references without exposing a backup', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact;
    await h.call('interactions', { method: 'POST', body: { contact_id: contact.id, type: 'call', date: '2026-09-01' } });
    const job = await h.beginCapture();
    await captureAll(h, job.id);
    const verified = await verifyAll(h, job.id);
    assert.equal(verified.verify_index, verified.chunk_count);
    assert.equal(verified.manifest_part_count, 1);
    assert.match(verified.manifest_sha256 || '', /^[a-f0-9]{64}$/);
    const root = await h.assets.get(`test/recovery-jobs/${job.id}/manifest-${verified.manifest_sha256}.json`);
    assert.equal(root?.size, verified.manifest_bytes);
    const manifest = JSON.parse(await root!.text());
    assert.equal(manifest.format, 'everclose-cloud-manifest');
    assert.equal(manifest.workspaceId, 'test');
    assert.equal(manifest.chunkCount, verified.chunk_count);
    assert.equal(manifest.rowCounts.contacts, 1);
    assert.equal(manifest.rowCounts.interactions, 1);
    assert.ok(await h.assets.get(`test/recovery-jobs/${job.id}/manifest-parts/0.json`));
    assert.equal((await h.call('settings/backups')).body.backups.length, 0);
    await h.db.prepare("UPDATE contacts SET notes = 'Later' WHERE id = ?").bind(contact.id).run();
    assert.equal((await h.advanceCaptureVerification(job.id)).state, 'manifest_ready');
    assert.notEqual((await h.beginCapture()).id, job.id);
  } finally { await h.close(); }
});

test('damaged chunk invalidates capture before a manifest can be published', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const job = await h.beginCapture();
    await captureAll(h, job.id);
    const chunk = await h.db.prepare('SELECT sha256 FROM cloud_snapshot_capture_chunks WHERE job_id = ? AND sequence = 0')
      .bind(job.id).first<{ sha256: string }>();
    await h.assets.put(`test/recovery-jobs/${job.id}/chunks/0-${chunk?.sha256}.json`, 'tampered', {
      customMetadata: { sha256: chunk!.sha256, workspaceId: 'test', jobId: job.id, table: 'contacts' },
    });
    await assert.rejects(h.advanceCaptureVerification(job.id), /chunk/i);
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(job.id).first<{ state: string }>())?.state, 'invalid');
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/manifest-` })).objects
      .filter((object: { key: string }) => /\/manifest-[a-f0-9]{64}\.json$/u.test(object.key)).length, 0);
  } finally { await h.close(); }
});

test('a well-formed rehashed chunk still fails if its rows differ from D1', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const job = await h.beginCapture();
    await captureAll(h, job.id);
    const original = await h.db.prepare('SELECT sha256 FROM cloud_snapshot_capture_chunks WHERE job_id = ? AND sequence = 0')
      .bind(job.id).first<{ sha256: string }>();
    const object = await h.assets.get(`test/recovery-jobs/${job.id}/chunks/0-${original?.sha256}.json`);
    const payload = JSON.parse(await object!.text());
    payload.rows[0].name = 'Not Ada';
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await h.assets.put(`test/recovery-jobs/${job.id}/chunks/0-${sha256}.json`, bytes, {
      customMetadata: { sha256, workspaceId: 'test', jobId: job.id, table: 'contacts' },
    });
    await h.db.prepare('UPDATE cloud_snapshot_capture_chunks SET sha256 = ?, byte_length = ? WHERE job_id = ? AND sequence = 0')
      .bind(sha256, bytes.byteLength, job.id).run();
    await assert.rejects(h.advanceCaptureVerification(job.id), /source workspace/i);
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(job.id).first<{ state: string }>())?.state, 'invalid');
  } finally { await h.close(); }
});

test('manifest upload racing a source edit cannot publish a recovery point', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact;
    const job = await h.beginCapture();
    await captureAll(h, job.id);
    const checked = await h.advanceCaptureVerification(job.id);
    assert.equal(checked.verify_index, checked.chunk_count);
    h.faults.afterPut = async (key) => {
      if (!key.includes(`/recovery-jobs/${job.id}/manifest-`)) return;
      await h.db.prepare("UPDATE contacts SET notes = 'Changed during publish' WHERE id = ?")
        .bind(contact.id).run();
    };
    await assert.rejects(h.advanceCaptureVerification(job.id), /changed/i);
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(job.id).first<{ state: string }>())?.state, 'invalid');
    assert.equal((await h.assets.list({ prefix: `test/recovery-jobs/${job.id}/manifest-` })).objects
      .filter((object: { key: string }) => /\/manifest-[a-f0-9]{64}\.json$/u.test(object.key)).length, 0);
  } finally { await h.close(); }
});

test('transient manifest-part storage failure keeps verification resumable', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const job = await h.beginCapture();
    await captureAll(h, job.id);
    h.faults.failPut = true;
    await assert.rejects(h.advanceCaptureVerification(job.id), /outage/i);
    const pending = await h.db.prepare('SELECT state, verify_index FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(job.id).first<{ state: string; verify_index: number }>();
    assert.equal(pending?.state, 'awaiting_verification');
    assert.equal(pending.verify_index, 0);
    h.faults.failPut = false;
    assert.equal((await verifyAll(h, job.id)).state, 'manifest_ready');
  } finally { await h.close(); }
});

test('empty workspace gets a zero-chunk private manifest', async () => {
  const h = await createCloudHarness();
  try {
    const job = await h.beginCapture();
    await captureAll(h, job.id);
    const verified = await verifyAll(h, job.id);
    assert.equal(verified.chunk_count, 0);
    assert.equal(verified.manifest_part_count, 0);
    const root = await h.assets.get(`test/recovery-jobs/${job.id}/manifest-${verified.manifest_sha256}.json`);
    const manifest = JSON.parse(await root!.text());
    assert.equal(manifest.chunkCount, 0);
    assert.equal(manifest.rowCounts.contacts, 0);
  } finally { await h.close(); }
});

test('source count mismatch rejects publication even after every chunk verifies', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const job = await h.beginCapture();
    await captureAll(h, job.id);
    await h.advanceCaptureVerification(job.id);
    await h.db.prepare("UPDATE cloud_snapshot_capture_jobs SET row_counts = '{\"contacts\":2}' WHERE id = ?")
      .bind(job.id).run();
    await assert.rejects(h.advanceCaptureVerification(job.id), /row counts/i);
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(job.id).first<{ state: string }>())?.state, 'invalid');
  } finally { await h.close(); }
});

test('a job cannot bypass verification to publish a manifest', async () => {
  const h = await createCloudHarness();
  try {
    const job = await h.beginCapture();
    await assert.rejects(h.db.prepare(`UPDATE cloud_snapshot_capture_jobs SET state = 'manifest_ready',
      manifest_sha256 = ?, manifest_bytes = 10 WHERE id = ?`)
      .bind('a'.repeat(64), job.id).run(), /CLOUD_RECOVERY_CONFLICT/);
  } finally { await h.close(); }
});

test('captured CRM rows cannot move between workspaces without a revision on the old tenant', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact;
    const triggers = await h.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE '%_immutable_workspace'`).first<{ count: number }>();
    assert.equal(triggers?.count, 12);
    await assert.rejects(h.db.prepare("UPDATE contacts SET workspace_id = 'other' WHERE id = ?")
      .bind(contact.id).run(), /CLOUD_RECOVERY_CONFLICT/);
    assert.equal((await h.db.prepare('SELECT workspace_id FROM contacts WHERE id = ?')
      .bind(contact.id).first<{ workspace_id: string }>())?.workspace_id, 'test');
  } finally { await h.close(); }
});
