import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

type Row = Record<string, unknown>;

async function createPair(h: Awaited<ReturnType<typeof createCloudHarness>>) {
  const primary = (await h.call('contacts', { method: 'POST', body: {
    name: 'Ada', email: 'ada@example.test', notes: 'Primary note', birthday: '1990-03-04',
  } })).body.contact;
  const duplicate = (await h.call('contacts', { method: 'POST', body: {
    name: 'Ada Duplicate', email: 'ada@example.test', notes: 'Other note',
  } })).body.contact;
  return { primary, duplicate };
}

async function mergeRequest(h: Awaited<ReturnType<typeof createCloudHarness>>,
  primaryId: number, duplicateIds: number[], workspace = 'test') {
  const review = await h.call('contacts/duplicates', { workspace });
  assert.equal(review.status, 200);
  return h.call('contacts/duplicates', { workspace, method: 'POST', body: {
    primaryId, duplicateIds, expectedRevision: review.body.revision,
  } });
}

test('cloud merge preserves dependent records and a verified recovery point', async () => {
  const h = await createCloudHarness();
  try {
    const { primary, duplicate } = await createPair(h);
    const relative = (await h.call('contacts', { method: 'POST', body: { name: 'Relative' } })).body.contact;
    const foreign = (await h.call('contacts', { workspace: 'other', method: 'POST', body: {
      name: 'Foreign', email: 'ada@example.test',
    } })).body.contact;
    await h.db.prepare(`INSERT INTO contact_relationships
      (workspace_id, contact_id, related_contact_id, relationship_label, reciprocal_label)
      VALUES ('test', ?, ?, 'friend', 'friend'), ('test', ?, ?, 'friend', 'friend')`)
      .bind(primary.id, relative.id, duplicate.id, relative.id).run();
    await h.db.prepare(`INSERT INTO contact_children (workspace_id, contact_id, name, linked_contact_id)
      VALUES ('test', ?, 'Ada', ?), ('test', ?, 'Ada duplicate', ?)`)
      .bind(relative.id, primary.id, relative.id, duplicate.id).run();
    await h.db.prepare(`INSERT INTO contact_groups (workspace_id, name) VALUES ('test', 'Family')`).run();
    const group = await h.db.prepare(`SELECT id FROM contact_groups WHERE workspace_id = 'test'`).first<{ id: number }>();
    await h.db.prepare(`INSERT INTO contact_group_members (workspace_id, contact_id, group_id)
      VALUES ('test', ?, ?)`).bind(duplicate.id, group!.id).run();
    await h.db.prepare(`INSERT INTO interactions (workspace_id, contact_id, date, type)
      VALUES ('test', ?, '2026-09-01', 'call')`).bind(duplicate.id).run();
    await h.db.prepare(`INSERT INTO reminders (workspace_id, contact_id, title, remind_at)
      VALUES ('test', ?, 'Call Ada', '2026-10-01T10:00:00Z')`).bind(duplicate.id).run();
    const reminder = await h.db.prepare(`SELECT id FROM reminders WHERE contact_id = ?`).bind(duplicate.id).first<{ id: number }>();
    await h.db.prepare(`INSERT INTO relationship_facts (workspace_id, contact_id, category, label)
      VALUES ('test', ?, 'personal', 'Likes tea')`).bind(duplicate.id).run();
    await h.db.prepare(`INSERT INTO plans (workspace_id, contact_id, type, planned_date)
      VALUES ('test', ?, 'coffee', '2026-10-02')`).bind(duplicate.id).run();
    await h.db.prepare(`INSERT INTO daily_snoozes (id, workspace_id, contact_id, reminder_id, until_date)
      VALUES (?, 'test', ?, NULL, '2026-10-12'), (?, 'test', ?, NULL, '2026-10-13'),
        (?, 'test', ?, NULL, '2026-10-11'), (?, 'test', ?, ?, '2026-10-11')`)
      .bind(`birthday-${primary.id}`, primary.id, `birthday-${duplicate.id}`, duplicate.id,
        `overdue-${duplicate.id}`, duplicate.id, `reminder-${reminder!.id}`, duplicate.id, reminder!.id).run();
    await h.db.prepare(`INSERT INTO contact_import_jobs
      (id, workspace_id, request_key, fingerprint, filename, format, total, source_bytes, created_at, updated_at)
      VALUES ('job-1', 'test', 'request-1', 'fingerprint', 'contacts.vcf', 'vcard', 1, 1, 'now', 'now')`).run();
    await h.db.prepare(`INSERT INTO contact_import_rows (workspace_id, job_id, row_number, name, state, contact_id)
      VALUES ('test', 'job-1', 1, 'Ada Duplicate', 'created', ?)`).bind(duplicate.id).run();

    const result = await mergeRequest(h, primary.id, [duplicate.id]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.mergedContactIds, [duplicate.id]);
    assert.deepEqual(result.body.moved, {
      interactions: 1, reminders: 1, facts: 1, plans: 1, groups: 1, relationships: 1, children: 1,
    });
    assert.match(result.body.contact.notes, /Primary note[\s\S]*Other note/);
    assert.equal((await h.call(`contacts/${duplicate.id}`)).status, 404);
    for (const table of ['interactions', 'reminders', 'relationship_facts', 'plans', 'contact_group_members', 'contact_import_rows']) {
      const row = await h.db.prepare(`SELECT contact_id FROM ${table} WHERE workspace_id = 'test' LIMIT 1`).first<Row>();
      assert.equal(row?.contact_id, primary.id, table);
    }
    const relations = await h.db.prepare(`SELECT contact_id, related_contact_id FROM contact_relationships
      WHERE workspace_id = 'test'`).all<Row>();
    assert.equal(relations.results.length, 1);
    assert.deepEqual([relations.results[0].contact_id, relations.results[0].related_contact_id], [primary.id, relative.id]);
    const children = await h.db.prepare(`SELECT linked_contact_id FROM contact_children
      WHERE workspace_id = 'test'`).all<Row>();
    assert.deepEqual(children.results, [{ linked_contact_id: primary.id }]);
    const snoozes = await h.db.prepare(`SELECT id, contact_id, until_date FROM daily_snoozes
      WHERE workspace_id = 'test' ORDER BY id`).all<Row>();
    assert.deepEqual(snoozes.results, [
      { id: `birthday-${primary.id}`, contact_id: primary.id, until_date: '2026-10-13' },
      { id: `overdue-${primary.id}`, contact_id: primary.id, until_date: '2026-10-11' },
      { id: `reminder-${reminder!.id}`, contact_id: primary.id, until_date: '2026-10-11' },
    ]);
    assert.equal((await h.db.prepare(`SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'other' AND id = ?`)
      .bind(foreign.id).first<{ count: number }>())?.count, 1);
    const backups = (await h.call('settings/backups')).body.backups;
    assert.equal(backups[0].filename, result.body.recoveryPoint.filename);
    assert.equal(backups[0].reason, 'pre-merge');
    assert.equal(backups[0].protected, false);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_maintenance_guards').first<{ count: number }>())?.count, 0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_backup_pins').first<{ count: number }>())?.count, 0);
  } finally { await h.close(); }
});

