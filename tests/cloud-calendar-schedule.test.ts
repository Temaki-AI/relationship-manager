import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

async function fixture() {
  const h = await createCloudHarness();
  const person = (await h.call('contacts', { method: 'POST', body: { name: 'Calendar Schedule QA', notes: 'Private relationship note' } })).body.contact;
  const reminder = (await h.call('reminders', { method: 'POST', body: { contact_id: person.id, title: 'Check in', notes: 'Private reminder note', remind_at: '2026-10-08T09:00:00.000Z' } })).body.reminder;
  const plan = (await h.call('plans', { method: 'POST', body: { contact_id: person.id, type: 'call', summary: 'Catch up', notes: 'Private plan note', planned_date: '2026-10-08' } })).body.plan;
  async function review(kind: 'plan' | 'reminder') {
    const endpoint = `${kind === 'plan' ? 'plans' : 'reminders'}/${kind === 'plan' ? plan.id : reminder.id}`;
    const result = await h.call(endpoint);
    assert.equal(result.status, 200);
    const row = result.body[kind];
    const body = { calendar_schedule: { expected_revision: row.schedule_revision, original_at: row[kind === 'plan' ? 'planned_date' : 'remind_at'], at: kind === 'plan' ? '2026-11-02' : '2026-11-02T16:30:00.000Z' } };
    return { endpoint, body, row };
  }
  return { h, person, reminder, plan, review };
}

test('date-only Calendar updates preserve both records and confirm a lost reply without another write', async () => {
  const f = await fixture();
  try {
    for (const kind of ['plan', 'reminder'] as const) {
      const r = await f.review(kind), field = kind === 'plan' ? 'planned_date' : 'remind_at';
      const saved = await f.h.call(r.endpoint, { method: 'PATCH', body: r.body });
      assert.equal(saved.status, 200); assert.equal(saved.body.dateChanged, true);
      assert.equal(saved.body[kind][field], r.body.calendar_schedule.at);
      for (const key of ['contact_id', 'title', 'type', 'summary', 'notes', 'completed_at', 'created_at', 'public_id']) assert.equal(saved.body[kind][key], r.row[key], key);
      const before = await f.h.db.prepare("SELECT revision FROM sync_entity_records WHERE workspace_id = 'test' AND entity_type = ? AND public_id = ?").bind(kind, r.row.public_id).first<{ revision: number }>();
      const retry = await f.h.call(r.endpoint, { method: 'PATCH', body: r.body });
      assert.equal(retry.status, 200); assert.equal(retry.body.dateChanged, false);
      const after = await f.h.db.prepare("SELECT revision FROM sync_entity_records WHERE workspace_id = 'test' AND entity_type = ? AND public_id = ?").bind(kind, r.row.public_id).first<{ revision: number }>();
      assert.deepEqual(after, before, 'unchanged retry does not advance the journal');
    }
    assert.equal((await f.h.db.prepare("SELECT COUNT(*) count FROM interactions WHERE workspace_id = 'test'").first<{ count: number }>())?.count, 0);
  } finally { await f.h.close(); }
});

test('concurrent notes, dates, completion and removal hold Calendar edits without overwriting records', async () => {
  const f = await fixture();
  try {
    const plan = await f.review('plan');
    await f.h.db.prepare("UPDATE plans SET notes = 'New private note' WHERE id = ?").bind(f.plan.id).run();
    assert.equal((await f.h.call(plan.endpoint, { method: 'PATCH', body: plan.body })).status, 409);
    assert.equal((await f.h.db.prepare('SELECT planned_date FROM plans WHERE id = ?').bind(f.plan.id).first<{ planned_date: string }>())?.planned_date, '2026-10-08');
    const reminder = await f.review('reminder');
    await f.h.db.prepare("UPDATE reminders SET remind_at = '2026-10-09T09:00:00.000Z' WHERE id = ?").bind(f.reminder.id).run();
    assert.equal((await f.h.call(reminder.endpoint, { method: 'PATCH', body: reminder.body })).status, 409);
    const completed = await f.review('plan');
    await f.h.call(completed.endpoint, { method: 'PATCH', body: { completed: true } });
    assert.equal((await f.h.call(completed.endpoint, { method: 'PATCH', body: completed.body })).status, 409);
    const removed = await f.review('reminder');
    await f.h.call(removed.endpoint, { method: 'DELETE' });
    assert.equal((await f.h.call(removed.endpoint, { method: 'PATCH', body: removed.body })).status, 404);
  } finally { await f.h.close(); }
});

