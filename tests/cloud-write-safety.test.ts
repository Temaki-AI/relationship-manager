import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

test('cloud creates atomically replay across all contact-scoped resource types', async () => {
  const h = await createCloudHarness();
  try {
    const first = await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const second = await h.call('contacts', { method: 'POST', body: { name: 'Grace' } });
    const id = first.body.contact.id;
    const cases = [
      ['contacts', 'contact', { name: 'Alan' }],
      ['reminders', 'reminder', { contact_id: id, title: 'Ask about the trip', remind_at: '2026-09-10T10:00:00Z' }],
      ['interactions', 'interaction', { contact_id: id, type: 'call', date: '2026-09-04', summary: 'A good conversation' }],
      ['plans', 'plan', { contact_id: id, type: 'call', planned_date: '2026-09-12' }],
      [`contacts/${id}/children`, 'child', { name: 'Alex', birthday: '2020-03-04' }],
      [`contacts/${id}/relationships`, 'relationship', { related_contact_id: second.body.contact.id, relationship_label: 'Partner', reciprocal_label: 'Partner' }],
    ] as const;
    for (const [endpoint, field, body] of cases) {
      const key = crypto.randomUUID();
      const responses = await Promise.all(Array.from({ length: 3 }, () => h.call(endpoint, { method: 'POST', body, key })));
      assert.deepEqual(responses.map((r) => r.status), [201, 201, 201], endpoint);
      assert.equal(new Set(responses.map((r) => r.body[field].id)).size, 1, endpoint);
      assert.equal(responses.filter((r) => r.headers.get('Idempotency-Replayed') === 'false').length, 1, endpoint);
      const replay = await h.call(endpoint, { method: 'POST', body, key });
      assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    }
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM interactions').first()).count, 1);
  } finally { await h.close(); }
});

test('cloud retry keys reject changed payloads, missing keys, and resurrection after deletion', async () => {
  const h = await createCloudHarness();
  try {
    assert.equal((await h.call('contacts', { method: 'POST', body: { name: 'Ada' }, key: null })).status, 400);
    assert.equal((await h.call('contacts', { method: 'POST', body: { name: 'Ada' }, key: 'bad' })).status, 400);
    const key = crypto.randomUUID();
    const created = await h.call('contacts', { method: 'POST', body: { name: 'Ada' }, key });
    assert.equal((await h.call('contacts', { method: 'POST', body: { name: 'Grace' }, key })).status, 409);
    const other = await h.call('contacts', { method: 'POST', body: { name: 'Other Ada' }, key, workspace: 'other' });
    assert.equal(other.status, 201);
    assert.notEqual(other.body.contact.id, created.body.contact.id);
    await h.call(`contacts/${created.body.contact.id}`, { method: 'DELETE' });
    assert.equal((await h.call('contacts', { method: 'POST', body: { name: 'Ada' }, key })).status, 409);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = 'test'").first()).count, 0);
  } finally { await h.close(); }
});

test('cloud concurrent contact edits reject the loser and preserve its draft', async () => {
  const h = await createCloudHarness();
  try {
    const create = await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const endpoint = `contacts/${create.body.contact.id}`;
    const detail = await h.call(endpoint);
    const expected_edit_revision = detail.body.contact.edit_revision;
    const edits = await Promise.all(['Phone edit', 'Laptop edit'].map((notes) => h.call(endpoint, { method: 'PATCH', body: { notes, expected_edit_revision } })));
    assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409]);
    const winner = edits.find((r) => r.status === 200)!;
    assert.equal((await h.call(endpoint)).body.contact.notes, winner.body.contact.notes);
    const foreign = await h.call(endpoint, { method: 'PATCH', body: { notes: 'Intrusion', expected_edit_revision }, workspace: 'other' });
    assert.equal(foreign.status, 404);
  } finally { await h.close(); }
});

test('cloud interactions maintain history dates through edits, deletes, and stale drafts', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact;
    const create = (date: string) => h.call('interactions', { method: 'POST', body: { contact_id: contact.id, type: 'call', date } });
    const older = (await create('2026-08-01')).body.interaction;
    const newer = (await create('2026-09-04')).body.interaction;
    const endpoint = `interactions/${newer.id}`;
    const payload = { date: '2026-07-01', type: 'call', summary: null, notes: null, expected_edit_revision: newer.edit_revision };
    const edits = await Promise.all([h.call(endpoint, { method: 'PATCH', body: payload }), h.call(endpoint, { method: 'PATCH', body: { ...payload, date: '2026-07-02' } })]);
    assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409]);
    const current = () => h.call(`contacts/${contact.id}`);
    assert.equal((await current()).body.contact.last_contacted, '2026-08-01');
    assert.ok((await current()).body.interactions.every((entry: { edit_revision: string }) => /^[a-f0-9]{64}$/.test(entry.edit_revision)));
    await h.call(`interactions/${older.id}`, { method: 'DELETE' });
    await h.call(endpoint, { method: 'DELETE' });
    assert.equal((await current()).body.contact.last_contacted, null);
  } finally { await h.close(); }
});

test('cloud completion is exactly once and completed reminders stay out of the queue', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact;
    const plan = (await h.call('plans', { method: 'POST', body: { contact_id: contact.id, type: 'call', planned_date: '2026-09-04' } })).body.plan;
    const completions = await Promise.all(Array.from({ length: 3 }, () => h.call(`plans/${plan.id}`, { method: 'PATCH', body: { completed: true } })));
    assert.equal(completions.filter((r) => r.body.interactionCreated).length, 1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM interactions').first()).count, 1);
    const reminder = (await h.call('reminders', { method: 'POST', body: { contact_id: contact.id, title: 'Check in', remind_at: '2026-09-05T10:00:00Z' } })).body.reminder;
    const done = await Promise.all(Array.from({ length: 3 }, () => h.call(`reminders/${reminder.id}`, { method: 'PATCH', body: { completed: true } })));
    assert.equal(done.filter((r) => r.body.completionChanged).length, 1);
    assert.equal((await h.call('reminders')).body.reminders.length, 0);
    assert.equal((await h.call('reminders?status=completed')).body.reminders.length, 1);
    assert.equal((await h.call('reminders?status=all')).body.reminders.length, 1);
    assert.equal((await h.call('reminders?status=typo')).status, 400);
  } finally { await h.close(); }
});

test('cloud reverse relationship creates cannot duplicate a pair and failures roll back receipts', async () => {
  const h = await createCloudHarness();
  try {
    const a = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact.id;
    const b = (await h.call('contacts', { method: 'POST', body: { name: 'Grace' } })).body.contact.id;
    const results = await Promise.all([[a, b], [b, a]].map(([from, to]) => h.call(`contacts/${from}/relationships`, { method: 'POST', body: { related_contact_id: to, relationship_label: 'Friend', reciprocal_label: 'Friend' } })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE scope = 'contact_relationships'").first()).count, 1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM contact_relationships').first()).count, 1);
  } finally { await h.close(); }
});

test('cloud handlers enforce streaming request size limits and return validation errors', async () => {
  const h = await createCloudHarness();
  try {
    assert.equal((await h.call('contacts', { method: 'POST', body: { name: 'Ada', notes: 'a'.repeat(300_000) } })).status, 413);
    assert.equal((await h.call('reminders', { method: 'POST', body: { notes: 'a'.repeat(300_000) } })).status, 413);
    assert.equal((await h.call('contacts', { method: 'POST', body: { name: '' } })).status, 400);
    assert.equal((await h.call('contacts', { method: 'POST', body: null })).status, 400);
  } finally { await h.close(); }
});