test('cloud merge refuses tenant crossing, unverified pairs, storage failure and self-child links', async () => {
  const h = await createCloudHarness();
  try {
    const { primary, duplicate } = await createPair(h);
    const foreign = (await h.call('contacts', { workspace: 'other', method: 'POST', body: {
      name: 'Foreign', email: 'ada@example.test',
    } })).body.contact;
    assert.equal((await mergeRequest(h, primary.id, [foreign.id])).status, 404);
    assert.equal((await mergeRequest(h, primary.id, [duplicate.id], 'other')).status, 404);
    h.faults.failPut = true;
    assert.equal((await mergeRequest(h, primary.id, [duplicate.id])).status, 503);
    h.faults.failPut = false;
    await h.db.prepare(`INSERT INTO contact_children (workspace_id, contact_id, name, linked_contact_id)
      VALUES ('test', ?, 'Ada', ?)`).bind(primary.id, duplicate.id).run();
    assert.equal((await mergeRequest(h, primary.id, [duplicate.id])).status, 400);
    assert.equal((await h.db.prepare(`SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'test'`)
      .first<{ count: number }>())?.count, 2);
    assert.equal((await h.db.prepare(`SELECT linked_contact_id FROM contact_children WHERE workspace_id = 'test'`)
      .first<{ linked_contact_id: number }>())?.linked_contact_id, duplicate.id);
  } finally { await h.close(); }
});

test('cloud merge aborts when contacts change during backup creation', async () => {
  const h = await createCloudHarness();
  try {
    const { primary, duplicate } = await createPair(h);
    h.faults.afterPut = async () => {
      await h.db.prepare(`UPDATE contacts SET notes = 'Concurrent edit' WHERE workspace_id = 'test' AND id = ?`)
        .bind(duplicate.id).run();
    };
    const result = await mergeRequest(h, primary.id, [duplicate.id]);
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal((await h.db.prepare(`SELECT notes FROM contacts WHERE id = ?`).bind(duplicate.id)
      .first<{ notes: string }>())?.notes, 'Concurrent edit');
    assert.equal((await h.db.prepare(`SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'test'`)
      .first<{ count: number }>())?.count, 2);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_backup_pins').first<{ count: number }>())?.count, 0);
  } finally { await h.close(); }
});

