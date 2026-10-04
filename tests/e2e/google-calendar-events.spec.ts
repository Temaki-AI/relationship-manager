import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { CalendarEventFacts, CalendarEventsReview } from '../../packages/domain/src/calendar-events';
const id = 'dd34bba6-a7d2-4f18-a862-958733f456b5', epoch = 'b5cac8f4-758f-442c-8faa-a36a8915d5f4', generation = 'dce4ac26-e549-4bff-a92a-c3f583805544', calendarId = 'personal@example.test';
const endpoint = '**/api/connections/' + id + '/calendars/events', url = '/connections/google/' + id + '/calendars/events?calendar_id=' + encodeURIComponent(calendarId);
test.beforeEach(async ({ page }) => {
  // Source and session endpoints are UI fixtures; real OAuth is a separate release gate.
  await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
});
function event(): CalendarEventFacts { return { id: 'meeting', status: 'confirmed', title: 'Lunch with Ana · relações', location: 'A long but readable place name near the café', visibility: 'default', redacted: false, event_type: 'default',
  start: { date: null, date_time: '2026-10-04T12:00:00+01:00', time_zone: 'Europe/Lisbon', instant: '2026-10-04T11:00:00Z' }, end: { date: null, date_time: '2026-10-04T13:00:00+01:00', time_zone: 'Europe/Lisbon', instant: '2026-10-04T12:00:00Z' },
  original_start: null, recurring_id: null, ical_uid: 'meeting@google.test', updated: '2026-10-04T10:00:00Z', etag: 'e1', organizer: { email: 'owner@example.test', name: 'Owner', self: true },
  attendees: [{ email: 'ana@example.test', name: 'Ana', self: false, resource: false, organizer: false, response: 'accepted' }], attendees_incomplete: true, google_url: 'https://calendar.google.com/calendar/event?eid=meeting', conference_url: 'https://meet.google.com/abc-defg-hij' }; }
