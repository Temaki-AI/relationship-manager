import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPhoneContactsVCard, getPhoneContactsManager } from '../lib/phone-contact-import.ts';

test('phone contact selections become importable vCards', () => {
  const vCard = buildPhoneContactsVCard([
    {
      name: ['Ada, Lovelace'],
      email: ['ada@example.com', 'ada@example.com'],
      tel: ['+44 20 7946 0958'],
    },
    {
      name: [String.raw`Grace\nHopper`],
      email: [],
      tel: ['+1 212 555 0100'],
    },
  ]);

  assert.match(vCard, /FN:Ada\\, Lovelace/);
  assert.equal(vCard.match(/EMAIL:ada@example\.com/g)?.length, 1);
  assert.match(vCard, /TEL:\+44 20 7946 0958/);
  assert.match(vCard, /FN:Grace\\\\nHopper/);
  assert.equal(vCard.match(/BEGIN:VCARD/g)?.length, 2);
});

test('phone contacts without any shared details are skipped', () => {
  assert.equal(buildPhoneContactsVCard([{ name: [], email: [], tel: [] }]), '');
});

test('phone contact picker support is feature detected', () => {
  const manager = {
    getProperties: async () => ['name', 'email', 'tel'],
    select: async () => [],
  };

  assert.equal(getPhoneContactsManager({ contacts: manager } as unknown as Navigator), manager);
  assert.equal(getPhoneContactsManager({} as Navigator), null);
});
