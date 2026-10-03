import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDateOnly,
  parseDateTime,
  parseOptionalText,
  parsePositiveInteger,
  parseRelationshipActivityType,
} from '../lib/relationship-validation.ts';

test('relationship input validation accepts only supported values', () => {
  assert.equal(parsePositiveInteger('12'), 12);
  assert.equal(parsePositiveInteger('-1'), null);
  assert.equal(parseDateOnly('2026-02-28'), '2026-02-28');
  assert.equal(parseDateOnly('2026-02-30'), null);
  assert.equal(parseDateTime('2026-07-10T12:30'), null);
  assert.equal(parseDateTime('2026-07-10T12:30:00+02:00'), '2026-07-10T10:30:00.000Z');
  assert.equal(parseDateTime('2026-07-10T12:30:00Z'), '2026-07-10T12:30:00.000Z');
  assert.equal(parseDateTime('not-a-date'), null);
  assert.equal(parseRelationshipActivityType('meetup'), 'meetup');
  assert.equal(parseRelationshipActivityType('wire-transfer'), null);
  assert.equal(parseOptionalText('  hello  ', 20), 'hello');
  assert.equal(parseOptionalText('too long', 3), undefined);
});
