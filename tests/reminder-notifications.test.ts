import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accountNotificationStorageKey,
  parseBirthdayNotificationLedger,
  parseReminderNotificationLedger,
  prepareBirthdayNotificationCheck,
  prepareReminderNotificationCheck,
} from '../lib/reminder-notifications.ts';

test('browser alert settings and ledgers are keyed to the verified account', () => {
  const base = 'bonds-reminder-notification-ledger-v1';
  assert.notEqual(accountNotificationStorageKey(base, 'google:user-a'), accountNotificationStorageKey(base, 'google:user-b'));
  assert.equal(accountNotificationStorageKey(base, 'google:user/a'), `${base}:google%3Auser%2Fa`);
  assert.throws(() => accountNotificationStorageKey(base, ''), /verified account/);
});

test('notification ledger parsing rejects malformed state and bounds duplicate entries', () => {
  assert.deepEqual(parseReminderNotificationLedger(null), []);
  assert.deepEqual(parseReminderNotificationLedger('{bad json'), []);
  assert.deepEqual(parseReminderNotificationLedger(JSON.stringify({ key: 'value' })), []);
  assert.deepEqual(
    parseReminderNotificationLedger(JSON.stringify([
      '1@2026-07-11T09:00:00.000Z',
      'not-a-reminder-key',
      '1@2026-07-11T09:00:00.000Z',
      42,
    ])),
    ['1@2026-07-11T09:00:00.000Z']
  );
});

test('due reminders notify once, prune completed entries, and notify again after rescheduling', () => {
  const now = new Date('2026-07-11T10:00:00.000Z');
  const reminders = [
    { id: 1, remind_at: '2026-07-11T09:00:00.000Z' },
    { id: 2, remind_at: '2026-07-11T11:00:00.000Z' },
  ];

  const first = prepareReminderNotificationCheck(reminders, [], now);
  assert.equal(first.newDueCount, 1);
  assert.deepEqual(first.nextLedger, ['1@2026-07-11T09:00:00.000Z']);

  const repeated = prepareReminderNotificationCheck(reminders, first.nextLedger, now);
  assert.equal(repeated.newDueCount, 0);
  assert.deepEqual(repeated.nextLedger, first.nextLedger);

  const rescheduled = prepareReminderNotificationCheck([
    { id: 1, remind_at: '2026-07-11T09:30:00.000Z' },
    reminders[1],
  ], repeated.nextLedger, now);
  assert.equal(rescheduled.newDueCount, 1);
  assert.deepEqual(rescheduled.nextLedger, ['1@2026-07-11T09:30:00.000Z']);

  const completed = prepareReminderNotificationCheck([reminders[1]], rescheduled.nextLedger, now);
  assert.equal(completed.newDueCount, 0);
  assert.deepEqual(completed.nextLedger, []);
});

test('invalid reminder candidates never enter the notification ledger', () => {
  const check = prepareReminderNotificationCheck([
    { id: 0, remind_at: '2026-07-11T09:00:00.000Z' },
    { id: 1, remind_at: 'not-a-date' },
  ], [], new Date('2026-07-11T10:00:00.000Z'));

  assert.deepEqual(check, { newDueCount: 0, nextLedger: [] });
});

test('birthday alerts notify once per annual occurrence and reject invalid candidates', () => {
  assert.deepEqual(parseBirthdayNotificationLedger('{bad json'), []);
  assert.deepEqual(
    parseBirthdayNotificationLedger(JSON.stringify([
      '7@2026-07-18',
      '7@2026-07-18',
      'invalid',
    ])),
    ['7@2026-07-18']
  );

  const first = prepareBirthdayNotificationCheck([
    { id: 7, occurrence: '2026-07-18' },
    { id: 0, occurrence: '2026-07-18' },
  ], []);
  assert.deepEqual(first, { newDueCount: 1, nextLedger: ['7@2026-07-18'] });

  const repeated = prepareBirthdayNotificationCheck([
    { id: 7, occurrence: '2026-07-18' },
  ], first.nextLedger);
  assert.deepEqual(repeated, { newDueCount: 0, nextLedger: first.nextLedger });

  const nextYear = prepareBirthdayNotificationCheck([
    { id: 7, occurrence: '2027-07-18' },
  ], repeated.nextLedger);
  assert.deepEqual(nextYear, { newDueCount: 1, nextLedger: ['7@2027-07-18'] });
});
