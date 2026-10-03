import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

test('cloud tag groups count tenant members and page both membership views', async () => {
  const h = await createCloudHarness();
  try {
    const ada = (await h.call('contacts', { method: 'POST', body: {
      name: 'Ada', tags: ['Friends', 'Work'],
    } })).body.contact;
    const bob = (await h.call('contacts', { method: 'POST', body: {
      name: 'Bob', tags: ['friends'],
    } })).body.contact;
    const charlie = (await h.call('contacts', { method: 'POST', body: {
      name: 'Charlie',
    } })).body.contact;
    await h.db.prepare('UPDATE contacts SET tags = ? WHERE id = ?').bind('not-json', charlie.id).run();
    await h.call('contacts', { workspace: 'other', method: 'POST', body: {
      name: 'Foreign', tags: ['Friends'],
    } });

    const summary = await h.call('groups/tags');
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body.tags, [
      { tag: 'Friends', contactCount: 2 }, { tag: 'Work', contactCount: 1 },
    ]);
    assert.deepEqual((await h.call('contacts?view=tags')).body.tags, summary.body.tags);
    const first = await h.call('groups/tags/contacts?tag=friends&membership=members&pageSize=1');
    assert.equal(first.body.pagination.total, 2);
    assert.deepEqual(first.body.contacts.map((contact: { id: number }) => contact.id), [ada.id]);
    const second = await h.call('groups/tags/contacts?tag=friends&membership=members&pageSize=1&page=2');
    assert.deepEqual(second.body.contacts.map((contact: { id: number }) => contact.id), [bob.id]);
    const available = await h.call('groups/tags/contacts?tag=friends&membership=available&search=Charlie');
    assert.deepEqual(available.body.contacts.map((contact: { id: number }) => contact.id), [charlie.id]);
  } finally { await h.close(); }
});

test('cloud tag groups include contacts beyond the old 10000-person cap', {
  skip: process.env.CLOUD_TEST_RUNTIME === 'workerd' && 'Large-count boundary runs in the fast SQLite harness.',
}, async () => {
  const h = await createCloudHarness();
  try {
    await h.db.prepare(`INSERT INTO contacts (workspace_id, name, tags)
      SELECT 'test', 'Person ' || printf('%05d', value), '["common"]' FROM json_each(?)`)
      .bind(JSON.stringify(Array.from({ length: 10_000 }, (_, index) => index))).run();
    const late = (await h.call('contacts', { method: 'POST', body: {
      name: 'ZZZ Late', tags: ['late'],
    } })).body.contact;
    const summary = await h.call('groups/tags');
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body.tags, [
      { tag: 'common', contactCount: 10_000 }, { tag: 'late', contactCount: 1 },
    ]);
    const members = await h.call('groups/tags/contacts?tag=late&membership=members');
    assert.equal(members.body.pagination.total, 1);
    assert.equal(members.body.contacts[0].id, late.id);
    const available = await h.call('groups/tags/contacts?tag=late&membership=available&pageSize=100&page=100');
    assert.equal(available.body.pagination.total, 10_000);
    assert.equal(available.body.contacts.length, 100);
  } finally { await h.close(); }
});