test('restore epochs and workspace boundaries invalidate an otherwise identical date review', async () => {
  const f = await fixture();
  try {
    const r = await f.review('plan');
    assert.equal((await f.h.call(r.endpoint, { workspace: 'other', method: 'GET' })).status, 404);
    assert.equal((await f.h.call(r.endpoint, { workspace: 'other', method: 'PATCH', body: r.body })).status, 404);
    await f.h.db.prepare("UPDATE workspace_sync_state SET epoch = ? WHERE workspace_id = 'test'").bind(crypto.randomUUID()).run();
    assert.equal((await f.h.call(r.endpoint, { method: 'PATCH', body: r.body })).status, 409);
    const paused = await f.review('plan');
    await f.h.db.prepare("UPDATE workspace_sync_state SET paused = 1 WHERE workspace_id = 'test'").run();
    assert.equal((await f.h.call(paused.endpoint, { method: 'PATCH', body: paused.body })).status, 404);
    assert.equal((await f.h.db.prepare('SELECT planned_date FROM plans WHERE id = ?').bind(f.plan.id).first<{ planned_date: string }>())?.planned_date, '2026-10-08');
  } finally { await f.h.close(); }
});

test('Calendar date requests reject mixed edits and impossible civil dates', async () => {
  const f = await fixture();
  try {
    const r = await f.review('plan');
    for (const body of [{ ...r.body, completed: true }, { ...r.body, notes: 'Do not copy me' }, { calendar_schedule: { ...r.body.calendar_schedule, at: '2026-02-30' } }, { calendar_schedule: { ...r.body.calendar_schedule, notes: 'extra' } }]) {
      assert.equal((await f.h.call(r.endpoint, { method: 'PATCH', body })).status, 400);
    }
    assert.equal((await f.h.db.prepare("SELECT COUNT(*) count FROM interactions WHERE workspace_id = 'test'").first<{ count: number }>())?.count, 0);
  } finally { await f.h.close(); }
});

test('a writer between Calendar review validation and commit cannot be overwritten', async () => {
  const f = await fixture();
  try {
    const r = await f.review('plan'), prepare = f.h.db.prepare.bind(f.h.db);
    let injected = false;
    // D1 statement bindings are remote proxies. Wrap them rather than assigning
    // methods on a proxy, which does not intercept the underlying remote call.
    f.h.emailEnv.DB = { batch: f.h.db.batch.bind(f.h.db), prepare(sql: string) {
      const wrap = (statement: ReturnType<typeof prepare>) => ({
        bind: (...values: unknown[]) => wrap(statement.bind(...values)),
        async first(...args: unknown[]) {
          if (sql.startsWith('UPDATE plans SET planned_date = ?') && !injected) {
            injected = true; await prepare("UPDATE plans SET notes = 'Note saved by another writer' WHERE id = ?").bind(f.plan.id).run();
          }
          return statement.first(...args);
        },
        all: () => statement.all(), run: () => statement.run(),
      });
      return wrap(prepare(sql));
    } };
    assert.equal((await f.h.call(r.endpoint, { method: 'PATCH', body: r.body })).status, 409);
    assert.equal(injected, true);
    const row = await prepare('SELECT notes, planned_date FROM plans WHERE id = ?').bind(f.plan.id).first<{ notes: string; planned_date: string }>();
    assert.equal(row?.notes, 'Note saved by another writer'); assert.equal(row?.planned_date, '2026-10-08');
  } finally { await f.h.close(); }
});
