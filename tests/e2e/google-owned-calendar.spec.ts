import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const id = 'dd34bba6-a7d2-4f18-a862-958733f456b5', epoch = 'b5cac8f4-758f-442c-8faa-a36a8915d5f4';
const endpoint = '**/api/connections/' + id + '/owned-calendar';
const initial = () => ({ epoch, authorization_revision: 1, email: 'owner@example.test', can_continue: true, unsent_access_changed: false, setup: null as null | {
  operation_id: string; revision: number; status: string; attempted: boolean; calendar_id: string | null; issue: string | null; chosen_time_zone: string;
} });
test.beforeEach(async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
});
test('publishing requests separate consent and shows only its own account purpose', async ({ page }) => {
  await page.route('**/api/connections', (route) => route.fulfill({ json: { mode: 'cloud', configured: true,
    configured_purposes: { contacts: true, calendar: true, 'calendar-publish': true }, epoch, connections: [
      { id, purpose: 'calendar-publish', email: 'publisher@example.test', display_name: 'Publishing Owner', status: 'connected', revision: 1 },
      { id: 'bb34bba6-a7d2-4f18-a862-958733f456b5', purpose: 'calendar', email: 'reader@example.test', display_name: 'Reading Owner', status: 'connected', revision: 1 },
    ] } }));
  await page.route('**/api/connections/google/authorize', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ purpose: 'calendar-publish', expected_epoch: epoch });
    await route.fulfill({ json: { authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?scope=publishing-test' } });
  });
  await page.route('https://accounts.google.com/o/oauth2/v2/auth?*', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Publishing consent opened</h1>' }));
  await page.goto('/connections/google/publish');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Google Calendar publishing connections');
  await expect(page.getByRole('article')).toContainText('Publishing Owner'); await expect(page.getByRole('article')).not.toContainText('Reading Owner');
  await expect(page.getByRole('main').getByText('Choose an open plan after setup, review its event details and confirm any Google invitations.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Connect Calendar publishing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Publishing consent opened', exact: true })).toBeVisible();
});
test('creating an empty calendar needs both reviews and an uncertain create switches to verification', async ({ page }, info) => {
  let data = initial(), starts = 0, creates = 0, verifies = 0;
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: data });
    expect(route.request().method()).toBe('POST'); starts++; const body = route.request().postDataJSON();
    expect(body.expected_epoch).toBe(epoch); expect(body.time_zone).toBe('Europe/Lisbon');
    data = { ...data, setup: { operation_id: body.operation_id, revision: 1, status: 'pending', attempted: false, calendar_id: null, issue: null, chosen_time_zone: body.time_zone } };
    await route.fulfill({ json: data.setup });
  });
  await page.route(endpoint + '/step', async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ operation_id: data.setup!.operation_id, expected_revision: data.setup!.revision, expected_epoch: epoch, expected_authorization_revision: 1 });
    if (!data.setup!.attempted) {
      creates++; data = { ...data, setup: { ...data.setup!, attempted: true, revision: 2, status: 'unknown', issue: 'retry' } };
      await route.abort('failed');
    } else {
      verifies++; data = { ...data, setup: { ...data.setup!, revision: 3, status: 'ready', calendar_id: 'app-created@example.test', issue: null } };
      await route.fulfill({ json: data.setup });
    }
  });
  await page.goto('/connections/google/' + id + '/publish');
  await page.getByLabel('Calendar timezone', { exact: true }).fill('Europe/Lisbon');
  await page.getByRole('button', { name: 'Review calendar setup', exact: true }).click();
  const review = page.getByRole('alertdialog', { name: 'Save this calendar setup?' });
  await expect(review).toContainText('does not contact Google'); expect(starts).toBe(0);
  await review.getByRole('button', { name: 'Save reviewed setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reviewed setup', exact: true })).toBeVisible(); expect(creates).toBe(0);
  await page.getByRole('button', { name: 'Create empty calendar', exact: true }).click();
  const create = page.getByRole('alertdialog', { name: 'Create an empty Everclose calendar?' });
  await expect(create).toContainText('No people, plan events, invitations or private CRM notes'); await create.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(creates).toBe(0);
  await page.getByRole('button', { name: 'Create empty calendar', exact: true }).click();
  await create.getByRole('button', { name: 'Confirm calendar creation', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh setup status', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Original calendar needs verification', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create empty calendar', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Discard unsent setup', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Verify original calendar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Calendar verified', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Google Calendar', exact: true })).toHaveAttribute('href', 'https://calendar.google.com/calendar/u/0/r');
  expect([starts, creates, verifies]).toEqual([1, 1, 1]);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('owned-calendar-ready.png'), fullPage: true });
});
test('an unconfirmed preparation survives reload and retries the identical review before timezone changes', async ({ page }) => {
  let data = initial(), first = '', attempts = 0;
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: data });
    attempts++; const raw = route.request().postData()!;
    if (attempts === 1) { first = raw; return route.abort('failed'); }
    expect(raw).toBe(first); const body = route.request().postDataJSON();
    data = { ...data, setup: { operation_id: body.operation_id, revision: 1, status: 'pending', attempted: false, calendar_id: null, issue: null, chosen_time_zone: body.time_zone } };
    await route.fulfill({ json: data.setup });
  });
  await page.goto('/connections/google/' + id + '/publish'); await page.getByLabel('Calendar timezone').fill('UTC');
  await page.getByRole('button', { name: 'Review calendar setup', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save reviewed setup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry setup save', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name: 'Retry setup save', exact: true })).toBeVisible();
  await expect(page.getByLabel('Calendar timezone')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry setup save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reviewed setup', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry setup save', exact: true })).toHaveCount(0);
  expect(attempts).toBe(2);
});
test('held unsent setups require a new review, while invalid timezones can be corrected after rejection', async ({ page }) => {
  let data = { ...initial(), unsent_access_changed: true, setup: { operation_id: 'f4cf359a-ae91-4974-a48b-90a1407c3e3b', revision: 3, status: 'held', attempted: false, calendar_id: null, issue: 'authorization_changed', chosen_time_zone: 'UTC' } } as ReturnType<typeof initial>;
  let discarded = 0;
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: data });
    if (route.request().method() === 'DELETE') {
      expect(route.request().postDataJSON()).toEqual({ operation_id: data.setup!.operation_id, expected_revision: 3 }); discarded++;
      data = initial(); return route.fulfill({ json: { discarded: true } });
    }
    return route.fulfill({ status: 400, json: { error: 'Choose a valid calendar timezone.' } });
  });
  await page.goto('/connections/google/' + id + '/publish');
  await expect(page.getByRole('button', { name: 'Create empty calendar', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Discard unsent setup', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard setup', exact: true }).click();
  await expect(page.getByLabel('Calendar timezone')).toBeVisible(); expect(discarded).toBe(1);
  await page.getByLabel('Calendar timezone').fill('Broken/Zone');
  await page.getByRole('button', { name: 'Review calendar setup', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save reviewed setup', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('valid calendar timezone');
  await expect(page.getByRole('button', { name: 'Retry setup save', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Calendar timezone')).toBeVisible();
});
