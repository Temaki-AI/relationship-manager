import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;

async function publish(h: Harness) {
  let capture = await h.beginCapture();
  for (let index = 0; capture.state === 'capturing' && index < 100; index++) {
    capture = await h.advanceCapture(capture.id);
  }
  for (let index = 0; capture.state === 'awaiting_verification' && index < 100; index++) {
    capture = await h.advanceCaptureVerification(capture.id);
  }
  assert.equal(capture.state, 'manifest_ready');
  return capture;
}

async function prepared(h: Harness) {
  const target = await publish(h);
  let job = await h.beginRestorePreparation(target.id);
  for (let index = 0; job.state === 'preparing' && index < 100; index++) {
    job = await h.advanceRestorePreparation(job.id);
  }
  assert.equal(job.state, 'ready');
  return { target, job };
}

async function deleted(h: Harness, id: string) {
  let current = await h.beginRestoreApply(id);
  for (let index = 0; current.state === 'deleting' && index < 60; index++) {
    current = await h.advanceRestoreDeletion(id);
  }
  assert.equal(current.state, 'awaiting_write');
  return current;
}

async function written(h: Harness, id: string) {
  let current = await h.advanceRestoreWriting(id);
  for (let index = 0; current.state === 'writing' && index < 100; index++) {
    current = await h.advanceRestoreWriting(id);
  }
  assert.equal(current.state, 'repairing_dates');
  for (let index = 0; current.state === 'repairing_dates' && index < 100; index++) {
    current = await h.advanceRestoreDateRepair(id);
  }
  assert.equal(current.state, 'verifying');
  return current;
}

async function completed(h: Harness, id: string) {
  let current = await h.advanceRestoreVerification(id);
  for (let index = 0; current.state === 'verifying' && index < 100; index++) {
    current = await h.advanceRestoreVerification(id);
  }
  assert.equal(current.state, 'completed');
  return current;
}

async function rolledBack(h: Harness, id: string) {
  let current = await h.beginRestoreRollback(id);
  assert.equal(current.apply_source, 'rollback');
  for (let index = 0; current.state === 'deleting' && index < 60; index++) {
    current = await h.advanceRestoreDeletion(id);
  }
  assert.equal(current.state, 'awaiting_write');
  await written(h, id);
  for (let index = 0; current.state !== 'rolled_back' && index < 100; index++) {
    current = await h.advanceRestoreVerification(id);
  }
  assert.equal(current.state, 'rolled_back');
  return current;
}

test('apply entry preserves rows, pins both points, and enters maintenance only after verified preparation', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ana' } })).body.contact;
    const { target, job } = await prepared(h);
    await assert.rejects(h.beginRestoreApply(job.id, 'other'), /not found/i);
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'active');
    const started = await h.beginRestoreApply(job.id);
    assert.equal(started.state, 'deleting');
    assert.equal((await h.beginRestoreApply(job.id)).state, 'deleting');
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'restoring');
    assert.equal((await h.db.prepare('SELECT name FROM contacts WHERE id = ?').bind(contact.id)
      .first<{ name: string }>())?.name, 'Ana');
    await assert.rejects(h.cancelRestorePreparation(job.id), /running/i);
    await assert.rejects(h.discardCapture(target.id), /restore preparation/i);
    await assert.rejects(h.discardCapture(job.rollback_capture_job_id!), /restore preparation/i);
    const erase = await h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } });
    assert.equal(erase.status, 409);
  } finally { await h.close(); }
});

test('deletion advances through bounded table steps and leaves the workspace locked', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ana' } });
    const { job } = await prepared(h);
    let current = await h.beginRestoreApply(job.id);
    for (let index = 0; current.state === 'deleting' && index < 60; index++) {
      current = await h.advanceRestoreDeletion(job.id);
    }
    assert.equal(current.state, 'awaiting_write');
    assert.equal((await h.advanceRestoreDeletion(job.id)).state, 'awaiting_write');
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'restoring');
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'test'")
      .first<{ count: number }>())?.count, 0);
    await assert.rejects(h.db.prepare("INSERT INTO contacts (workspace_id, name) VALUES ('test', 'Unsafe')").run(),
      /CLOUD_WORKSPACE_ERASING/);
  } finally { await h.close(); }
});

