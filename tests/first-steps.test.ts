import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFirstSteps, FIRST_CIRCLE_TAG, MAX_FIRST_CIRCLE_SIZE } from '../lib/first-steps.ts';

test('first steps use real circle membership and real logged history', () => {
  const contacts = [
    { id: 1, name: 'Ana', tags: JSON.stringify(['Friend', FIRST_CIRCLE_TAG]), birthday: '1989-08-03' },
    { id: 2, name: 'Bea', tags: JSON.stringify(['close circle']), birthday: null },
    { id: 3, name: 'Cara', tags: JSON.stringify(['Work']), birthday: null },
  ];
  const empty = buildFirstSteps(contacts, new Map());
  assert.equal(empty.circleCount, 2);
  assert.deepEqual(empty.circlePeople, [
    { id: 1, name: 'Ana', birthdayKnown: true },
    { id: 2, name: 'Bea', birthdayKnown: false },
  ]);
  assert.equal(empty.hasLoggedMoment, false);

  const withHistory = buildFirstSteps(contacts, new Map([[3, { interactionsCount: 1 }]]));
  assert.equal(withHistory.hasLoggedMoment, true);
});

test('first steps bound the suggested circle without losing the real member count', () => {
  const contacts = Array.from({ length: 7 }, (_, index) => ({
    id: index + 1,
    name: `Person ${index + 1}`,
    tags: JSON.stringify([FIRST_CIRCLE_TAG]),
    birthday: null,
  }));
  const result = buildFirstSteps(contacts, new Map());
  assert.equal(result.circleCount, 7);
  assert.equal(result.circlePeople.length, MAX_FIRST_CIRCLE_SIZE);
});