function review(): CalendarEventsReview { return { epoch, authorization_revision: 1, selection_revision: 3, calendar: { id: calendarId, summary: 'Personal meetings · relações', time_zone: 'Europe/Lisbon', access_role: 'owner', primary: true, hidden: false }, availability: 'available', can_download: true, generation: null, last_downloaded_at: null, window_start: null, window_end: null, events: [], more: false, next: null, run: null, schedule: { enabled: false, interval: 86400, revision: 0, past_days: 90, future_days: 180, next_at: null } }; }
test('Explicit downloads expose only complete events, preserve all-day/recurring/private context and pass mobile accessibility', async ({ page }, info) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message)); let data = review(), starts = 0, steps = 0;
  const base = event(), busy = { ...base, id: 'busy', title: 'Busy', redacted: true, visibility: 'private' as const, attendees: [], attendees_incomplete: false, organizer: null, location: null, google_url: null, conference_url: null };
  const allDay = { ...base, id: 'all-day', title: 'Holiday', start: { date: '2026-10-04', date_time: null, time_zone: null, instant: null }, end: { date: '2026-10-06', date_time: null, time_zone: null, instant: null }, recurring_id: 'annual', original_start: { date: '2026-10-04', date_time: null, time_zone: null, instant: null } };
  const removed = { ...base, id: 'deleted', title: 'Cancelled event', status: 'cancelled' as const, start: null, end: null, attendees: [], attendees_incomplete: false, organizer: null, location: null, google_url: null, conference_url: null };
  await page.route(endpoint + '?*', async (route) => { const include = new URL(route.request().url()).searchParams.get('cancelled') === '1'; await route.fulfill({ json: { ...data, events: data.generation ? [base, busy, allDay, ...(include ? [removed] : [])] : [] } }); });
  await page.route(endpoint, async (route) => { const body = route.request().postDataJSON(); expect(body.calendar_id).toBe(calendarId); expect(body.past_days).toBe(90); expect(body.future_days).toBe(180); expect(body.expected_selection_revision).toBe(3); starts++; data = { ...data, run: { id: body.operation_id, status: 'active', processed: 0, pages: 0, issue: null, retry_at: 0 } }; await route.fulfill({ json: data.run }); });
  await page.route(endpoint + '/step', async (route) => { expect(route.request().postDataJSON()).toEqual({ run_id: data.run!.id }); steps++; data = { ...data, generation, window_start: '2026-07-06T23:00:00Z', window_end: '2027-04-03T23:00:00Z', last_downloaded_at: '2026-10-04T10:00:00Z', run: { ...data.run!, status: 'complete', processed: 4, pages: 1 } }; await route.fulfill({ json: data.run }); });
  await page.goto(url); await expect(page.getByRole('heading', { name: 'Google Calendar events', exact: true })).toBeVisible(); await expect(page.getByText('No complete download yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Download events', exact: true }).click(); expect(starts).toBe(0);
  const dialog = page.getByRole('alertdialog', { name: "Download this calendar's events?" }); await expect(dialog).toContainText('does not create people'); await dialog.getByRole('button', { name: 'Confirm event download', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue event download', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: base.title, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue event download', exact: true }).click(); await expect(page.getByRole('heading', { name: base.title, exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Busy', exact: true })).toBeVisible();
  await expect(page.getByText('Private details were not saved.')).toBeVisible(); await expect(page.getByText('All-day dates: 2026-10-04 to 2026-10-06 (end excluded).')).toBeVisible(); await expect(page.getByText('Google supplied a partial participant list.').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cancelled event', exact: true })).toHaveCount(0); await page.getByRole('checkbox', { name: 'Include cancelled source events' }).check(); await expect(page.getByRole('heading', { name: 'Cancelled event', exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: info.outputPath('calendar-events.png'), fullPage: true }); expect(errors).toEqual([]); expect([starts, steps]).toEqual([1, 1]);
});
test('An unconfirmed start survives reload and retries the exact date window once', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  let data = review(), first: string | null = null, effects = 0, requests = 0, cancellations = 0;
  await page.route(endpoint + '?*', (route) => route.fulfill({ json: data }));
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'DELETE') { expect(route.request().postDataJSON()).toEqual({ run_id: data.run!.id }); cancellations++; data = { ...data, run: { ...data.run!, status: 'cancelled', issue: 'cancelled_by_user' } }; await route.fulfill({ json: data.run }); return; }
    requests++; const body = route.request().postData()!;
    if (!first) { first = body; effects++; const parsed = JSON.parse(body); expect(parsed.past_days).toBe(7); expect(parsed.future_days).toBe(14); data = { ...data, run: { id: parsed.operation_id, status: 'active', processed: 0, pages: 0, issue: null, retry_at: 0 } }; await route.fulfill({ status: 503, json: { error: 'Acknowledgement lost' } }); }
    else { expect(body).toBe(first); await route.fulfill({ json: data.run }); }
  });
  await page.goto(url); await page.getByLabel('Past days', { exact: true }).fill('7'); await page.getByLabel('Future days', { exact: true }).fill('14');
  await page.getByRole('button', { name: 'Download events', exact: true }).click(); await page.getByRole('button', { name: 'Confirm event download', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry unchanged download' })).toBeVisible(); await page.reload(); await expect(page.getByRole('button', { name: 'Retry unchanged download' })).toBeVisible(); await expect(page.getByLabel('Past days', { exact: true })).toHaveValue('7');
  await page.getByRole('button', { name: 'Retry unchanged download' }).click(); await expect(page.getByRole('button', { name: 'Retry unchanged download' })).toHaveCount(0); expect([effects, requests]).toEqual([1, 2]);
  await page.getByRole('button', { name: 'Cancel event download', exact: true }).click(); await expect(page.getByRole('button', { name: 'Download events', exact: true })).toBeEnabled(); expect(cancellations).toBe(1);
});
test('Unavailable calendars and invalid windows prevent a new download while cached events remain readable', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } }); let downloads = 0;
  await page.route(endpoint + '?*', (route) => route.fulfill({ json: { ...review(), availability: 'unavailable', can_download: false, generation, events: [event()] } }));
  await page.route(endpoint, (route) => { downloads++; return route.fulfill({ json: {} }); });
  await page.goto(url); await expect(page.getByRole('heading', { name: event().title, exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Download events', exact: true })).toBeDisabled();
  await page.getByLabel('Past days', { exact: true }).fill('366'); await expect(page.getByRole('button', { name: 'Download events', exact: true })).toBeDisabled(); expect(downloads).toBe(0);
});
test('Automatic downloads are explicitly confirmed before first use and can be disabled without losing source context', async ({ page }, info) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  let data = review(); const changes: Array<Record<string, unknown>> = [];
  await page.route(endpoint + '?*', (route) => route.fulfill({ json: data }));
  await page.route(endpoint + '/schedule', async (route) => {
    expect(route.request().method()).toBe('PATCH'); const body = route.request().postDataJSON(); changes.push(body);
    expect(body.expected_settings_revision).toBe(data.schedule.revision); expect(body.expected_epoch).toBe(epoch); expect(body.expected_selection_revision).toBe(3);
    data = { ...data, schedule: { enabled: body.enabled, interval: body.interval, revision: data.schedule.revision + 1, past_days: body.past_days, future_days: body.future_days, next_at: body.enabled ? Date.now() : null } };
    await route.fulfill({ json: { success: true } });
  });
  await page.goto(url); const section = page.getByRole('region', { name: 'Automatic event downloads' });
  await expect(section.getByText('Currently off.')).toBeVisible(); expect(changes).toEqual([]);
  await section.getByRole('checkbox', { name: 'Keep this calendar updated' }).check(); await page.getByLabel('Refresh frequency').selectOption('3600');
  await page.getByLabel('Automatic past days').fill('7'); await page.getByLabel('Automatic future days').fill('14');
  await page.getByRole('button', { name: 'Review automatic choices' }).click(); expect(changes.length).toBe(0);
  await expect(page.getByRole('alertdialog')).toContainText('7 past days and 14 future days'); await page.getByRole('button', { name: 'Save automatic choices', exact: true }).click();
  await expect(section.getByText('Currently on · hourly.', { exact: false })).toBeVisible(); expect(changes.length).toBe(1); expect(changes[0].past_days).toBe(7);
  data = { ...data, generation, events: [event()], last_downloaded_at: new Date().toISOString() }; await page.getByRole('button', { name: 'Refresh event status' }).click();
  await section.getByRole('checkbox', { name: 'Keep this calendar updated' }).uncheck(); await page.getByRole('button', { name: 'Review automatic choices' }).click(); await page.getByRole('button', { name: 'Save automatic choices', exact: true }).click();
  await expect(section.getByText('Currently off.')).toBeVisible(); await expect(page.getByRole('heading', { name: event().title, exact: true })).toBeVisible(); expect(changes.length).toBe(2);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: info.outputPath('calendar-automatic-choices.png'), fullPage: true });
});
test('An unconfirmed schedule locks its choices, retries the exact body and resolves through authoritative status', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  let data = review(), original: string | null = null, requests = 0;
  await page.route(endpoint + '?*', (route) => route.fulfill({ json: data }));
  await page.route(endpoint + '/schedule', async (route) => {
    requests++; const raw = route.request().postData()!;
    if (!original) { original = raw; await route.fulfill({ status: 503, json: { error: 'Save unconfirmed' } }); }
    else { expect(raw).toBe(original); const body = JSON.parse(raw); data = { ...data, schedule: { enabled: body.enabled, interval: body.interval, revision: 1, past_days: body.past_days, future_days: body.future_days, next_at: Date.now() } }; await route.fulfill({ json: { success: true } }); }
  });
  await page.goto(url); await page.getByRole('checkbox', { name: 'Keep this calendar updated' }).check();
  await page.getByRole('button', { name: 'Review automatic choices' }).click(); await page.getByRole('button', { name: 'Save automatic choices', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry unchanged automatic choices' })).toBeVisible(); await expect(page.getByLabel('Automatic past days')).toBeDisabled();
  await page.getByRole('button', { name: 'Retry unchanged automatic choices' }).click(); await expect(page.getByRole('button', { name: 'Retry unchanged automatic choices' })).toHaveCount(0); expect(requests).toBe(2);
});
