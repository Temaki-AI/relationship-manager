import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileHarness } from './helpers/mobile-harness.ts';
import type { NativeAccount } from '../packages/domain/src/devices.ts';

const account: NativeAccount = {
  origin: 'https://everclosecrm.com', userId: 'paging-test', workspaceId: 'paging-test',
  deviceId: '00000000-0000-4000-8000-000000000001', email: 'paging@example.test', name: 'Paging test',
  expiresAt: '2027-01-01T00:00:00Z', token: 'everclose_device_' + 'a'.repeat(43),
};

test('native people pages include every active person beyond the former 500-person limit', async () => {
  const phone = await createMobileHarness(account);
  try {
    const insert = phone.sqlite.prepare('INSERT INTO contacts (id, name, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)');
    phone.sqlite.transaction(() => {
      for (let i = 0; i < 607; i++) insert.run(String(i).padStart(4, '0'), i < 100 ? 'Same name' : 'Person ' + String(i).padStart(4, '0'),
        '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z', i === 600 ? '2026-10-05T01:00:00Z' : null);
    })();
    const seen: string[] = [];
    for (let page = 0; ; page++) {
      const result = await phone.contacts.listContactPage(phone.db, '', page);
      assert.ok(result.contacts.length <= 50);
      seen.push(...result.contacts.map((person) => person.id));
      if (!result.hasMore) break;
    }
    assert.equal(seen.length, 606);
    assert.equal(new Set(seen).size, 606);
    assert.ok(seen.includes('0606'));
    assert.ok(!seen.includes('0600'));
    assert.deepEqual(seen, phone.sqlite.prepare('SELECT id FROM contacts WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, id').all().map((row) => row.id));
    assert.deepEqual(await phone.contacts.listContactPage(phone.db, '', 50), { contacts: [], hasMore: false });
    await assert.rejects(phone.contacts.listContactPage(phone.db, '', -1));
    await assert.rejects(phone.contacts.listContactPage(phone.db, '', 0.5));
  } finally { phone.close(); }
});

test('native paged search treats wildcard characters literally and finds saved additional methods', async () => {
  const phone = await createMobileHarness(account);
  try {
    const literal = await phone.contacts.createContact(phone.db, { name: '100%_ care', notes: 'Private note' });
    await phone.contacts.createContact(phone.db, { name: '100 percent care' });
    const methods = JSON.stringify([{ id: 'extra-email', kind: 'email', label: 'Secondary', value: 'other@example.test', preferred: false }]);
    phone.sqlite.prepare('UPDATE contacts SET contact_methods = ? WHERE id = ?').run(methods, literal.id);
    for (const search of ['%_', 'private note', 'other@example.test', 'Secondary']) {
      const result = await phone.contacts.listContactPage(phone.db, search);
      assert.deepEqual(result.contacts.map((person) => person.id), [literal.id]);
      assert.equal(result.hasMore, false);
    }
    assert.deepEqual((await phone.contacts.listContactPage(phone.db, "' OR 1=1 --")).contacts, []);
  } finally { phone.close(); }
});
