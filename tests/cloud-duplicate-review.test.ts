import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { findDuplicateContactGroups } from '../lib/contact-merge.ts';
import { paginateDuplicateGroups, selectDuplicateBatch } from '../lib/duplicate-review.ts';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { TINY_PNG_DATA_URL } from './fixtures.ts';

test('cloud duplicate scan is bounded, tenant-scoped, and groups matches across pages', async () => {
  const h = await createCloudHarness();
  try {
    await h.db.prepare(`INSERT INTO contacts (workspace_id, name, email)
      SELECT 'test', 'Person ' || value, 'unique-' || value || '@example.test'
      FROM json_each(?)`).bind(JSON.stringify(Array.from({ length: 500 }, (_, index) => index))).run();
    const firstCreated = await h.call('contacts', { method: 'POST', body: {
      name: 'Ada', email: 'ada@example.test', phone: '+1 (415) 555-1234',
      notes: 'Do not put this in the directory', photo_url: TINY_PNG_DATA_URL,
      custom_fields: { private_story: 'Do not put this in the directory' },
    } });
    assert.equal(firstCreated.status, 201, JSON.stringify(firstCreated.body));
    const firstMatch = firstCreated.body.contact;
    const bridge = (await h.call('contacts', { method: 'POST', body: {
      name: 'Ada other', email: 'ada@example.test', phone: '+1 650 555 9988',
    } })).body.contact;
    const lastMatch = (await h.call('contacts', { method: 'POST', body: {
      name: 'Ada third', phone: '16505559988',
    } })).body.contact;
    await h.call('contacts', { workspace: 'other', method: 'POST', body: {
      name: 'Foreign Ada', email: 'ada@example.test',
    } });

    const first = await h.call('contacts/duplicates');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.contacts.length, 500);
    assert.equal(first.body.total, 503);
    assert.ok(first.body.nextCursor);
    const second = await h.call(`contacts/duplicates?after=${first.body.nextCursor}&revision=${first.body.revision}`);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.contacts.length, 3);
    assert.equal(second.body.nextCursor, null);
    const contacts = [...first.body.contacts, ...second.body.contacts];
    assert.equal(contacts.length, 503);
    const groups = findDuplicateContactGroups(contacts);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].contacts.map((contact) => contact.id), [firstMatch.id, bridge.id, lastMatch.id]);
    assert.deepEqual(selectDuplicateBatch(groups[0]), [firstMatch.id, bridge.id, lastMatch.id]);
    assert.equal(paginateDuplicateGroups(groups).contactCount, 3);
    const projected = contacts.find((contact) => contact.id === firstMatch.id)!;
    assert.equal('photo_url' in projected, false);
    assert.equal('notes' in projected, false);
    assert.equal('tags' in projected, false);
    assert.equal(typeof projected.quality_score, 'number');
    assert.ok(!JSON.stringify(projected).includes('Do not put this in the directory'));
    assert.ok(!JSON.stringify(contacts).includes('Foreign Ada'));
    const details = await h.call(`contacts/duplicates?ids=${firstMatch.id},${bridge.id},${lastMatch.id}&revision=${first.body.revision}`);
    assert.equal(details.status, 200, JSON.stringify(details.body));
    assert.equal(details.body.contacts.length, 3);
    assert.equal(details.body.contacts[0].photo_url, `/api/contacts/${firstMatch.id}/photo`);
    assert.equal(details.body.contacts[0].notes, null);
    assert.equal(details.body.contacts[0].interaction_count, 0);
    assert.equal((await h.call('contacts/duplicates', { workspace: 'other' })).body.total, 1);
    assert.equal((await h.call(`contacts/duplicates?ids=${firstMatch.id}&revision=${first.body.revision}`, { workspace: 'other' })).status, 409);
  } finally { await h.close(); }
});

test('cloud duplicate scan rejects stale or invalid cursors without returning a partial group', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact;
    const first = await h.call('contacts/duplicates');
    assert.equal((await h.call('contacts/duplicates?after=abc&revision=1')).status, 400);
    assert.equal((await h.call('contacts/duplicates?after=1')).status, 400);
    assert.equal((await h.call(`contacts/duplicates?ids=${contact.id}`)).status, 400);
    assert.equal((await h.call(`contacts/duplicates?ids=${contact.id},${contact.id}&revision=${first.body.revision}`)).status, 400);
    assert.equal((await h.call(`contacts/duplicates?ids=0&revision=${first.body.revision}`)).status, 400);
    assert.equal((await h.call(`contacts/duplicates?ids=${Array.from({ length: 211 }, (_, index) => index + 1).join(',')}&revision=${first.body.revision}`)).status, 400);
    await h.db.prepare(`UPDATE contacts SET notes = 'Fresh edit' WHERE id = ?`).bind(contact.id).run();
    const stale = await h.call(`contacts/duplicates?after=${contact.id}&revision=${first.body.revision}`);
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /changed during the scan/);
    assert.equal((await h.call(`contacts/duplicates?ids=${contact.id}&revision=${first.body.revision}`)).status, 409);
    assert.equal(stale.headers.get('Cache-Control'), 'private, no-store');
  } finally { await h.close(); }
});

