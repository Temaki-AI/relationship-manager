import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { DEVICE_TOKEN_PREFIX, parseDeviceCallback } from '../packages/domain/src/devices.ts';
import { readDeviceSources, readDeviceSourceMutation, type DeviceSourceMutation } from '../packages/domain/src/device-sources.ts';
import type { DeviceActor } from '../lib/cloud/device-api.ts';
import { readPullV3 } from '../packages/domain/src/sync-v3-client.ts';
import { WORKSPACE_ERASURE_CONFIRMATION } from '../lib/workspace-erasure-contract.ts';

type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
async function fixture() {
  const h = await createCloudHarness();
  await h.db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
    VALUES ('owner', 'Owner', 'owner@example.test', 1, 1, 1)`).run();
  await h.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner')").run();
  const verifier = randomBytes(32).toString('hex'), state = randomBytes(32).toString('hex');
  const approval = await h.authorizeDevice({ challenge: createHash('sha256').update(verifier).digest('base64url'), state, deviceName: 'iPhone' });
  assert.equal(approval.status, 200);
  const code = parseDeviceCallback((await approval.json()).callback, state), token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  assert.equal((await h.exchangeDevice({ code, state, verifier, token })).status, 200);
  const identity = await h.deviceWorkspace(token), actor: DeviceActor = { ...identity, lifecycle: 'active', authMethod: 'device', role: 'owner' };
  const person = (await h.call('contacts', { method: 'POST', body: { name: 'My Ana', notes: 'Private history', email: 'preferred@example.test' } })).body.contact;
  const epoch = (await h.call('v3/sync/bootstrap')).body.cursor.epoch;
  const facts = JSON.stringify({ device_id: 'os-person', name: 'Phone Ana', emails: [{ source_id: 'slot-1', value: 'source@example.test', label: 'Home' }], phones: [] });
  const body: DeviceSourceMutation = { operation_id: crypto.randomUUID(), epoch, action: 'publish', source_id: crypto.randomUUID(), contact_id: person.public_id,
    installation_id: crypto.randomUUID(), external_id: 'os-person', expected_revision: null, original_facts: facts, observed_facts: facts,
    applied_fields: JSON.stringify({ name: null, methods: [] }), observed_at: new Date().toISOString() };
  const push = (value = body) => h.call('v1/device-sources/push', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: value });
  return { h, actor, person, epoch, body, push, token };
}
async function count(h: Harness, table: string) { return (await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{ n: number }>())!.n; }
function unlink(body: DeviceSourceMutation, revision = 1): DeviceSourceMutation {
  return { operation_id: crypto.randomUUID(), epoch: body.epoch, action: 'unlink', source_id: body.source_id, contact_id: body.contact_id,
    installation_id: body.installation_id, external_id: body.external_id, expected_revision: revision };
}

test('shared iPhone observations publish to every contact projection without changing accepted fields or private history', async () => {
  const f = await fixture(); try {
    const { h, body, person } = f, start = (await h.call('v3/sync/bootstrap')).body;
    const first = await f.push(); assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.source.revision, 1);
    const changedFacts = JSON.stringify({ ...JSON.parse(body.original_facts!), name: 'New phone name' });
    const changed = await f.push({ ...body, operation_id: crypto.randomUUID(), expected_revision: 1, observed_facts: changedFacts });
    assert.equal(changed.status, 200, JSON.stringify(changed.body)); assert.equal(changed.body.source.revision, 2);
    assert.equal(changed.body.source.original_facts, body.original_facts);
    const current = (await h.call('contacts/' + person.id)).body.contact;
    assert.equal(current.name, person.name); assert.equal(current.notes, person.notes); assert.equal(current.email, person.email);
    for (const version of [1, 2, 3]) {
      const bootstrap = (await h.call(`v${version}/sync/bootstrap`)).body;
      const row = bootstrap.records.find((record: { id: string }) => record.id === person.public_id);
      assert.equal(readDeviceSources(row.data.device_links)[0].revision, 2);
    }
    const pull = (await h.call(`v3/sync/pull?epoch=${start.cursor.epoch}&sequence=${start.cursor.sequence}`)).body;
    assert.ok(readPullV3(pull, start.cursor).records.some((row) => row.data?.device_links && readDeviceSources(row.data.device_links).some((source) => source.revision === 2)));
    const listed = await h.call(`contacts/${person.id}/device-sources`); assert.equal(listed.body.links[0].public_id, body.source_id);
  } finally { await f.h.close(); }
});

test('source receipts retry uncertain saves exactly, reject changed intent and serialize competing source revisions', async () => {
  const f = await fixture(); try {
    const [a, b] = await Promise.all([f.push(), f.push()]); assert.equal(a.status, 200, JSON.stringify(a.body)); assert.deepEqual(a.body, b.body);
    assert.equal(await count(f.h, 'contact_device_links'), 1); assert.equal(await count(f.h, 'sync_mutation_receipts'), 1);
    assert.equal((await f.push({ ...f.body, observed_at: '2026-01-01T00:00:00.000Z' })).body.code, 'receipt_mismatch');
    const one = { ...f.body, operation_id: crypto.randomUUID(), expected_revision: 1 };
    const results = await Promise.all([f.push(one), f.push({ ...one, operation_id: crypto.randomUUID() })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]); assert.equal(await count(f.h, 'sync_mutation_receipts'), 2);
    assert.equal((await f.push()).body.source.revision, 2);
    assert.equal((await f.push({ ...f.body, operation_id: crypto.randomUUID(), source_id: crypto.randomUUID() })).status, 409);
    assert.equal((await f.push({ ...one, operation_id: crypto.randomUUID(), expected_revision: 2, original_facts: JSON.stringify({ ...JSON.parse(f.body.original_facts!), name: 'Changed original' }) })).status, 409);
  } finally { await f.h.close(); }
});

test('the same operating-system ID on two phone installations remains separate and merges retain canonical provenance', async () => {
  const f = await fixture(); try {
    await f.push();
    const second = { ...f.body, operation_id: crypto.randomUUID(), source_id: crypto.randomUUID(), installation_id: crypto.randomUUID() };
    assert.equal((await f.push(second)).status, 200);
    const survivor = (await f.h.call('contacts', { method: 'POST', body: { name: 'Survivor', notes: 'Keep me', email: f.person.email } })).body.contact;
    const review = await f.h.call('contacts/duplicates');
    const merge = await f.h.call('contacts/duplicates', { method: 'POST', body: { primaryId: survivor.id, duplicateIds: [f.person.id], expectedRevision: review.body.revision } });
    assert.equal(merge.status, 200, JSON.stringify(merge.body));
    const sources = (await f.h.call(`contacts/${survivor.id}/device-sources`)).body.links;
    assert.equal(readDeviceSources(JSON.stringify(sources)).length, 2);
    assert.equal((await f.push()).body.contact_id, survivor.public_id);
    const changed = await f.push({ ...f.body, operation_id: crypto.randomUUID(), expected_revision: 1 });
    assert.equal(changed.status, 200, JSON.stringify(changed.body)); assert.equal(changed.body.contact_id, survivor.public_id);
  } finally { await f.h.close(); }
});

test('explicit web unlink retains copied fields, exact retries succeed and deleted sources or people are never resurrected', async () => {
  const f = await fixture(); try {
    await f.push(); const removal = unlink(f.body);
    assert.equal((await f.h.call('v1/device-sources/push', { method: 'POST', body: removal })).status, 403);
    const web = () => f.h.call('v1/device-sources/push', { method: 'POST', body: removal, headers: { Origin: String(f.h.emailEnv.BETTER_AUTH_URL) } });
    assert.equal((await web()).status, 200); assert.equal((await web()).status, 200);
    assert.equal((await f.h.call('contacts/' + f.person.id)).body.contact.email, f.person.email);
    assert.equal((await f.push()).body.code, 'source_missing');
    assert.equal((await f.push({ ...f.body, operation_id: crypto.randomUUID() })).status, 409); assert.equal(await count(f.h, 'contact_device_links'), 0);
    const next = { ...f.body, operation_id: crypto.randomUUID(), source_id: crypto.randomUUID() }; assert.equal((await f.push(next)).status, 200);
    assert.equal((await f.h.call('contacts/' + f.person.id, { method: 'DELETE' })).status, 200);
    assert.equal((await f.push(next)).body.code, 'source_missing'); assert.equal(await count(f.h, 'contact_device_links'), 0);
  } finally { await f.h.close(); }
});

test('authentication, revision, restore and maintenance fences roll back both receipts and source metadata', async () => {
  const f = await fixture(); try {
    assert.equal((await f.h.call('v1/device-sources/push', { method: 'POST', body: f.body, headers: { Origin: String(f.h.emailEnv.BETTER_AUTH_URL) } })).body.code, 'device_required');
    assert.equal((await f.push({ ...f.body, contact_id: crypto.randomUUID() })).body.code, 'person_missing');
    assert.equal((await f.push({ ...f.body, epoch: crypto.randomUUID() })).body.code, 'epoch_changed');
    await f.h.db.prepare("UPDATE workspace_sync_state SET paused = 1 WHERE workspace_id = 'test'").run();
    assert.equal((await f.push()).status, 423); await f.h.db.prepare("UPDATE workspace_sync_state SET paused = 0 WHERE workspace_id = 'test'").run();
    // Revoke after the pre-read to exercise the SQL authorization fence in the write transaction.
    const db = { prepare: f.h.db.prepare.bind(f.h.db), batch: async (statements: Parameters<typeof f.h.db.batch>[0]) => {
      await f.h.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), f.actor.deviceId!).run();
      return f.h.db.batch(statements);
    } } as unknown as CloudflareEnv['DB'];
    await assert.rejects(f.h.deviceSources.pushDeviceSource(db, f.actor, f.body), /session is no longer valid/);
    assert.equal(await count(f.h, 'contact_device_links'), 0); assert.equal(await count(f.h, 'sync_mutation_receipts'), 0);
    assert.equal((await f.push()).status, 401);
  } finally { await f.h.close(); }
});

test('a per-person source limit rejects the entire mutation without a receipt', async () => {
  const f = await fixture(); try {
    for (let i = 0; i < 32; i++) assert.equal((await f.push({ ...f.body, operation_id: crypto.randomUUID(), source_id: crypto.randomUUID(), installation_id: crypto.randomUUID() })).status, 200);
    const excess = await f.push(); assert.equal(excess.status, 413, JSON.stringify(excess.body)); assert.equal(excess.body.code, 'source_capacity');
    assert.equal(await count(f.h, 'contact_device_links'), 32); assert.equal(await count(f.h, 'sync_mutation_receipts'), 32);
    const backup = (await f.h.call('settings/backups', { method: 'POST' })).body.backup, snapshot = (await f.h.call('settings/backups/' + backup.filename)).body;
    snapshot.tables.contact_device_links.push({ ...snapshot.tables.contact_device_links[0], id: 999, public_id: crypto.randomUUID(), installation_id: crypto.randomUUID() });
    assert.throws(() => f.h.validateCloudSnapshot(snapshot, 'test'), /source|provenance|collection/i);
  } finally { await f.h.close(); }
});

test('source byte limits and the complete contact projection bound roll back source and later profile writes', async () => {
  const f = await fixture(); try {
    const largeFacts = JSON.stringify({ device_id: f.body.external_id, name: 'Ana', phones: [], emails: Array.from({ length: 55 }, (_, i) => ({ source_id: String(i), value: 'x'.repeat(280) + '@example.test', label: null })) });
    await f.h.db.prepare('UPDATE contacts SET notes = ? WHERE id = ?').bind('n'.repeat(500000), f.person.id).run();
    const excess = await f.push({ ...f.body, original_facts: largeFacts, observed_facts: largeFacts });
    assert.equal(excess.status, 413, JSON.stringify(excess.body)); assert.equal(await count(f.h, 'sync_mutation_receipts'), 0); assert.equal(await count(f.h, 'contact_device_links'), 0);
    assert.equal((await f.push()).status, 200);
    await assert.rejects(f.h.db.prepare('UPDATE contacts SET notes = ? WHERE id = ?').bind('n'.repeat(521500), f.person.id).run(), /CONTACT_SYNC_LIMIT/);
    assert.equal((await f.h.db.prepare('SELECT length(notes) n FROM contacts WHERE id = ?').bind(f.person.id).first())!.n, 500000);
    const backup = (await f.h.call('settings/backups', { method: 'POST' })).body.backup, snapshot = (await f.h.call('settings/backups/' + backup.filename)).body;
    snapshot.tables.contact_device_links[0].original_facts = largeFacts; snapshot.tables.contact_device_links[0].observed_facts = largeFacts;
    assert.throws(() => f.h.validateCloudSnapshot(snapshot, 'test'), /too large for device sync/);
    await f.h.db.prepare("UPDATE contacts SET notes = '' WHERE id = ?").bind(f.person.id).run();
    await f.push(unlink(f.body));
    let accepted = 0, rejected = false;
    for (let i = 0; i < 5; i++) {
      const result = await f.push({ ...f.body, operation_id: crypto.randomUUID(), source_id: crypto.randomUUID(), installation_id: crypto.randomUUID(), original_facts: largeFacts, observed_facts: largeFacts });
      if (result.status === 413) { rejected = true; break; } assert.equal(result.status, 200, JSON.stringify(result.body)); accepted++;
    }
    assert.equal(rejected, true); assert.ok(accepted >= 2); assert.equal(await count(f.h, 'contact_device_links'), accepted);
    assert.equal(await count(f.h, 'sync_mutation_receipts'), accepted + 2);
  } finally { await f.h.close(); }
});

test('workspace erasure removes shared provenance and its receipts along with the person', async () => {
  const f = await fixture(); try {
    assert.equal((await f.push()).status, 200);
    assert.equal((await f.h.call('settings/erase', { method: 'POST', body: { confirmation: WORKSPACE_ERASURE_CONFIRMATION } })).status, 200);
    assert.equal(await count(f.h, 'contact_device_links'), 0); assert.equal(await count(f.h, 'sync_mutation_receipts'), 0); assert.equal(await count(f.h, 'contacts'), 0);
    assert.equal((await f.push()).status, 401);
  } finally { await f.h.close(); }
});

test('schema-13 portable recovery retains device provenance, validates its graph and accepts genuine schema-12 absence', async () => {
  const f = await fixture(); try {
    await f.push(); const backup = (await f.h.call('settings/backups', { method: 'POST' })).body.backup;
    const snapshot = (await f.h.call('settings/backups/' + backup.filename)).body; assert.equal(snapshot.version, 14); assert.equal(snapshot.tables.contact_device_links.length, 1);
    const broken = structuredClone(snapshot); broken.tables.contact_device_links[0].contact_id = 99999; assert.throws(() => f.h.validateCloudSnapshot(broken, 'test'), /Missing|parent/);
    const badIdentity = structuredClone(snapshot); badIdentity.tables.contact_device_links[0].external_id = 'another-os-id'; assert.throws(() => f.h.validateCloudSnapshot(badIdentity, 'test'), /identity|observations/);
    assert.equal((await f.push(unlink(f.body))).status, 200);
    assert.equal((await f.h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200);
    assert.equal((await f.h.call(`contacts/${f.person.id}/device-sources`)).body.links[0].original_facts, f.body.original_facts);
    assert.equal((await f.push()).body.code, 'epoch_changed');
    const old = structuredClone(snapshot); old.version = 12; delete old.tables.contact_device_links;
    assert.equal((await f.h.call('settings/restore', { method: 'POST', body: old, headers: { 'X-Bonds-Restore-Confirmation': 'RESTORE' } })).status, 200);
    assert.equal(await count(f.h, 'contact_device_links'), 0);
  } finally { await f.h.close(); }
});

test('bounded private capture and restoration include shared source details and observe source revision changes', async () => {
  const f = await fixture(); try {
    await f.push(); let capture = await f.h.beginCapture();
    for (let i = 0; capture.state === 'capturing' && i < 100; i++) capture = await f.h.advanceCapture(capture.id);
    for (let i = 0; capture.state === 'awaiting_verification' && i < 100; i++) capture = await f.h.advanceCaptureVerification(capture.id);
    assert.equal(capture.state, 'manifest_ready', JSON.stringify(capture));
    const root = JSON.parse(await (await f.h.assets.get(`test/recovery-jobs/${capture.id}/manifest-${capture.manifest_sha256}.json`))!.text());
    assert.equal(root.snapshotSchemaVersion, 14); assert.equal(root.rowCounts.contact_device_links, 1);
    await f.push(unlink(f.body)); let restore = await f.h.beginRestorePreparation(capture.id);
    for (let i = 0; restore.state === 'preparing' && i < 100; i++) restore = await f.h.advanceRestorePreparation(restore.id);
    assert.equal(restore.state, 'ready'); restore = await f.h.beginRestoreApply(restore.id);
    for (let i = 0; restore.state === 'deleting' && i < 100; i++) restore = await f.h.advanceRestoreDeletion(restore.id);
    for (let i = 0; ['awaiting_write', 'writing'].includes(restore.state) && i < 100; i++) restore = await f.h.advanceRestoreWriting(restore.id);
    for (let i = 0; restore.state === 'repairing_dates' && i < 100; i++) restore = await f.h.advanceRestoreDateRepair(restore.id);
    for (let i = 0; restore.state === 'verifying' && i < 100; i++) restore = await f.h.advanceRestoreVerification(restore.id);
    assert.equal(restore.state, 'completed', JSON.stringify(restore)); assert.equal(await count(f.h, 'contact_device_links'), 1);
    const stale = await f.h.beginCapture(), epoch = (await f.h.call('v3/sync/bootstrap')).body.cursor.epoch;
    await f.push({ ...f.body, operation_id: crypto.randomUUID(), epoch, expected_revision: 1 });
    await assert.rejects(f.h.advanceCapture(stale.id), /Workspace changed during capture/);
  } finally { await f.h.close(); }
});

test('genuine schema-12 private manifests normalize the absent device-source table while retaining their original part chain', async () => {
  const f = await fixture(); try {
    // No device-source parts: this is the graph an actual schema-12 capture could contain.
    let capture = await f.h.beginCapture();
    for (let i = 0; capture.state === 'capturing' && i < 100; i++) capture = await f.h.advanceCapture(capture.id);
    for (let i = 0; capture.state === 'awaiting_verification' && i < 100; i++) capture = await f.h.advanceCaptureVerification(capture.id);
    assert.equal(capture.state, 'manifest_ready');
    const prefix = `test/recovery-jobs/${capture.id}`, root = JSON.parse(await (await f.h.assets.get(`${prefix}/manifest-${capture.manifest_sha256}.json`))!.text());
    const chain = root.partsChainSha256; root.snapshotSchemaVersion = 12;
    root.tableOrder = root.tableOrder.filter((table: string) => !['contact_device_links', 'calendar_events', 'calendar_event_people', 'calendar_event_plans'].includes(table)); delete root.rowCounts.contact_device_links; delete root.rowCounts.calendar_events; delete root.rowCounts.calendar_event_people; delete root.rowCounts.calendar_event_plans;
    const bytes = new TextEncoder().encode(JSON.stringify(root)), hash = createHash('sha256').update(bytes).digest('hex');
    await f.h.assets.put(`${prefix}/manifest-${hash}.json`, bytes, { customMetadata: { workspaceId: 'test', jobId: capture.id, sha256: hash } });
    await f.h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET manifest_sha256 = ?, manifest_bytes = ? WHERE id = ?').bind(hash, bytes.byteLength, capture.id).run();
    let reader = await f.h.beginSnapshotRead(capture.id);
    for (let i = 0; reader.state === 'reading' && i < 100; i++) reader = await f.h.advanceSnapshotRead(reader.id);
    assert.equal(reader.state, 'verified', JSON.stringify(reader)); assert.equal(reader.part_chain, chain); assert.equal(JSON.parse(reader.row_counts).contact_device_links, 0);
    let restore = await f.h.beginRestorePreparation(capture.id);
    for (let i = 0; restore.state === 'preparing' && i < 100; i++) restore = await f.h.advanceRestorePreparation(restore.id);
    assert.equal(restore.state, 'ready'); restore = await f.h.beginRestoreApply(restore.id);
    for (let i = 0; restore.state === 'deleting' && i < 100; i++) restore = await f.h.advanceRestoreDeletion(restore.id);
    for (let i = 0; ['awaiting_write', 'writing'].includes(restore.state) && i < 100; i++) restore = await f.h.advanceRestoreWriting(restore.id);
    for (let i = 0; restore.state === 'repairing_dates' && i < 100; i++) restore = await f.h.advanceRestoreDateRepair(restore.id);
    for (let i = 0; restore.state === 'verifying' && i < 100; i++) restore = await f.h.advanceRestoreVerification(restore.id);
    assert.equal(restore.state, 'completed', JSON.stringify(restore)); assert.equal(await count(f.h, 'contact_device_links'), 0); assert.equal(await count(f.h, 'contacts'), 1);
  } finally { await f.h.close(); }
});

test('device-source contracts reject oversized, foreign and duplicate identities while allowing the same ID on different phones', () => {
  const facts = JSON.stringify({ device_id: 'opaque-id', name: 'Ana', emails: [], phones: [] }), now = new Date().toISOString();
  const source = { public_id: crypto.randomUUID(), installation_id: crypto.randomUUID(), external_id: 'opaque-id', original_facts: facts, observed_facts: facts,
    applied_fields: '{"name":null,"methods":[]}', revision: 1, observed_at: now, created_at: now, updated_at: now };
  assert.equal(readDeviceSources(JSON.stringify([source, { ...source, public_id: crypto.randomUUID(), installation_id: crypto.randomUUID() }])).length, 2);
  for (const rows of [[{ ...source, provider: 'google' }], [source, source], [source, { ...source, public_id: crypto.randomUUID() }], [{ ...source, external_id: 'foreign-id' }], [{ ...source, observed_at: 'invalid' }]]) assert.throws(() => readDeviceSources(JSON.stringify(rows)));
  assert.throws(() => readDeviceSources(' '.repeat(131073)));
  const mutation = { source_id: source.public_id, installation_id: source.installation_id, external_id: source.external_id, original_facts: facts, observed_facts: facts, applied_fields: source.applied_fields, observed_at: now,
    operation_id: crypto.randomUUID(), contact_id: crypto.randomUUID(), epoch: crypto.randomUUID(), action: 'publish', expected_revision: null };
  assert.deepEqual(readDeviceSourceMutation(mutation).external_id, source.external_id);
  assert.throws(() => readDeviceSourceMutation({ ...mutation, private_notes: 'must not be sent' }));
  assert.throws(() => readDeviceSourceMutation({ ...mutation, original_facts: JSON.stringify({ ...JSON.parse(facts), device_id: 'foreign-id' }) }));
});