test('bounded writing rechecks target chunks and reaches verification without reopening CRM access', async () => {
  const h = await createCloudHarness();
  try {
    for (let index = 0; index < 10; index++) {
      await h.db.prepare("INSERT INTO contacts (workspace_id, name) VALUES ('test', ?)")
        .bind(`Original ${index}`).run();
    }
    const target = await publish(h);
    await h.db.prepare("UPDATE contacts SET name = 'Changed' WHERE workspace_id = 'test'").run();
    let job = await h.beginRestorePreparation(target.id);
    for (let index = 0; job.state === 'preparing' && index < 100; index++) {
      job = await h.advanceRestorePreparation(job.id);
    }
    assert.equal(job.state, 'ready');
    await deleted(h, job.id);
    let current = await h.advanceRestoreWriting(job.id);
    assert.equal(current.state, 'writing');
    current = await h.advanceRestoreWriting(job.id);
    assert.equal(current.apply_chunk_index, 0);
    assert.equal(current.apply_row_index, 4);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'test'")
      .first<{ count: number }>())?.count, 4);
    await written(h, job.id);
    const restored = await h.db.prepare("SELECT name FROM contacts WHERE workspace_id = 'test' ORDER BY id")
      .all<{ name: string }>();
    assert.deepEqual(restored.results.map((row) => row.name),
      Array.from({ length: 10 }, (_, index) => `Original ${index}`));
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'restoring');
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(job.rollback_capture_job_id).first<{ state: string }>())?.state, 'manifest_ready');
  } finally { await h.close(); }
});

test('private restore completes a mixed graph only after exact row and reference verification', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ana' } })).body.contact;
    const originalEpoch = (await h.call('v1/sync/bootstrap')).body.cursor.epoch;
    await h.db.prepare("INSERT INTO interactions (workspace_id, contact_id, type, date, notes) VALUES ('test', ?, 'call', '2025-01-01', 'Hello')")
      .bind(contact.id).run();
    await h.db.prepare("UPDATE contacts SET last_contacted = '2025-06-01', updated_at = '2025-06-02T10:00:00.000Z' WHERE id = ?")
      .bind(contact.id).run();
    await h.db.prepare("INSERT INTO contact_groups (workspace_id, name) VALUES ('test', 'Close circle')").run();
    await h.db.prepare(`INSERT INTO contact_group_members (workspace_id, contact_id, group_id)
      SELECT 'test', ?, id FROM contact_groups WHERE workspace_id = 'test'`).bind(contact.id).run();
    const target = await publish(h);
    await h.db.prepare("UPDATE contacts SET name = 'Changed' WHERE id = ?").bind(contact.id).run();
    await h.db.prepare("INSERT INTO contacts (workspace_id, name) VALUES ('test', 'Extra')").run();
    let job = await h.beginRestorePreparation(target.id);
    for (let index = 0; job.state === 'preparing' && index < 100; index++) {
      job = await h.advanceRestorePreparation(job.id);
    }
    assert.equal(job.state, 'ready');
    await deleted(h, job.id);
    await written(h, job.id);
    assert.equal((await h.db.prepare("SELECT paused FROM workspace_sync_state WHERE workspace_id = 'test'").first())?.paused, 1);
    assert.equal((await h.db.prepare("SELECT count(*) AS count FROM sync_changes WHERE workspace_id = 'test'").first())?.count, 0);
    assert.equal((await h.call('v1/sync/bootstrap')).status, 423);
    const finished = await completed(h, job.id);
    assert.equal((await h.advanceRestoreVerification(job.id)).state, 'completed');
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'active');
    const restored = await h.db.prepare('SELECT name, last_contacted, updated_at FROM contacts WHERE id = ?')
      .bind(contact.id).first<{ name: string; last_contacted: string; updated_at: string }>();
    assert.deepEqual(restored, {
      name: 'Ana', last_contacted: '2025-06-01', updated_at: '2025-06-02T10:00:00.000Z',
    });
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'test'")
      .first<{ count: number }>())?.count, 1);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM contact_group_members WHERE workspace_id = 'test'")
      .first<{ count: number }>())?.count, 1);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE workspace_id = 'test' AND resource_id IS NOT NULL")
      .first<{ count: number }>())?.count, 0);
    assert.equal(finished.apply_chunk_index, target.chunk_count);
    const replica = (await h.call('v1/sync/bootstrap')).body;
    assert.notEqual(replica.cursor.epoch, originalEpoch);
    assert.equal(replica.records[0].id, contact.public_id);
    assert.equal(replica.records[0].data.last_contacted, '2025-06-01');
    assert.equal(replica.cursor.sequence, 0);
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(job.rollback_capture_job_id).first<{ state: string }>())?.state, 'manifest_ready');
  } finally { await h.close(); }
});

