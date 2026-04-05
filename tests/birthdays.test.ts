import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateDaysUntilBirthday } from '../lib/birthdays.ts';

test('calculateDaysUntilBirthday handles leap year dates correctly', () => {
  assert.equal(
    calculateDaysUntilBirthday(new Date('2024-02-28T12:00:00Z'), '2000-03-01'),
    2
  );
  assert.equal(
    calculateDaysUntilBirthday(new Date('2024-02-28T12:00:00Z'), '2000-02-29'),
    1
  );
});

test('calculateDaysUntilBirthday rolls forward to next year after the birthday passes', () => {
  assert.equal(
    calculateDaysUntilBirthday(new Date('2026-04-05T12:00:00Z'), '2000-04-04'),
    364
  );
  assert.equal(
    calculateDaysUntilBirthday(new Date('2026-04-05T12:00:00Z'), '2000-04-05'),
    0
  );
});
