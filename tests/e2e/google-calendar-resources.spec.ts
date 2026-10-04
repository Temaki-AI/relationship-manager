import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { CalendarReview } from '../../packages/domain/src/calendars';
const id = 'dd34bba6-a7d2-4f18-a862-958733f456b5', epoch = 'b5cac8f4-758f-442c-8faa-a36a8915d5f4', generation = 'dce4ac26-e549-4bff-a92a-c3f583805544';
const calendar = { facts: { id: 'personal@example.test', summary: 'Personal meetings with a long calendar name and accented people · relações', time_zone: 'Europe/Lisbon', access_role: 'owner' as const, primary: true, hidden: false }, availability: 'available' as const, selected: false, observed_at: '2026-10-04T10:00:00Z' };
test.beforeEach(async ({ page }) => { await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } })); });
function review(): CalendarReview { return { epoch, authorization_revision: 1, generation, selection_revision: 2, selected_ids: [], calendars: [calendar], selected_calendars: [], more: false, next: null, run: null, last_discovered_at: '2026-10-04T10:00:00Z' }; }
test('Calendar grants remain separate from Contacts and open the explicit Calendar consent purpose', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  let configured = false;
  await page.route('**/api/connections', (route) => route.fulfill({ json: { mode: 'cloud', configured: true, configured_purposes: { contacts: true, calendar: configured }, epoch,
    connections: [{ id, purpose: 'calendar', email: 'calendar@example.test', display_name: 'Calendar Owner', status: 'connected', revision: 1 }, { id: 'bb34bba6-a7d2-4f18-a862-958733f456b5', purpose: 'contacts', email: 'contacts@example.test', display_name: 'Contacts Owner', status: 'connected', revision: 1 }] } }));
  await page.route('**/api/connections/google/authorize', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ purpose: 'calendar', expected_epoch: epoch });
    await route.fulfill({ json: { authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?scope=calendar-test' } });
  });
  await page.route('https://accounts.google.com/o/oauth2/v2/auth?*', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Calendar consent opened</h1>' }));
  await page.goto('/connections/google/calendar'); await expect(page.getByRole('heading', { level: 1 })).toHaveText('Google Calendar connections');
  await expect(page.getByRole('article')).toContainText('Calendar Owner'); await expect(page.getByRole('article')).not.toContainText('Contacts Owner');
  await expect(page.getByRole('button', { name: 'Connect Google Calendar', exact: true })).toBeDisabled();
  configured = true; await page.reload(); await page.getByRole('button', { name: 'Connect Google Calendar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Calendar consent opened', exact: true })).toBeVisible();
});
test('calendars require a complete discovery and explicit reviewed choices on desktop and mobile', async ({ page }, info) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  let data = { ...review(), generation: null, selection_revision: 0, calendars: [], last_discovered_at: null } as CalendarReview;
  let discoveries = 0, steps = 0, selections = 0;
  const endpoint = '**/api/connections/' + id + '/calendars';
  await page.route(endpoint + '?*', (route) => route.fulfill({ json: data }));
  await page.route(endpoint, async (route) => {
    expect(route.request().method()).toBe('POST'); expect(route.request().postDataJSON().expected_epoch).toBe(epoch); discoveries++;
    data = { ...data, run: { id: 'c792e60e-966e-46b9-a2b2-7c18f06fb82b', status: 'active', pages: 0, processed: 0, issue: null, retry_at: 0 } }; await route.fulfill({ json: data.run });
  });
  await page.route(endpoint + '/step', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ run_id: data.run!.id }); steps++; data = { ...review(), run: { ...data.run!, status: 'complete', pages: 1, processed: 2 }, calendars: [calendar, { ...calendar, facts: { ...calendar.facts, id: 'busy@example.test', summary: 'Busy calendar', access_role: 'freeBusyReader' }, availability: 'available' }] }; await route.fulfill({ json: data.run });
  });
  await page.route(endpoint + '/selection', async (route) => {
    const body = route.request().postDataJSON(); expect(body.selected_ids).toEqual(['personal@example.test']); expect(body.expected_generation).toBe(generation); expect(body.expected_selection_revision).toBe(2); selections++;
    data = { ...data, selected_ids: body.selected_ids, selection_revision: 3, calendars: data.calendars.map((item) => ({ ...item, selected: item.facts.id === 'personal@example.test' })), selected_calendars: [{ ...calendar, selected: true }] };
    await route.fulfill({ json: { replayed: false, applied_revision: 3 } });
  });
  await page.goto('/connections/google/' + id + '/calendars');
  await expect(page.getByRole('button', { name: 'Save reviewed calendars', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Discover calendars', exact: true }).click(); await expect(page.getByRole('button', { name: 'Continue discovery', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continue discovery', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Busy calendar', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: calendar.facts.summary, exact: true }).check(); expect(selections).toBe(0);
  await page.getByRole('button', { name: 'Save reviewed calendars', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Save these calendar choices?' }); await expect(dialog).toContainText('does not download events');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(selections).toBe(0);
  await page.getByRole('button', { name: 'Save reviewed calendars', exact: true }).click(); await dialog.getByRole('button', { name: 'Confirm calendar choices', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved calendar choices', exact: true })).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze(); expect(axe.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('google-calendar-choices.png'), fullPage: true }); expect(errors).toEqual([]); expect([discoveries, steps, selections]).toEqual([1, 1, 1]);
});
test('uncertain calendar choices survive reload and retry the unchanged receipt instead of resubmitting new choices', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  let data = review(), first = '', writes = 0, requests = 0;
  const endpoint = '**/api/connections/' + id + '/calendars';
  await page.route(endpoint + '?*', (route) => route.fulfill({ json: data }));
  await page.route(endpoint + '/selection', async (route) => {
    requests++; const body = route.request().postData()!;
    if (!first) { first = body; writes++; data = { ...data, selected_ids: ['personal@example.test'], selection_revision: 3, selected_calendars: [{ ...calendar, selected: true }] }; await route.fulfill({ status: 503, json: { error: 'Reply was lost after save' } }); }
    else { expect(body).toBe(first); await route.fulfill({ json: { replayed: true, applied_revision: 3 } }); }
  });
  await page.goto('/connections/google/' + id + '/calendars'); await page.getByRole('checkbox', { name: calendar.facts.summary, exact: true }).check();
  await page.getByRole('button', { name: 'Save reviewed calendars', exact: true }).click(); await page.getByRole('button', { name: 'Confirm calendar choices', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unconfirmed calendar choices', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Unconfirmed calendar choices', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: calendar.facts.summary, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry unchanged choices', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unconfirmed calendar choices', exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: calendar.facts.summary, exact: true })).toBeChecked(); expect(writes).toBe(1); expect(requests).toBe(2);
});