test('a private version 4 snapshot without public IDs remains readable and restores a stable replica', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Legacy person' } })).body.contact;
    const target = await publish(h);
    assert.equal(target.chunk_count, 1);
    const prefix = `test/recovery-jobs/${target.id}`;
    const partKey = `${prefix}/manifest-parts/0.json`;
    const part = JSON.parse(await (await h.assets.get(partKey))!.text());
    const descriptor = part.chunks[0];
    const chunk = JSON.parse(await (await h.assets.get(`${prefix}/chunks/0-${descriptor.sha256}.json`))!.text());
    delete chunk.rows[0].public_id; delete chunk.rows[0].merge_aliases; delete chunk.rows[0].contact_methods; delete chunk.rows[0].source_revision;
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const identity = { workspaceId: 'test', jobId: target.id };
    const chunkBytes = encode(chunk);
    descriptor.sha256 = hash(chunkBytes);
    descriptor.byte_length = chunkBytes.byteLength;
    await h.assets.put(`${prefix}/chunks/0-${descriptor.sha256}.json`, chunkBytes,
      { customMetadata: { ...identity, sha256: descriptor.sha256, table: 'contacts' } });
    const partBytes = encode(part);
    const partHash = hash(partBytes);
    await h.assets.put(partKey, partBytes, { customMetadata: { ...identity, sha256: partHash } });
    const root = JSON.parse(await (await h.assets.get(`${prefix}/manifest-${target.manifest_sha256}.json`))!.text());
    root.tableOrder = root.tableOrder.filter((table: string) => !['contact_source_links', 'contact_provider_links', 'provider_field_rules', 'contact_device_links', 'calendar_events', 'calendar_event_people', 'calendar_event_plans'].includes(table)); delete root.rowCounts.contact_source_links; delete root.rowCounts.contact_provider_links; delete root.rowCounts.provider_field_rules; delete root.rowCounts.contact_device_links; delete root.rowCounts.calendar_events; delete root.rowCounts.calendar_event_people; delete root.rowCounts.calendar_event_plans;
    root.snapshotSchemaVersion = 4;
    root.partsChainSha256 = hash(new TextEncoder().encode(`:${partHash}`));
    const rootBytes = encode(root);
    const rootHash = hash(rootBytes);
    await h.assets.put(`${prefix}/manifest-${rootHash}.json`, rootBytes, { customMetadata: { ...identity, sha256: rootHash } });
    await h.db.prepare(`UPDATE cloud_snapshot_capture_jobs SET manifest_sha256 = ?, manifest_chain = ?, manifest_bytes = ? WHERE id = ?`)
      .bind(rootHash, root.partsChainSha256, rootBytes.byteLength, target.id).run();
    let job = await h.beginRestorePreparation(target.id);
    for (let index = 0; job.state === 'preparing' && index < 100; index++) job = await h.advanceRestorePreparation(job.id);
    assert.equal(job.state, 'ready');
    await deleted(h, job.id);
    await written(h, job.id);
    await completed(h, job.id);
    const first = (await h.call('v1/sync/bootstrap')).body.records[0];
    assert.equal(first.legacyId, contact.id);
    assert.equal(first.data.name, 'Legacy person');
    assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.equal((await h.call('v1/sync/bootstrap')).body.records[0].id, first.id);
  } finally { await h.close(); }
});

