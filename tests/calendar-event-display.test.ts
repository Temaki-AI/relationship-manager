import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarEventWhen, calendarEventDayRange } from '../packages/domain/src/calendar-event-display.ts';
import type { EventMoment } from '../packages/domain/src/calendar-events.ts';
const day = (date: string): EventMoment => ({ date, date_time: null, instant: null, time_zone: null });
const time = (instant: string, time_zone: string | null): EventMoment => ({ date: null, date_time: instant, instant, time_zone });
test('all-day intervals display civil dates and their inclusive final day without adding times', () => {
  assert.equal(calendarEventWhen({ start: day('2026-10-04'), end: day('2026-10-05') }, 'America/Los_Angeles', 'en-US'), 'Oct 4, 2026 · All day');
  assert.equal(calendarEventWhen({ start: day('2026-10-04'), end: day('2026-10-07') }, 'Pacific/Auckland', 'en-US'), 'Oct 4, 2026 – Oct 6, 2026 · All day');
});
test('a repeated DST hour keeps both offsets visible and timed endpoints preserve their own timezone', () => {
  const repeated = calendarEventWhen({ start: time('2026-10-25T00:30:00Z', 'Europe/Lisbon'), end: time('2026-10-25T01:30:00Z', 'Europe/Lisbon') }, 'UTC', 'en-US');
  assert.match(repeated, /1:30 AM \(Europe\/Lisbon, GMT\+1\).*1:30 AM \(Europe\/Lisbon, GMT(?:\+0)?\)/);
  const trip = calendarEventWhen({ start: time('2026-10-04T10:00:00Z', 'Europe/Lisbon'), end: time('2026-10-04T15:00:00Z', 'America/New_York') }, 'UTC', 'en-US');
  assert.match(trip, /Europe\/Lisbon, GMT\+1/); assert.match(trip, /America\/New_York, GMT-4/);
});
test('missing cancellation dates are explicit; missing endpoint zones use the calendar timezone', () => {
  assert.equal(calendarEventWhen({ start: null, end: null }, 'Europe/Lisbon'), 'Date unavailable');
  assert.match(calendarEventWhen({ start: time('2026-10-04T10:00:00Z', null), end: null }, 'Europe/Lisbon', 'en-US'), /11:00 AM \(Europe\/Lisbon, GMT\+1\)/);
  assert.equal(calendarEventWhen({ start: null, original_start: day('2026-10-04'), end: null }, 'America/Los_Angeles', 'en-US'), 'Oct 4, 2026 · All day');
  assert.deepEqual(calendarEventDayRange({ start: null, original_start: day('2026-10-04'), end: null }, 'America/Los_Angeles'), { first: '2026-10-04', last: '2026-10-04' });
});
test('an unresolved source time displays its supplied local value without inventing a viewer date or offset', () => {
  const start: EventMoment = { date: null, date_time: '2026-10-25T01:30:00', time_zone: 'Europe/Lisbon', instant: null };
  assert.equal(calendarEventWhen({ start, end: null }, 'UTC'), '2026-10-25 01:30:00 (Europe/Lisbon; offset not supplied)');
  assert.equal(calendarEventDayRange({ start, end: null, original_start: null }, 'America/Los_Angeles'), null);
});
