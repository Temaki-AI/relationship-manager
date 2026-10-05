import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import type { NativeAccount } from '../packages/domain/src/devices.ts';

const account: NativeAccount = { origin: 'https://everclosecrm.com', userId: 'timeline-test', workspaceId: 'timeline-test',
  deviceId: '00000000-0000-4000-8000-000000000001', email: 'timeline@example.test', name: 'Timeline test',
  expiresAt: '2027-01-01T00:00:00Z', token: 'everclose_device_' + 'a'.repeat(43) };

test('timeline pages include older history once with tied timestamps and ignore newer insertions', async () => {
  const phone = await createMobileHarness(account);
  try {
    const person = await phone.contacts.createContact(phone.db, { name: 'Timeline person' });
    const insert = phone.sqlite.prepare(`INSERT INTO interactions
      (id, contact_id, type, date, occurred_at, summary, notes, created_at, updated_at, deleted_at) VALUES (?, ?, 'message', ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 67; i++) insert.run(String(i).padStart(4, '0'), person.id, '2026-10-01',
      i < 10 ? null : '2026-10-01T12:00:00Z', 'Confirmed touch', 'Original note ' + i, '2026-10-01', '2026-10-01', i === 50 ? '2026-10-02' : null);
    let page = await phone.contacts.listContactInteractionPage(phone.db, person.id);
    assert.equal(page.interactions.length, 20);
    const seen = page.interactions.map((item) => item.id);
    insert.run('newer', person.id, '2026-10-05', '2026-10-05T12:00:00Z', 'New touch', null, '2026-10-05', '2026-10-05', null);
    while (page.nextCursor) {
      page = await phone.contacts.listContactInteractionPage(phone.db, person.id, page.nextCursor);
      seen.push(...page.interactions.map((item) => item.id));
    }
    assert.equal(seen.length, 66);
    assert.equal(new Set(seen).size, 66);
    assert.ok(!seen.includes('newer')); assert.ok(!seen.includes('0050'));
    assert.equal(page.interactions.at(-1)!.notes, 'Original note 0');
    assert.equal((await phone.contacts.listContactInteractionPage(phone.db, person.id)).interactions[0].id, 'newer');
    assert.deepEqual((await phone.contacts.listContactInteractions(phone.db, person.id)).map((item) => item.id),
      (await phone.contacts.listContactInteractionPage(phone.db, person.id)).interactions.map((item) => item.id));
    const other = await phone.contacts.createContact(phone.db, { name: 'Other person' });
    await assert.rejects(phone.contacts.listContactInteractionPage(phone.db, other.id,
      { contactId: person.id, date: '2026-10-01', occurredAt: '', id: '0001' }));
    phone.sqlite.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run('2026-10-05', person.id);
    assert.deepEqual(await phone.contacts.listContactInteractionPage(phone.db, person.id), { interactions: [], nextCursor: null });
  } finally { phone.close(); }
});