test('legacy private version-5 history/reminders acquire deterministic UUIDs during resumable recovery', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Legacy history' } })).body.contact;
    await h.call('interactions', { method: 'POST', body: { contact_id: contact.id, date: '2026-10-03', type: 'call', summary: 'Context' } });
    await h.call('reminders', { method: 'POST', body: { contact_id: contact.id, title: 'Call back', remind_at: '2026-10-05T10:00:00Z' } });
    const target = await publish(h);
    assert.equal(target.chunk_count, 3);
    const prefix = `test/recovery-jobs/${target.id}`;
    const identity = { workspaceId: 'test', jobId: target.id };
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const partKey = `${prefix}/manifest-parts/0.json`;
    const part = JSON.parse(await (await h.assets.get(partKey))!.text());
    for (const descriptor of part.chunks) {
      if (!['contacts', 'interactions', 'reminders'].includes(descriptor.table_name)) continue;
      const chunk = JSON.parse(await (await h.assets.get(`${prefix}/chunks/${descriptor.sequence}-${descriptor.sha256}.json`))!.text());
      for (const row of chunk.rows) {
        if (descriptor.table_name === 'contacts') { delete row.merge_aliases; delete row.contact_methods; delete row.source_revision; }
        else delete row.public_id;
        if (descriptor.table_name === 'interactions') delete row.occurred_at;
      }
      const bytes = encode(chunk);
      descriptor.sha256 = hash(bytes); descriptor.byte_length = bytes.byteLength;
      await h.assets.put(`${prefix}/chunks/${descriptor.sequence}-${descriptor.sha256}.json`, bytes,
        { customMetadata: { ...identity, sha256: descriptor.sha256, table: descriptor.table_name } });
    }
    const partBytes = encode(part), partHash = hash(partBytes);
    await h.assets.put(partKey, partBytes, { customMetadata: { ...identity, sha256: partHash } });
    const root = JSON.parse(await (await h.assets.get(`${prefix}/manifest-${target.manifest_sha256}.json`))!.text());
    root.tableOrder = root.tableOrder.filter((table: string) => !['contact_source_links', 'contact_provider_links', 'provider_field_rules', 'contact_device_links', 'calendar_events', 'calendar_event_people', 'calendar_event_plans'].includes(table)); delete root.rowCounts.contact_source_links; delete root.rowCounts.contact_provider_links; delete root.rowCounts.provider_field_rules; delete root.rowCounts.contact_device_links; delete root.rowCounts.calendar_events; delete root.rowCounts.calendar_event_people; delete root.rowCounts.calendar_event_plans;
    root.snapshotSchemaVersion = 5; root.partsChainSha256 = hash(new TextEncoder().encode(`:${partHash}`));
    const rootBytes = encode(root), rootHash = hash(rootBytes);
    await h.assets.put(`${prefix}/manifest-${rootHash}.json`, rootBytes, { customMetadata: { ...identity, sha256: rootHash } });
    await h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET manifest_sha256 = ?, manifest_chain = ?, manifest_bytes = ? WHERE id = ?')
      .bind(rootHash, root.partsChainSha256, rootBytes.byteLength, target.id).run();
    let job = await h.beginRestorePreparation(target.id);
    for (let i = 0; job.state === 'preparing' && i < 100; i++) job = await h.advanceRestorePreparation(job.id);
    assert.equal(job.state, 'ready');
    await deleted(h, job.id);
    assert.equal((await h.call('v2/sync/bootstrap')).status, 423);
    await written(h, job.id); await completed(h, job.id);
    const records = (await h.call('v2/sync/bootstrap')).body.records;
    assert.equal(records.length, 3);
    assert.equal(records[0].id, contact.public_id);
    assert.notEqual(records[1].id, records[2].id);
    for (const record of records.slice(1)) {
      assert.match(record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      assert.equal(record.data.contact_id, contact.public_id);
    }
    assert.equal(records[1].data.occurred_at, null);
  } finally { await h.close(); }
});

