import assert from 'node:assert/strict';
import test from 'node:test';
import { dateInTimeZone, nextBirthdayOccurrence, startOfCivilDayUTC } from '../lib/civil-date.ts';

test('civil date boundaries respect timezone offsets and daylight-saving changes', () => {
  assert.equal(dateInTimeZone('2026-09-04T23:30:00Z', 'Europe/Lisbon'), '2026-09-05');
  assert.equal(startOfCivilDayUTC('2026-09-05', 'Europe/Lisbon'), '2026-09-04T23:00:00.000Z');
  const spring = Date.parse(startOfCivilDayUTC('2026-03-30', 'Europe/Lisbon')) - Date.parse(startOfCivilDayUTC('2026-03-29', 'Europe/Lisbon'));
  const fall = Date.parse(startOfCivilDayUTC('2026-10-26', 'Europe/Lisbon')) - Date.parse(startOfCivilDayUTC('2026-10-25', 'Europe/Lisbon'));
  assert.equal(spring, 23 * 3_600_000);
  assert.equal(fall, 25 * 3_600_000);
  assert.equal(startOfCivilDayUTC('2026-09-05', 'Pacific/Kiritimati'), '2026-09-04T10:00:00.000Z');
});

test('birthday occurrences roll over years and consistently observe leap birthdays', () => {
  assert.deepEqual(nextBirthdayOccurrence('2000-02-29', '2027-02-28'), { occurrence: '2027-03-01', daysUntil: 1 });
  assert.deepEqual(nextBirthdayOccurrence('2000-02-29', '2027-03-02'), { occurrence: '2028-02-29', daysUntil: 364 });
  assert.deepEqual(nextBirthdayOccurrence('1990-01-01', '2026-12-31'), { occurrence: '2027-01-01', daysUntil: 1 });
  assert.equal(nextBirthdayOccurrence('1990-04-31', '2026-01-01'), null);
});