test('cloud merge rejects a stale or missing review revision before writing a backup', async () => {
  const h = await createCloudHarness();
  try {
    const { primary, duplicate } = await createPair(h);
    const review = await h.call('contacts/duplicates');
    await h.db.prepare(`UPDATE contacts SET notes = 'New information' WHERE id = ?`).bind(duplicate.id).run();
    const stale = await h.call('contacts/duplicates', { method: 'POST', body: {
      primaryId: primary.id, duplicateIds: [duplicate.id], expectedRevision: review.body.revision,
    } });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /changed since this review/);
    assert.equal((await h.call('contacts/duplicates', { method: 'POST', body: {
      primaryId: primary.id, duplicateIds: [duplicate.id],
    } })).status, 400);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM cloud_backup_files')
      .first<{ count: number }>())?.count, 0);
    assert.equal((await h.db.prepare(`SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'test'`)
      .first<{ count: number }>())?.count, 2);
  } finally { await h.close(); }
});

test('cloud merge retry confirms a committed merge without creating another recovery point', async () => {
  const h = await createCloudHarness();
  try {
    const { primary, duplicate } = await createPair(h);
    const revision = (await h.call('contacts/duplicates')).body.revision;
    const key = crypto.randomUUID();
    const body = { primaryId: primary.id, duplicateIds: [duplicate.id], expectedRevision: revision };
    assert.equal((await h.call('contacts/duplicates', { method: 'POST', key: null, body })).status, 400);
    const first = await h.call('contacts/duplicates', { method: 'POST', key, body });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.replayed, false);
    const afterFirst = await h.db.prepare('SELECT recovery_revision FROM workspaces WHERE id = ?')
      .bind('test').first<{ recovery_revision: number }>();
    const retry = await h.call('contacts/duplicates', { method: 'POST', key, body });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.replayed, true);
    assert.equal(retry.body.contact.id, primary.id);
    assert.equal(retry.body.recoveryPoint.filename, first.body.recoveryPoint.filename);
    assert.equal((await h.db.prepare('SELECT recovery_revision FROM workspaces WHERE id = ?')
      .bind('test').first<{ recovery_revision: number }>())?.recovery_revision, afterFirst?.recovery_revision);
    assert.equal((await h.call('settings/backups')).body.backups.length, 1);
    assert.equal((await h.call('contacts/duplicates', { method: 'POST', key, body: {
      ...body, expectedRevision: revision + 1,
    } })).status, 409);
    assert.equal((await h.db.prepare(`SELECT COUNT(*) AS count FROM mutation_receipts
      WHERE workspace_id = 'test' AND scope = 'contact_merge'`).first<{ count: number }>())?.count, 1);
  } finally { await h.close(); }
});

test('restoring the pre-merge snapshot invalidates the old merge receipt', async () => {
  const h = await createCloudHarness();
  try {
    const { primary, duplicate } = await createPair(h);
    const revision = (await h.call('contacts/duplicates')).body.revision;
    const key = crypto.randomUUID();
    const body = { primaryId: primary.id, duplicateIds: [duplicate.id], expectedRevision: revision };
    const merged = await h.call('contacts/duplicates', { method: 'POST', key, body });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    const restored = await h.call('settings/restore', { method: 'POST', body: {
      filename: merged.body.recoveryPoint.filename, confirmation: 'RESTORE',
    } });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal((await h.call(`contacts/${duplicate.id}`)).status, 200);
    const retry = await h.call('contacts/duplicates', { method: 'POST', key, body });
    assert.equal(retry.status, 409);
    assert.match(retry.body.error, /no longer available/);
  } finally { await h.close(); }
});

test('cloud merge does not cascade-delete birthday email history', async () => {
  const h = await createCloudHarness();
  try {
    const { primary, duplicate } = await createPair(h);
    await h.db.prepare(`INSERT INTO user (id, name, email, created_at, updated_at)
      VALUES ('user-1', 'Owner', 'owner@example.test', 1, 1)`).run();
    await h.db.prepare(`INSERT INTO workspace_members (workspace_id, user_id)
      VALUES ('test', 'user-1')`).run();
    await h.db.prepare(`INSERT INTO reminder_email_preferences (workspace_id, user_id, enabled)
      VALUES ('test', 'user-1', 1)`).run();
    await h.db.prepare(`UPDATE contacts SET birthday = '1990-03-04' WHERE id = ?`).bind(duplicate.id).run();
    await h.db.prepare(`INSERT INTO birthday_email_deliveries
      (workspace_id, user_id, contact_id, occurrence, status, next_attempt_at)
      VALUES ('test', 'user-1', ?, '2026-03-04', 'sent', '2026-03-01')`).bind(duplicate.id).run();
    const result = await mergeRequest(h, primary.id, [duplicate.id]);
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.match(result.body.error, /delivery history/);
    assert.equal((await h.db.prepare(`SELECT contact_id FROM birthday_email_deliveries WHERE workspace_id = 'test'`)
      .first<{ contact_id: number }>())?.contact_id, duplicate.id);
    assert.equal((await h.db.prepare(`SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'test'`)
      .first<{ count: number }>())?.count, 2);
  } finally { await h.close(); }
});