test('legacy private version-6 plans/family/relationships restore with stable UUIDs and public linked references', async () => {
  const h = await createCloudHarness();
  try {
    const parent = (await h.call('contacts', { method: 'POST', body: { name: 'Parent' } })).body.contact;
    const linked = (await h.call('contacts', { method: 'POST', body: { name: 'Leo', birthday: '2020-02-29' } })).body.contact;
    assert.equal((await h.call('plans', { method: 'POST', body: { contact_id: parent.id, type: 'meetup', planned_date: '2026-10-05' } })).status, 201);
    assert.equal((await h.call(`contacts/${parent.id}/children`, { method: 'POST', body: { name: 'Leo', birthday: linked.birthday, linked_contact_id: linked.id } })).status, 201);
    assert.equal((await h.call(`contacts/${parent.id}/relationships`, { method: 'POST', body: { related_contact_id: linked.id, relationship_label: 'Child', reciprocal_label: 'Parent' } })).status, 201);
    const target = await publish(h), prefix = `test/recovery-jobs/${target.id}`, partKey = `${prefix}/manifest-parts/0.json`;
    const part = JSON.parse(await (await h.assets.get(partKey))!.text());
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const identity = { workspaceId: 'test', jobId: target.id };
    for (const descriptor of part.chunks) {
      if (!['contacts', 'plans', 'contact_children', 'contact_relationships'].includes(descriptor.table_name)) continue;
      const chunk = JSON.parse(await (await h.assets.get(`${prefix}/chunks/${descriptor.sequence}-${descriptor.sha256}.json`))!.text());
      for (const row of chunk.rows) { if (descriptor.table_name === 'contacts') { delete row.merge_aliases; delete row.contact_methods; delete row.source_revision; } else delete row.public_id; }
      const bytes = encode(chunk); descriptor.sha256 = hash(bytes); descriptor.byte_length = bytes.byteLength;
      await h.assets.put(`${prefix}/chunks/${descriptor.sequence}-${descriptor.sha256}.json`, bytes,
        { customMetadata: { ...identity, sha256: descriptor.sha256, table: descriptor.table_name } });
    }
    const partBytes = encode(part), partHash = hash(partBytes);
    await h.assets.put(partKey, partBytes, { customMetadata: { ...identity, sha256: partHash } });
    const root = JSON.parse(await (await h.assets.get(`${prefix}/manifest-${target.manifest_sha256}.json`))!.text());
    root.tableOrder = root.tableOrder.filter((table: string) => !['contact_source_links', 'contact_provider_links', 'provider_field_rules', 'contact_device_links', 'calendar_events', 'calendar_event_people', 'calendar_event_plans'].includes(table)); delete root.rowCounts.contact_source_links; delete root.rowCounts.contact_provider_links; delete root.rowCounts.provider_field_rules; delete root.rowCounts.contact_device_links; delete root.rowCounts.calendar_events; delete root.rowCounts.calendar_event_people; delete root.rowCounts.calendar_event_plans;
    root.snapshotSchemaVersion = 6; root.partsChainSha256 = hash(new TextEncoder().encode(`:${partHash}`));
    const rootBytes = encode(root), rootHash = hash(rootBytes);
    await h.assets.put(`${prefix}/manifest-${rootHash}.json`, rootBytes, { customMetadata: { ...identity, sha256: rootHash } });
    await h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET manifest_sha256 = ?, manifest_chain = ?, manifest_bytes = ? WHERE id = ?')
      .bind(rootHash, root.partsChainSha256, rootBytes.byteLength, target.id).run();
    let job = await h.beginRestorePreparation(target.id);
    for (let i = 0; job.state === 'preparing' && i < 100; i++) job = await h.advanceRestorePreparation(job.id);
    assert.equal(job.state, 'ready'); await deleted(h, job.id);
    assert.equal((await h.call('v3/sync/bootstrap')).status, 423);
    await written(h, job.id); await completed(h, job.id);
    const records = (await h.call('v3/sync/bootstrap')).body.records;
    assert.equal(records.length, 5); assert.equal(records.find((r: { entity: string }) => r.entity === 'family').data.linked_contact_id, linked.public_id);
    assert.equal(records.find((r: { entity: string }) => r.entity === 'relationship').data.related_contact_id, linked.public_id);
    for (const record of records.filter((r: { entity: string }) => r.entity !== 'contact')) {
      assert.match(record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      assert.equal(record.data.contact_id, parent.public_id); assert.equal(record.revision, 1);
    }
    assert.equal(new Set(records.map((r: { id: string }) => r.id)).size, 5);
  } finally { await h.close(); }
});

test('final verification refuses a changed destination row and keeps maintenance locked', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Original' } })).body.contact;
    const { job } = await prepared(h);
    await deleted(h, job.id);
    await written(h, job.id);
    await h.db.batch([
      h.db.prepare("UPDATE workspaces SET lifecycle = 'active' WHERE id = 'test'"),
      h.db.prepare("UPDATE contacts SET name = 'Corrupt' WHERE id = ?").bind(contact.id),
      h.db.prepare("UPDATE workspaces SET lifecycle = 'restoring' WHERE id = 'test'"),
    ]);
    await assert.rejects(h.advanceRestoreVerification(job.id), /do not match/i);
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'restoring');
    assert.equal((await h.db.prepare('SELECT state, apply_table_index FROM cloud_snapshot_restore_jobs WHERE id = ?')
      .bind(job.id).first<{ state: string; apply_table_index: number }>())?.state, 'verifying');
  } finally { await h.close(); }
});

