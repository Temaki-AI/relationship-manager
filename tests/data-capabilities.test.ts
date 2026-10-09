import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTOMATIC_ACCOUNT_SYNC, DATA_CAPABILITIES } from '../lib/data-capabilities.ts';

test('data connection catalog exposes only working, explicit product capabilities', () => {
  assert.equal(AUTOMATIC_ACCOUNT_SYNC.enabled, false);
  assert.match(AUTOMATIC_ACCOUNT_SYNC.message, /not read automatically/i);
  assert.equal(new Set(DATA_CAPABILITIES.map((capability) => capability.id)).size, DATA_CAPABILITIES.length);
  assert.deepEqual(
    DATA_CAPABILITIES.filter((capability) => capability.status === 'available').map((capability) => capability.id),
    ['linkedin-link', 'vcard', 'csv', 'encrypted-backup']
  );
  assert.equal(DATA_CAPABILITIES.some((capability) => /google|microsoft|calendar|gmail/i.test(capability.label)), false);

  for (const capability of DATA_CAPABILITIES) {
    assert.match(capability.href, /^\/(contacts|settings|connections\/linkedin)$/);
    assert(capability.description.length >= 60);
    assert(capability.privacy.length >= 60);
  }
});
