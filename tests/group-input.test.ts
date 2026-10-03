import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGroupColor, parseGroupName } from '../lib/group-input.ts';

test('group input accepts bounded names and safe colors', () => {
  assert.equal(parseGroupName('  Family  '), 'Family');
  assert.equal(parseGroupName('x'.repeat(101)), null);
  assert.equal(parseGroupColor('#F43F5E'), '#f43f5e');
  assert.equal(parseGroupColor('url(https://attacker.test)'), undefined);
  assert.equal(parseGroupColor(''), null);
});