test('rollback replaces a partial target write with the verified pre-restore graph', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Original' } })).body.contact;
    const target = await publish(h);
    await h.db.prepare("UPDATE contacts SET name = 'Current' WHERE id = ?").bind(contact.id).run();
    await h.db.prepare("INSERT INTO contacts (workspace_id, name) VALUES ('test', 'New friend')").run();
    let job = await h.beginRestorePreparation(target.id);
    for (let index = 0; job.state === 'preparing' && index < 100; index++) {
      job = await h.advanceRestorePreparation(job.id);
    }
    assert.equal(job.state, 'ready');
    await assert.rejects(h.beginRestoreRollback(job.id), /only available/i);
    await deleted(h, job.id);
    await h.advanceRestoreWriting(job.id);
    const partial = await h.advanceRestoreWriting(job.id);
    assert.equal(partial.state, 'writing');
    assert.equal((await h.beginRestoreApply(job.id)).state, 'writing');
    assert.equal((await h.db.prepare("SELECT name FROM contacts WHERE workspace_id = 'test'")
      .first<{ name: string }>())?.name, 'Original');
    await assert.rejects(h.beginRestoreRollback(job.id, 'other'), /not found/i);
    const rollback = await rolledBack(h, job.id);
    assert.equal((await h.beginRestoreRollback(job.id)).state, 'rolled_back');
    assert.equal((await h.advanceRestoreVerification(job.id)).state, 'rolled_back');
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'active');
    const names = await h.db.prepare("SELECT name FROM contacts WHERE workspace_id = 'test' ORDER BY name")
      .all<{ name: string }>();
    assert.deepEqual(names.results.map((row) => row.name), ['Current', 'New friend']);
    const replica = (await h.call('v1/sync/bootstrap')).body;
    assert.deepEqual(replica.records.map((record: { data: { name: string } }) => record.data.name).sort(), ['Current', 'New friend']);
    assert.equal(replica.cursor.sequence, 0);
    assert.equal(rollback.apply_source, 'rollback');
    const next = await h.beginRestorePreparation(target.id);
    assert.equal(next.state, 'preparing');
    await h.cancelRestorePreparation(next.id);
    await assert.rejects(h.discardCapture(job.rollback_capture_job_id!), /restore preparation/i);
    const swept = await h.cleanupStaleSnapshots(new Date(Date.now() + 31 * 24 * 60 * 60_000));
    assert.equal(swept.terminalRestoreJobsRemoved, 1);
    await h.discardCapture(job.rollback_capture_job_id!);
  } finally { await h.close(); }
});

test('rollback recovers after destination verification fails', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Original' } })).body.contact;
    const target = await publish(h);
    await h.db.prepare("UPDATE contacts SET name = 'Before restore' WHERE id = ?").bind(contact.id).run();
    let job = await h.beginRestorePreparation(target.id);
    for (let index = 0; job.state === 'preparing' && index < 100; index++) {
      job = await h.advanceRestorePreparation(job.id);
    }
    await deleted(h, job.id);
    await written(h, job.id);
    await h.db.batch([
      h.db.prepare("UPDATE workspaces SET lifecycle = 'active' WHERE id = 'test'"),
      h.db.prepare('UPDATE contacts SET name = ? WHERE id = ?').bind('Corrupt', contact.id),
      h.db.prepare("UPDATE workspaces SET lifecycle = 'restoring' WHERE id = 'test'"),
    ]);
    await assert.rejects(h.advanceRestoreVerification(job.id), /do not match/i);
    await rolledBack(h, job.id);
    assert.equal((await h.db.prepare('SELECT name FROM contacts WHERE id = ?').bind(contact.id)
      .first<{ name: string }>())?.name, 'Before restore');
  } finally { await h.close(); }
});

test('rollback refuses an active restore lease without resetting its cursor', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Hold' } });
    const { job } = await prepared(h);
    await h.beginRestoreApply(job.id);
    await h.db.prepare(`UPDATE cloud_snapshot_restore_jobs SET lease_token = 'live',
      lease_until = '9999-01-01T00:00:00.000Z' WHERE id = ?`).bind(job.id).run();
    await assert.rejects(h.beginRestoreRollback(job.id), /running/i);
    const current = await h.db.prepare('SELECT state, apply_source, lease_token FROM cloud_snapshot_restore_jobs WHERE id = ?')
      .bind(job.id).first<{ state: string; apply_source: string; lease_token: string }>();
    assert.deepEqual(current, { state: 'deleting', apply_source: 'target', lease_token: 'live' });
  } finally { await h.close(); }
});

test('empty snapshot completes without inventing rows', async () => {
  const h = await createCloudHarness();
  try {
    const { job } = await prepared(h);
    await deleted(h, job.id);
    await written(h, job.id);
    await completed(h, job.id);
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'active');
  } finally { await h.close(); }
});