test('cloud duplicate review can finish a transitive group in two safe batches', async () => {
  const h = await createCloudHarness();
  try {
    const people = Array.from({ length: 25 }, (_, offset) => {
      const index = offset + 1;
      return { name: `Chain ${index}`, email: `chain-${index}@example.test`,
        custom_fields: index < 25 ? JSON.stringify({
          vcard: { additional_emails: [`chain-${index + 1}@example.test`] },
        }) : null };
    });
    await h.db.prepare(`INSERT INTO contacts (workspace_id, name, email, custom_fields)
      SELECT 'test', json_extract(value, '$.name'), json_extract(value, '$.email'),
        json_extract(value, '$.custom_fields') FROM json_each(?)`).bind(JSON.stringify(people)).run();
    const primary = await h.db.prepare(`SELECT id FROM contacts WHERE workspace_id = 'test' ORDER BY id DESC LIMIT 1`)
      .first<{ id: number }>();
    await h.db.prepare(`INSERT INTO interactions (workspace_id, contact_id, date, type)
      VALUES ('test', ?, '2026-09-01', 'message')`).bind(primary!.id).run();
    for (const expectedSize of [25, 5]) {
      const review = await h.call('contacts/duplicates');
      assert.equal(review.status, 200, JSON.stringify(review.body));
      const groups = findDuplicateContactGroups(review.body.contacts);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].contacts.length, expectedSize);
      const batch = selectDuplicateBatch(groups[0]);
      assert.equal(batch.length, Math.min(21, expectedSize));
      assert(batch.includes(primary!.id));
      const merged = await h.call('contacts/duplicates', { method: 'POST', body: {
        primaryId: primary!.id, duplicateIds: batch.filter((id) => id !== primary!.id),
        expectedRevision: review.body.revision,
      } });
      assert.equal(merged.status, 200, JSON.stringify(merged.body));
    }
    const finalReview = await h.call('contacts/duplicates');
    assert.equal(finalReview.body.total, 1);
    assert.deepEqual(findDuplicateContactGroups(finalReview.body.contacts), []);
    assert.equal((await h.db.prepare(`SELECT contact_id FROM interactions WHERE workspace_id = 'test'`)
      .first<{ contact_id: number }>())?.contact_id, primary!.id);
  } finally { await h.close(); }
});

test('cloud duplicate scan reaches a match beyond ten thousand contacts', {
  skip: process.env.CLOUD_TEST_RUNTIME === 'workerd' && 'Large-count boundary runs in the fast SQLite harness.',
}, async () => {
  const h = await createCloudHarness();
  try {
    await h.db.prepare(`INSERT INTO contacts (workspace_id, name, email)
      SELECT 'test', 'Person ' || value, 'unique-' || value || '@example.test'
      FROM json_each(?)`).bind(JSON.stringify(Array.from({ length: 10000 }, (_, index) => index))).run();
    await h.db.prepare(`INSERT INTO contacts (workspace_id, name, email)
      VALUES ('test', 'Last Ada', 'last@example.test'), ('test', 'Last Ada again', 'last@example.test')`).run();
    const contacts = [];
    let cursor: number | null = null;
    let revision: number | null = null;
    let requests = 0;
    do {
      const query = cursor === null ? '' : `?after=${cursor}&revision=${revision}`;
      const response = await h.call(`contacts/duplicates${query}`);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      contacts.push(...response.body.contacts);
      cursor = response.body.nextCursor;
      revision = response.body.revision;
      requests += 1;
    } while (cursor !== null);
    assert.equal(contacts.length, 10002);
    assert.equal(requests, 21);
    const groups = findDuplicateContactGroups(contacts);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].contacts.map((contact) => contact.name), ['Last Ada', 'Last Ada again']);
  } finally { await h.close(); }
});

test('authenticated cloud dispatch reaches duplicate review and merge before the generic contact handler', () => {
  const source = readFileSync('app/api/cloud/[...path]/route.ts', 'utf8');
  const duplicate = source.indexOf("path.join('/') === 'contacts/duplicates'");
  const generic = source.indexOf("path[0] === 'contacts'");
  assert.ok(duplicate >= 0 && generic > duplicate);
  assert.match(source, /handleCloudDuplicateReview\(request, workspaceId\)/);
  assert.match(source, /handleCloudDuplicateMerge\(request, workspaceId\)/);
});
