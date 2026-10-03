import assert from 'node:assert/strict';
import test from 'node:test';
import { describeCheckInRhythm } from '../lib/check-in-rhythm.ts';

const today = '2026-10-02';

test('unknown history is not graded as a healthy relationship', () => {
  assert.deepEqual(describeCheckInRhythm({ last_contacted: null, contact_frequency: 14 }, today), {
    kind: 'untracked', label: 'Not tracking yet', detail: 'No conversation logged yet.',
  });
  assert.equal(describeCheckInRhythm({ last_contacted: 'not-a-date', contact_frequency: 14 }, today).kind, 'untracked');
});

test('check-in states follow the chosen interval without early shame labels', () => {
  const rhythm = (last_contacted: string) => describeCheckInRhythm({ last_contacted, contact_frequency: 14 }, today);
  assert.deepEqual(rhythm('2026-09-24'), {
    kind: 'on-track', label: 'On your rhythm', detail: 'Last in touch 8 days ago; next check-in in 6 days.',
  });
  assert.equal(rhythm('2026-09-20').kind, 'due-soon');
  assert.equal(rhythm('2026-09-18').label, 'Check-in day');
  assert.deepEqual(rhythm('2026-09-15'), {
    kind: 'ready', label: 'Ready to reconnect', detail: 'Last in touch 17 days ago; 3 days past your 14-day preference.',
  });
});

test('check-in timing uses civil dates and handles future or missing cadence safely', () => {
  assert.equal(describeCheckInRhythm({ last_contacted: '2026-03-28', contact_frequency: 7 }, '2026-03-29').detail, 'Last in touch 1 day ago; next check-in in 6 days.');
  assert.equal(describeCheckInRhythm({ last_contacted: '2026-10-03', contact_frequency: 14 }, today).detail, 'Last in touch today; next check-in in 14 days.');
  assert.equal(describeCheckInRhythm({ last_contacted: '2026-10-01', contact_frequency: 0 }, today).kind, 'on-track');
});