test('corrupt target bytes stop writing without discarding the rollback point', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Original' } });
    const { target, job } = await prepared(h);
    await deleted(h, job.id);
    await h.advanceRestoreWriting(job.id);
    const descriptor = await h.db.prepare(`SELECT sha256 FROM cloud_snapshot_capture_chunks
      WHERE job_id = ? AND sequence = 0`).bind(target.id).first<{ sha256: string }>();
    const key = `test/recovery-jobs/${target.id}/chunks/0-${descriptor!.sha256}.json`;
    const original = new Uint8Array(await (await h.assets.get(key))!.arrayBuffer());
    await h.assets.put(key, 'corrupt', { customMetadata: {
      sha256: descriptor!.sha256, workspaceId: 'test', jobId: target.id, table: 'contacts',
    } });
    await assert.rejects(h.advanceRestoreWriting(job.id), /chunk/i);
    const cursor = await h.db.prepare('SELECT state, apply_chunk_index, apply_row_index FROM cloud_snapshot_restore_jobs WHERE id = ?')
      .bind(job.id).first<{ state: string; apply_chunk_index: number; apply_row_index: number }>();
    assert.equal(cursor?.state, 'writing');
    assert.equal(cursor.apply_chunk_index, 0);
    assert.equal(cursor.apply_row_index, 0);
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'restoring');
    assert.equal((await h.db.prepare('SELECT state FROM cloud_snapshot_capture_jobs WHERE id = ?')
      .bind(job.rollback_capture_job_id).first<{ state: string }>())?.state, 'manifest_ready');
    await h.assets.put(key, original, { customMetadata: {
      sha256: descriptor!.sha256, workspaceId: 'test', jobId: target.id, table: 'contacts',
    } });
    await written(h, job.id);
  } finally { await h.close(); }
});

test('failed insert rolls back the active lifecycle and leaves the write cursor retryable', {
  skip: process.env.CLOUD_TEST_RUNTIME === 'workerd' && 'Fault-injection trigger runs in the fast SQLite harness.',
}, async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Original' } });
    const { job } = await prepared(h);
    await deleted(h, job.id);
    await h.advanceRestoreWriting(job.id);
    await h.db.prepare(`CREATE TRIGGER test_restore_insert_fault BEFORE INSERT ON contacts
      WHEN NEW.name = 'Original' BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END`).run();
    await assert.rejects(h.advanceRestoreWriting(job.id), /forced insert failure/);
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'restoring');
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'test'")
      .first<{ count: number }>())?.count, 0);
    assert.equal((await h.db.prepare('SELECT apply_chunk_index FROM cloud_snapshot_restore_jobs WHERE id = ?')
      .bind(job.id).first<{ apply_chunk_index: number }>())?.apply_chunk_index, 0);
    await h.db.prepare('DROP TRIGGER test_restore_insert_fault').run();
    await written(h, job.id);
  } finally { await h.close(); }
});

test('a failed delete batch rolls back its temporary active lifecycle and remains retryable', {
  skip: process.env.CLOUD_TEST_RUNTIME === 'workerd' && 'Fault-injection trigger runs in the fast SQLite harness.',
}, async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Hold' } });
    const { job } = await prepared(h);
    await h.beginRestoreApply(job.id);
    await h.db.prepare(`CREATE TRIGGER test_restore_delete_fault BEFORE DELETE ON contacts
      WHEN OLD.name = 'Hold' BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END`).run();
    let failed = false;
    for (let index = 0; index < 60; index++) {
      try { await h.advanceRestoreDeletion(job.id); }
      catch (error) {
        assert.match(String(error), /forced delete failure/);
        failed = true;
        break;
      }
    }
    assert.equal(failed, true);
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'restoring');
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'test'")
      .first<{ count: number }>())?.count, 1);
    await h.db.prepare('DROP TRIGGER test_restore_delete_fault').run();
    let current = await h.advanceRestoreDeletion(job.id);
    for (let index = 0; current.state === 'deleting' && index < 10; index++) {
      current = await h.advanceRestoreDeletion(job.id);
    }
    assert.equal(current.state, 'awaiting_write');
  } finally { await h.close(); }
});

