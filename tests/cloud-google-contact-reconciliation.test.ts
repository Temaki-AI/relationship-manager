import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { googleActor as actor, googleEnvironment as environment, stagedGoogleContact, googleImportBody, currentPerson, googlePerson } from './helpers/google-contact-fixture.ts';
import { readContactMethods } from '../packages/domain/src/contact-methods.ts';
import { readProviderFacts } from '../packages/domain/src/provider-sources.ts';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';
import { createHash } from 'node:crypto';
type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
async function setup(h: Harness, follow = false) {
  const staged = await stagedGoogleContact(h), body = googleImportBody(staged.preview, { keep_updated: follow });
  const imported = await h.contactImports.importGoogleContact(h.db, actor, environment, staged.connection.id, body, crypto.randomUUID());
  return { ...staged, imported };
}
async function rules(h: Harness, id: number) { return h.contactImports.savedProviderSources(h.db, actor, id); }
async function control(h: Harness, id: number, body: Record<string, unknown>) {
  const saved = await rules(h, id), link = saved.links[0];
  return h.fieldControls.changeProviderFields(h.db, actor, id, link.public_id, { expected_epoch: saved.epoch, expected_revision: link.revision,
    expected_policy_revision: saved.rules[0].revision, expected_edit_revision: saved.contact.edit_revision, ...body });
}
async function refresh(h: Harness, staged: Awaited<ReturnType<typeof setup>>, people: unknown[], full = true) {
  const run = await h.contactDownloads.startGoogleContactsDownload(h.db, actor, environment, staged.connection.id,
    { operation_id: crypto.randomUUID(), expected_epoch: staged.epoch, expected_authorization_revision: staged.connection.authorization_revision, full });
  const input = { kind: 'google-contacts' as const, version: 1 as const, workspaceId: 'test', connectionId: staged.connection.id, runId: run.id };
  let result;
  for (let i = 0; i < 20; i++) {
    result = await h.contactDownloads.advanceGoogleContactsDownload(h.db, environment, input, async () => Response.json({ connections: people, nextSyncToken: 'next-cursor' }));
    if (result.status !== 'active') break;
  }
  assert.equal(result!.status, 'complete', JSON.stringify(await h.db.prepare('SELECT * FROM provider_contact_runs WHERE id = ?').bind(run.id).first())); return { run, input };
}
test('new downloads update observations for kept fields and apply only explicitly followed values', async () => {
  const h = await createCloudHarness(); try {
    const s = await setup(h), id = s.imported.contact_id, changed = googlePerson(); changed.emailAddresses[0].value = 'new@example.test'; changed.phoneNumbers[0].canonicalForm = '+351912000000'; changed.names[0].displayName = 'Changed Google Ana';
    await refresh(h, s, [changed]); const saved = await rules(h, id);
    assert.equal((await currentPerson(h, id)).email, 'ana@example.test'); assert.equal(readProviderFacts(saved.links[0].observed_facts).name, 'Changed Google Ana'); assert.equal(saved.links[0].original_facts, s.imported.source.original_facts);
    const emailRule = saved.rules[0].fields.methods.find((m) => m.kind === 'email')!;
    await control(h, id, { action: 'settings', methods: [{ id: emailRule.id, mode: 'follow' }] });
    assert.equal((await currentPerson(h, id)).email, 'new@example.test'); assert.equal((await currentPerson(h, id)).phone, '+351912345678');
    changed.emailAddresses[0].value = 'later@example.test'; await refresh(h, s, [changed], false);
    assert.equal((await currentPerson(h, id)).email, 'later@example.test'); assert.equal((await currentPerson(h, id)).name, 'My Ana');
  } finally { await h.close(); }
});
test('web corrections and removals remain sticky across change-back edits and later downloads; other followed values continue', async () => {
  const h = await createCloudHarness(); try {
    const s = await setup(h, true), id = s.imported.contact_id;
    await control(h, id, { action: 'reset', field: 'name' }); await control(h, id, { action: 'settings', name_mode: 'follow' });
    let current = await currentPerson(h, id);
    await h.call('contacts/' + id, { method: 'PATCH', body: { name: 'My correction', email: 'mine@example.test', notes: 'Private note', expected_edit_revision: current.edit_revision } });
    current = await currentPerson(h, id); assert.equal(current.name, 'My correction');
    await h.call('contacts/' + id, { method: 'PATCH', body: { name: 'Google Ana', email: 'ana@example.test', expected_edit_revision: current.edit_revision } });
    const changed = googlePerson(); changed.names[0].displayName = 'Other name'; changed.emailAddresses[0].value = 'other@example.test'; changed.phoneNumbers[0].value = '+351912000000'; changed.phoneNumbers[0].canonicalForm = '+351912000000';
    await refresh(h, s, [changed]); current = await currentPerson(h, id);
    assert.equal(current.name, 'Google Ana'); assert.equal(current.email, 'ana@example.test'); assert.equal(current.phone, '+351912000000'); assert.equal(current.notes, 'Private note');
    const saved = await rules(h, id); assert.equal(saved.rules[0].fields.name.overridden, true); const emailRule = saved.rules[0].fields.methods.find((m) => m.kind === 'email')!; assert.equal(emailRule.overridden, true);
    await control(h, id, { action: 'reset', field: 'method', method_id: emailRule.id, source_index: 0 }); assert.equal((await currentPerson(h, id)).email, 'other@example.test'); assert.equal((await rules(h, id)).rules[0].fields.methods.find((m) => m.kind === 'email')!.overridden, false);
    current = await currentPerson(h, id); const methods = readContactMethods(current.contact_methods).filter((m) => m.kind !== 'email');
    const removed = await h.call('contacts/' + id, { method: 'PATCH', body: { contact_methods: methods, expected_edit_revision: current.edit_revision } }); assert.equal(removed.status, 200);
    await refresh(h, s, [changed]); assert.equal(readContactMethods((await currentPerson(h, id)).contact_methods).some((m) => m.kind === 'email'), false);
    await control(h, id, { action: 'reset', field: 'method', method_id: emailRule.id, source_index: 0 }); assert.equal((await currentPerson(h, id)).email, null); assert.equal(readContactMethods((await currentPerson(h, id)).contact_methods).find((m) => m.kind === 'email')!.id, emailRule.id);
  } finally { await h.close(); }
});
test('source deletion keeps the relationship; reappearance resumes unchanged followed methods and additional fields require review', async () => {
  const h = await createCloudHarness(); try {
    const s = await setup(h, true), id = s.imported.contact_id;
    await refresh(h, s, []); assert.equal((await rules(h, id)).links[0].status, 'unavailable'); assert.equal((await currentPerson(h, id)).email, 'ana@example.test');
    const changed = googlePerson(); changed.emailAddresses[0].value = 'returned@example.test'; changed.emailAddresses[1].value = 'added@example.test';
    await refresh(h, s, [changed]); const current = await currentPerson(h, id); assert.equal(current.email, 'returned@example.test'); assert.equal(readContactMethods(current.contact_methods).length, 2);
    await control(h, id, { action: 'accept', emails: [1], phones: [], follow: true });
    const accepted = await currentPerson(h, id); assert.equal(accepted.email, 'returned@example.test'); assert.equal(readContactMethods(accepted.contact_methods).length, 3); assert.equal((await rules(h, id)).rules[0].fields.methods.length, 3);
    changed.emailAddresses[1].value = 'additional-change@example.test'; await refresh(h, s, [changed]); assert.ok(readContactMethods((await currentPerson(h, id)).contact_methods).some((m) => m.value === 'additional-change@example.test'));
  } finally { await h.close(); }
});
test('an offline sync correction and its exact replay protect a followed field while updated observations still reach the replica', async () => {
  const h = await createCloudHarness(); try {
    const s = await setup(h, true), id = s.imported.contact_id, bootstrap = (await h.call('v3/sync/bootstrap')).body;
    const record = bootstrap.records.find((r: { entity: string }) => r.entity === 'contact');
    const mutation = { operationId: crypto.randomUUID(), entity: 'contact', entityId: record.id, type: 'update', baseRevision: record.revision,
      base: { email: record.data.email }, patch: { email: 'offline@example.test' } };
    const body = { version: 3, epoch: bootstrap.cursor.epoch, mutation };
    const edited = await h.call('v3/sync/push', { method: 'POST', body }); assert.equal(edited.status, 200, JSON.stringify(edited.body)); assert.equal(edited.body.result.status, 'applied');
    assert.equal((await h.call('v3/sync/push', { method: 'POST', body })).body.replayed, true);
    assert.equal((await rules(h, id)).rules[0].fields.methods.find((m) => m.kind === 'email')!.overridden, true);
    const changed = googlePerson(); changed.emailAddresses[0].value = 'provider@example.test'; await refresh(h, s, [changed]);
    const pulled = (await h.call('v3/sync/bootstrap')).body.records.find((r: { entity: string }) => r.entity === 'contact');
    assert.equal(pulled.data.email, 'offline@example.test'); assert.equal(readProviderFacts(JSON.parse(pulled.data.provider_links)[0].observed_facts).emails[0].value, 'provider@example.test');
  } finally { await h.close(); }
});
test('a concurrent correction rejects stale field controls and reconciliation retries from fresh values without overwriting it', async () => {
  const h = await createCloudHarness(); try {
    const s = await setup(h, true), id = s.imported.contact_id, before = await rules(h, id);
    const run = await h.contactDownloads.startGoogleContactsDownload(h.db, actor, environment, s.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: s.epoch, expected_authorization_revision: s.connection.authorization_revision, full: true });
    const input = { kind: 'google-contacts' as const, version: 1 as const, workspaceId: 'test', connectionId: s.connection.id, runId: run.id };
    const changed = googlePerson(); changed.emailAddresses[0].value = 'remote@example.test';
    await h.contactDownloads.advanceGoogleContactsDownload(h.db, environment, input, async () => Response.json({ connections: [changed], nextSyncToken: 'cursor' }));
    let injected = false;
    const db = { prepare: h.db.prepare.bind(h.db), batch: async (statements: Parameters<typeof h.db.batch>[0]) => {
      if (!injected && statements.length > 4) { injected = true; const current = await currentPerson(h, id); const r = await h.call('contacts/' + id, { method: 'PATCH', body: { email: 'my-correction@example.test', expected_edit_revision: current.edit_revision } }); assert.equal(r.status, 200); }
      return h.db.batch(statements);
    } } as typeof h.db;
    const result = await h.contactDownloads.advanceGoogleContactsDownload(db, environment, input); assert.equal(result.status, 'active'); assert.equal(result.advanced, false);
    assert.equal((await currentPerson(h, id)).email, 'my-correction@example.test'); assert.equal((await rules(h, id)).links[0].observed_facts, before.links[0].observed_facts);
    await h.db.prepare('UPDATE provider_contact_runs SET next_attempt_at = 0 WHERE id = ?').bind(run.id).run();
    assert.equal((await h.contactDownloads.advanceGoogleContactsDownload(h.db, environment, input)).status, 'complete'); assert.equal((await currentPerson(h, id)).email, 'my-correction@example.test');
    await assert.rejects(h.fieldControls.changeProviderFields(h.db, actor, id, before.links[0].public_id, { action: 'settings', expected_epoch: before.epoch, expected_revision: before.links[0].revision,
      expected_policy_revision: before.rules[0].revision, expected_edit_revision: before.contact.edit_revision, name_mode: 'follow' }), /changed/);
  } finally { await h.close(); }
});
test('automatic downloads are off by default, opt in at bounded frequency, and disabling cancels scheduled work while keeping manual work', async () => {
  const h = await createCloudHarness(); try {
    const s = await setup(h), c = s.connection, queue = { send: async () => {} };
    let review = await h.contactDownloads.reviewGoogleContacts(h.db, actor, c.id); assert.equal(review.schedule.enabled, false);
    const body = { expected_epoch: s.epoch, expected_authorization_revision: c.authorization_revision, expected_settings_revision: review.schedule.revision, enabled: true, interval: 86400 };
    await h.contactDownloads.changeGoogleContactsSchedule(h.db, actor, c.id, body); assert.equal(await h.contactDownloads.startDueGoogleContactsDownloads(h.db, queue, environment), 1); assert.equal(await h.contactDownloads.startDueGoogleContactsDownloads(h.db, queue, environment), 0);
    await assert.rejects(h.contactDownloads.changeGoogleContactsSchedule(h.db, actor, c.id, body), /changed/);
    review = await h.contactDownloads.reviewGoogleContacts(h.db, actor, c.id); const scheduled = review.run!;
    await h.contactDownloads.changeGoogleContactsSchedule(h.db, actor, c.id, { ...body, enabled: false, expected_settings_revision: review.schedule.revision });
    assert.equal((await h.db.prepare('SELECT status FROM provider_contact_runs WHERE id = ?').bind(scheduled.id).first<{ status: string }>())!.status, 'cancelled');
    const manual = await h.contactDownloads.startGoogleContactsDownload(h.db, actor, environment, c.id, { operation_id: crypto.randomUUID(), expected_epoch: s.epoch, expected_authorization_revision: c.authorization_revision });
    review = await h.contactDownloads.reviewGoogleContacts(h.db, actor, c.id);
    await h.contactDownloads.changeGoogleContactsSchedule(h.db, actor, c.id, { ...body, interval: 3600, expected_settings_revision: review.schedule.revision });
    assert.equal((await h.db.prepare('SELECT status FROM provider_contact_runs WHERE id = ?').bind(manual.id).first<{ status: string }>())!.status, 'active');
    assert.equal(getCloudApiRewrite('/api/connections/' + c.id + '/contacts/schedule'), '/api/cloud/connections/' + c.id + '/contacts/schedule');
  } finally { await h.close(); }
});
test('field controls enforce web ownership, origin, bounded bodies and eligible method identities', async () => {
  const h = await createCloudHarness(); try {
    const s = await setup(h), saved = await rules(h, s.imported.contact_id), link = saved.links[0], path = ['contacts', String(s.imported.contact_id), 'provider-sources', link.public_id];
    const body = { action: 'settings', expected_epoch: saved.epoch, expected_revision: link.revision, expected_policy_revision: 0, expected_edit_revision: saved.contact.edit_revision, methods: [{ id: crypto.randomUUID(), mode: 'follow' }] };
    const request = (origin: string, value: unknown = body) => new Request(environment.BETTER_AUTH_URL + '/' + path.join('/'), { method: 'PATCH', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal((await h.providerSourceApi.handleProviderSources(request('https://foreign.invalid'), actor, path)).status, 403);
    assert.equal((await h.providerSourceApi.handleProviderSources(request(environment.BETTER_AUTH_URL), { ...actor, authMethod: 'device' }, path)).status, 403);
    assert.equal((await h.providerSourceApi.handleProviderSources(request(environment.BETTER_AUTH_URL), actor, path)).status, 400);
    assert.equal((await h.providerSourceApi.handleProviderSources(request(environment.BETTER_AUTH_URL, { ...body, huge: 'a'.repeat(33000) }), actor, path)).status, 413);
    assert.equal((await h.providerSourceApi.handleProviderSources(request(environment.BETTER_AUTH_URL, { ...body, methods: [] }), actor, path)).status, 200);
  } finally { await h.close(); }
});
test('merging preserves sources and methods while suspending followed authorities for explicit review', async () => {
  const h = await createCloudHarness(); try {
    const staged = await stagedGoogleContact(h, [googlePerson(), googlePerson('b')]);
    const first = await h.contactImports.importGoogleContact(h.db, actor, environment, staged.connection.id, googleImportBody(staged.preview, { create_name: 'Google Ana', keep_updated: true }), crypto.randomUUID());
    const query = new URLSearchParams({ generation: staged.preview.generation!, source_id: 'b' }), preview = await h.contactImports.googleImportPreview(h.db, actor, staged.connection.id, query);
    const second = await h.contactImports.importGoogleContact(h.db, actor, environment, staged.connection.id, googleImportBody(preview, { create_name: 'Google Ana', keep_updated: true }), crypto.randomUUID());
    const review = await h.call('contacts/duplicates'), merged = await h.call('contacts/duplicates', { method: 'POST', body: { primaryId: first.contact_id, duplicateIds: [second.contact_id], expectedRevision: review.body.revision } });
    assert.equal(merged.status, 200, JSON.stringify(merged.body)); const saved = await rules(h, first.contact_id);
    assert.equal(saved.links.length, 2); assert.ok(saved.rules.every((rule) => rule.fields.name.mode === 'keep' && rule.fields.name.overridden));
    assert.ok(saved.rules.every((rule) => rule.fields.methods.every((method) => method.mode === 'keep' && method.overridden)));
    await control(h, first.contact_id, { action: 'settings', name_mode: 'follow' });
    const other = saved.links[1], fresh = await rules(h, first.contact_id);
    await assert.rejects(h.fieldControls.changeProviderFields(h.db, actor, first.contact_id, other.public_id, { action: 'settings', name_mode: 'follow',
      expected_epoch: fresh.epoch, expected_revision: other.revision, expected_policy_revision: fresh.rules[1].revision, expected_edit_revision: fresh.contact.edit_revision }), /PROVIDER_RULE_AUTHORITY/);
  } finally { await h.close(); }
});
test('recovery retains field choices and overrides, discards recurring permissions, and rejects invalid rule graphs', async () => {
  const h = await createCloudHarness(); try {
    const s = await setup(h, true), id = s.imported.contact_id, current = await currentPerson(h, id);
    await h.call('contacts/' + id, { method: 'PATCH', body: { email: 'private@example.test', expected_edit_revision: current.edit_revision } });
    const saved = await rules(h, id), review = await h.contactDownloads.reviewGoogleContacts(h.db, actor, s.connection.id);
    await h.contactDownloads.changeGoogleContactsSchedule(h.db, actor, s.connection.id, { expected_epoch: s.epoch, expected_authorization_revision: s.connection.authorization_revision,
      expected_settings_revision: review.schedule.revision, enabled: true, interval: 86400 });
    const backup = (await h.call('settings/backups', { method: 'POST' })).body.backup, snapshot = (await h.call('settings/backups/' + backup.filename)).body;
    assert.equal(snapshot.version, 14); assert.equal(snapshot.tables.provider_field_rules.length, 1); assert.ok(!JSON.stringify(snapshot).includes('sync_enabled'));
    const malformed = structuredClone(snapshot); malformed.tables.provider_field_rules[0].source_link_id = 999; assert.throws(() => h.validateCloudSnapshot(malformed, 'test'), /Missing or repeated/);
    const unknown = structuredClone(snapshot), fields = JSON.parse(unknown.tables.provider_field_rules[0].fields); fields.methods[0].id = crypto.randomUUID(); unknown.tables.provider_field_rules[0].fields = JSON.stringify(fields); assert.throws(() => h.validateCloudSnapshot(unknown, 'test'), /unaccepted/);
    await h.contactImports.unlinkProviderSource(h.db, actor, id, saved.links[0].public_id, { expected_epoch: s.epoch, expected_revision: saved.links[0].revision });
    assert.equal((await h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } })).status, 200);
    const restored = await rules(h, id); assert.deepEqual(restored.rules[0].fields, saved.rules[0].fields);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM provider_contact_resources').first<{ n: number }>())!.n, 0);
    const old = structuredClone(snapshot); old.version = 11; delete old.tables.provider_field_rules; delete old.tables.contact_device_links;
    assert.equal((await h.call('settings/restore', { method: 'POST', body: old, headers: { 'X-Bonds-Restore-Confirmation': 'RESTORE' } })).status, 200);
    assert.equal((await rules(h, id)).rules[0].revision, 0); assert.ok((await rules(h, id)).rules[0].fields.methods.every((m) => m.mode === 'keep'));
  } finally { await h.close(); }
});
test('private schema-12 artifacts restore field choices; genuine schema-11 roots retain their original chain without rules', async () => {
  const h = await createCloudHarness(); try {
    const s = await setup(h, true), id = s.imported.contact_id;
    let capture = await h.beginCapture(); for (let i = 0; capture.state === 'capturing' && i < 100; i++) capture = await h.advanceCapture(capture.id);
    for (let i = 0; capture.state === 'awaiting_verification' && i < 100; i++) capture = await h.advanceCaptureVerification(capture.id);
    assert.equal(capture.state, 'manifest_ready');
    const prefix = 'test/recovery-jobs/' + capture.id, root = JSON.parse(await (await h.assets.get(prefix + '/manifest-' + capture.manifest_sha256 + '.json'))!.text()); assert.equal(root.snapshotSchemaVersion, 14);
    async function restore() {
      let job = await h.beginRestorePreparation(capture.id); for (let i = 0; job.state === 'preparing' && i < 100; i++) job = await h.advanceRestorePreparation(job.id);
      assert.equal(job.state, 'ready'); job = await h.beginRestoreApply(job.id);
      for (let i = 0; job.state === 'deleting' && i < 100; i++) job = await h.advanceRestoreDeletion(job.id);
      for (let i = 0; ['awaiting_write', 'writing'].includes(job.state) && i < 100; i++) job = await h.advanceRestoreWriting(job.id);
      for (let i = 0; job.state === 'repairing_dates' && i < 100; i++) job = await h.advanceRestoreDateRepair(job.id);
      for (let i = 0; job.state === 'verifying' && i < 100; i++) job = await h.advanceRestoreVerification(job.id); assert.equal(job.state, 'completed', JSON.stringify(job));
    }
    await restore(); assert.ok((await rules(h, id)).rules[0].fields.methods.every((m) => m.mode === 'follow'));
    // Build an old artifact with zero rule parts, as an actual v11 capture would contain.
    await h.db.prepare('DELETE FROM provider_field_rules').run();
    let oldCapture = await h.beginCapture();
    for (let i = 0; oldCapture.state === 'capturing' && i < 100; i++) oldCapture = await h.advanceCapture(oldCapture.id);
    for (let i = 0; oldCapture.state === 'awaiting_verification' && i < 100; i++) oldCapture = await h.advanceCaptureVerification(oldCapture.id);
    assert.equal(oldCapture.state, 'manifest_ready'); capture = oldCapture;
    const oldPrefix = 'test/recovery-jobs/' + capture.id, oldRoot = JSON.parse(await (await h.assets.get(oldPrefix + '/manifest-' + capture.manifest_sha256 + '.json'))!.text());
    oldRoot.snapshotSchemaVersion = 11; oldRoot.tableOrder = oldRoot.tableOrder.filter((table: string) => !['provider_field_rules', 'contact_device_links', 'calendar_events', 'calendar_event_people', 'calendar_event_plans'].includes(table)); delete oldRoot.rowCounts.provider_field_rules; delete oldRoot.rowCounts.contact_device_links; delete oldRoot.rowCounts.calendar_events; delete oldRoot.rowCounts.calendar_event_people; delete oldRoot.rowCounts.calendar_event_plans;
    const bytes = new TextEncoder().encode(JSON.stringify(oldRoot)), hash = createHash('sha256').update(bytes).digest('hex');
    await h.assets.put(oldPrefix + '/manifest-' + hash + '.json', bytes, { customMetadata: { workspaceId: 'test', jobId: capture.id, sha256: hash } });
    await h.db.prepare('UPDATE cloud_snapshot_capture_jobs SET manifest_sha256 = ?, manifest_bytes = ? WHERE id = ?').bind(hash, bytes.byteLength, capture.id).run();
    await restore(); assert.equal((await rules(h, id)).rules[0].revision, 0);
  } finally { await h.close(); }
});
test('disabling a schedule during provider fetch prevents publication, and unlinking during reconciliation never recreates a source', async () => {
  const h = await createCloudHarness(); try {
    const s = await setup(h, true), queue = { send: async () => {} }, review = await h.contactDownloads.reviewGoogleContacts(h.db, actor, s.connection.id);
    const body = { expected_epoch: s.epoch, expected_authorization_revision: s.connection.authorization_revision, expected_settings_revision: review.schedule.revision, enabled: true, interval: 86400 };
    await h.contactDownloads.changeGoogleContactsSchedule(h.db, actor, s.connection.id, body); await h.contactDownloads.startDueGoogleContactsDownloads(h.db, queue, environment);
    const active = await h.contactDownloads.reviewGoogleContacts(h.db, actor, s.connection.id), input = { kind: 'google-contacts' as const, version: 1 as const, workspaceId: 'test', connectionId: s.connection.id, runId: active.run!.id };
    // Delta copies first; no provider fetch or CRM write occurs during that phase.
    await h.contactDownloads.advanceGoogleContactsDownload(h.db, environment, input);
    const changed = googlePerson(); changed.emailAddresses[0].value = 'late@example.test';
    await h.contactDownloads.advanceGoogleContactsDownload(h.db, environment, input, async () => {
      await h.contactDownloads.changeGoogleContactsSchedule(h.db, actor, s.connection.id, { ...body, enabled: false, expected_settings_revision: active.schedule.revision });
      return Response.json({ connections: [changed], nextSyncToken: 'late-cursor' });
    });
    assert.equal((await h.contactDownloads.reviewGoogleContacts(h.db, actor, s.connection.id)).generation, review.generation); assert.equal((await currentPerson(h, s.imported.contact_id)).email, 'ana@example.test');
    const manual = await h.contactDownloads.startGoogleContactsDownload(h.db, actor, environment, s.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: s.epoch, expected_authorization_revision: s.connection.authorization_revision, full: true }); input.runId = manual.id;
    await h.contactDownloads.advanceGoogleContactsDownload(h.db, environment, input, async () => Response.json({ connections: [changed], nextSyncToken: 'manual-cursor' }));
    let injected = false; const db = { prepare: h.db.prepare.bind(h.db), batch: async (statements: Parameters<typeof h.db.batch>[0]) => {
      if (!injected && statements.length > 4) { injected = true; const saved = await rules(h, s.imported.contact_id); await h.contactImports.unlinkProviderSource(h.db, actor, s.imported.contact_id, saved.links[0].public_id, { expected_epoch: saved.epoch, expected_revision: saved.links[0].revision }); }
      return h.db.batch(statements);
    } } as typeof h.db;
    assert.equal((await h.contactDownloads.advanceGoogleContactsDownload(db, environment, input)).status, 'complete'); assert.equal((await rules(h, s.imported.contact_id)).links.length, 0); assert.equal((await currentPerson(h, s.imported.contact_id)).email, 'ana@example.test');
  } finally { await h.close(); }
});
test('oversized source growth preserves old observations and values while completing other source reconciliation', async () => {
  const h = await createCloudHarness(); try {
    const s = await setup(h, true), id = s.imported.contact_id, row = (await h.db.prepare('SELECT * FROM contact_provider_links').first())!;
    const columns = Object.keys(row).filter((key) => key !== 'id');
    for (let i = 0; i < 5; i++) {
      const facts = { ...s.preview.facts, sourceId: 'filler' + i, resourceName: 'people/filler' + i, emails: Array.from({ length: 45 }, (_, n) => ({ value: 'a'.repeat(180) + n + '@example.test', label: 'work', primary: false, canonical: null })) };
      const filler = { ...row, public_id: crypto.randomUUID(), account_key: 'different-account', external_id: facts.sourceId, resource_name: facts.resourceName, original_facts: JSON.stringify(facts), observed_facts: JSON.stringify(facts), applied_fields: JSON.stringify({ name: null, methods: [] }) };
      await h.db.prepare(`INSERT INTO contact_provider_links (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...columns.map((column) => filler[column as keyof typeof filler])).run();
    }
    const changed = googlePerson(); changed.emailAddresses = Array.from({ length: 90 }, (_, n) => ({ ...changed.emailAddresses[0], value: 'a'.repeat(180) + n + '@example.test' }));
    const { run } = await refresh(h, s, [changed]); const current = await h.db.prepare('SELECT reconcile_skipped, issue FROM provider_contact_runs WHERE id = ?').bind(run.id).first<{ reconcile_skipped: number; issue: string }>();
    assert.equal(current!.reconcile_skipped, 1); assert.equal(current!.issue, 'source_capacity'); assert.equal((await rules(h, id)).links[0].observed_facts, s.imported.source.observed_facts); assert.equal((await currentPerson(h, id)).email, 'ana@example.test');
  } finally { await h.close(); }
});