test('deletion removes at most 64 contacts in one step', {
  skip: process.env.CLOUD_TEST_RUNTIME === 'workerd' && 'Large-count boundary runs in the fast SQLite harness.',
}, async () => {
  const h = await createCloudHarness();
  try {
    const target = await publish(h);
    for (let index = 0; index < 130; index++) {
      await h.db.prepare("INSERT INTO contacts (workspace_id, name) VALUES ('test', ?)").bind(`Person ${index}`).run();
    }
    let job = await h.beginRestorePreparation(target.id);
    for (let index = 0; job.state === 'preparing' && index < 150; index++) {
      job = await h.advanceRestorePreparation(job.id);
    }
    assert.equal(job.state, 'ready');
    await h.beginRestoreApply(job.id);
    const before = (await h.db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'test'")
      .first<{ count: number }>())!.count;
    assert.equal(before, 130);
    let after = before;
    for (let index = 0; index < 30 && after === before; index++) {
      await h.advanceRestoreDeletion(job.id);
      after = (await h.db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'test'").first<{ count: number }>())!.count;
    }
    assert.equal(before - after, 64);
    assert.equal((await h.db.prepare("SELECT lifecycle FROM workspaces WHERE id = 'test'")
      .first<{ lifecycle: string }>())?.lifecycle, 'restoring');
  } finally { await h.close(); }
});

test('private v8 recovery rebuilds merged identities and a genuine v7 contact chunk defaults absent aliases', async () => {
  const h = await createCloudHarness();
  try {
    const a = (await h.call('contacts', { method: 'POST', body: { name: 'Ana', email: 'ana@example.test' } })).body.contact;
    const b = (await h.call('contacts', { method: 'POST', body: { name: 'Ana mobile', email: 'ana@example.test' } })).body.contact;
    const review = await h.call('contacts/duplicates');
    assert.equal((await h.call('contacts/duplicates', { method: 'POST', body: { primaryId: a.id, duplicateIds: [b.id], expectedRevision: review.body.revision } })).status, 200);
    const { target, job } = await prepared(h);
    await deleted(h, job.id); await written(h, job.id); await completed(h, job.id);
    assert.equal((await h.db.prepare('SELECT canonical_public_id FROM contact_merge_aliases WHERE public_id = ?').bind(b.public_id).first())?.canonical_public_id, a.public_id);
    assert.equal((await h.call('v3/sync/bootstrap')).body.records[0].data.merge_aliases, JSON.stringify([b.public_id]));
    // Re-sign the fixture exactly as an earlier private artifact, without the new column.
    const prefix = `test/recovery-jobs/${target.id}`, partKey = `${prefix}/manifest-parts/0.json`;
    const part = JSON.parse(await (await h.assets.get(partKey))!.text());
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const identity = { workspaceId: 'test', jobId: target.id };
    for (const descriptor of part.chunks) {
      if (descriptor.table_name !== 'contacts') continue;
      const chunk = JSON.parse(await (await h.assets.get(`${prefix}/chunks/${descriptor.sequence}-${descriptor.sha256}.json`))!.text());
      for (const row of chunk.rows) { delete row.merge_aliases; delete row.contact_methods; delete row.source_revision; }
      const bytes = encode(chunk); descriptor.sha256 = hash(bytes); descriptor.byte_length = bytes.byteLength;
      await h.assets.put(`${prefix}/chunks/${descriptor.sequence}-${descriptor.sha256}.json`, bytes,
        { customMetadata: { ...identity, sha256: descriptor.sha256, table: descriptor.table_name } });
    }
    const partBytes = encode(part), partHash = hash(partBytes);
    await h.assets.put(partKey, partBytes, { customMetadata: { ...identity, sha256: partHash } });
    const root = JSON.parse(await (await h.assets.get(`${prefix}/manifest-${target.manifest_sha256}.json`))!.text());
    assert.equal(root.snapshotSchemaVersion, 14);
    root.tableOrder = root.tableOrder.filter((table: string) => !['contact_source_links', 'contact_provider_links', 'provider_field_rules', 'contact_device_links', 'calendar_events', 'calendar_event_people', 'calendar_event_plans'].includes(table)); delete root.rowCounts.contact_source_links; delete root.rowCounts.contact_provider_links; delete root.rowCounts.provider_field_rules; delete root.rowCounts.contact_device_links; delete root.rowCounts.calendar_events; delete root.rowCounts.calendar_event_people; delete root.rowCounts.calendar_event_plans;
    root.snapshotSchemaVersion = 7; root.partsChainSha256 = hash(new TextEncoder().encode(`:${partHash}`));
    const rootBytes = encode(root), rootHash = hash(rootBytes);
    await h.assets.put(`${prefix}/manifest-${rootHash}.json`, rootBytes, { customMetadata: { ...identity, sha256: rootHash } });
    await h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET manifest_sha256 = ?, manifest_chain = ?, manifest_bytes = ? WHERE id = ?')
      .bind(rootHash, root.partsChainSha256, rootBytes.byteLength, target.id).run();
    let legacy = await h.beginRestorePreparation(target.id);
    for (let i = 0; legacy.state === 'preparing' && i < 100; i++) legacy = await h.advanceRestorePreparation(legacy.id);
    assert.equal(legacy.state, 'ready'); await deleted(h, legacy.id); await written(h, legacy.id); await completed(h, legacy.id);
    assert.equal((await h.db.prepare('SELECT merge_aliases FROM contacts').first())?.merge_aliases, '[]');
    assert.equal((await h.db.prepare('SELECT count(*) n FROM contact_merge_aliases').first())?.n, 0);
    assert.equal((await h.call('v3/sync/bootstrap')).body.records[0].id, a.public_id);
  } finally { await h.close(); }
});
