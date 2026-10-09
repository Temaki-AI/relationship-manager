import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const id = '0c9b942a-7f07-470a-b495-a2158dbfca25', epoch = '1c9b942a-7f07-470a-b495-a2158dbfca25';
test('Google address book review preserves the last complete download through retries and supports mobile search and paging', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  const account = { id, email: 'personal.relationship.address.with.a.long.name@example.test', status: 'connected', authorization_revision: 1 };
  await page.route('**/api/connections', (route) => route.fulfill({ json: { mode: 'cloud', configured: true, epoch, connections: [account] } }));
  const base = { sourceId: 'a', resourceName: 'people/a', etag: 'version-1', name: 'Ana Santos', company: 'Company', title: 'Engineer', location: 'Lisbon, Portugal',
    emails: [{ value: 'ana.santos.with.a.long.address@relationships.example.test', label: 'work', primary: true, canonical: null }], phones: [{ value: '+351 912 345 678', label: 'mobile', primary: true, canonical: '+351912345678' }] };
  let status = 'complete', issue: string | null = null, steps = 0, starts = 0, generation = 'complete-1', requests = 0;
  await page.route('**/api/connections/' + id + '/contacts?*', async (route) => {
    requests++; const query = new URL(route.request().url()).searchParams;
    const second = Boolean(query.get('after')), search = query.get('q') || '';
    const items = second ? [{ ...base, sourceId: 'b', resourceName: 'people/b', name: 'Beatriz Costa' }] : search && !base.name.toLowerCase().includes(search.toLowerCase()) ? [] : [base];
    await route.fulfill({ json: { generation, last_synced_at: '2026-10-03T10:00:00Z', count: 51, items,
      next_after: second || search ? null : 'a', run: { id: 'run-1', status, processed: 50, issue, retry_at: 0 }, import_available: false, automatic_sync: false } });
  });
  await page.route('**/api/connections/' + id + '/contacts', async (route) => {
    starts++; expect(route.request().method()).toBe('POST'); const input = route.request().postDataJSON();
    expect(input.expected_epoch).toBe(epoch); expect(input.expected_authorization_revision).toBe(1); expect(input.operation_id).toMatch(/^[0-9a-f-]{36}$/);
    status = 'active'; issue = 'retry'; await route.fulfill({ json: { id: 'run-1', status, phase: 'fetch', processed: 50 } });
  });
  await page.route('**/api/connections/' + id + '/contacts/step', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ run_id: 'run-1' }); steps++; status = 'complete'; issue = null; generation = 'complete-2';
    await route.fulfill({ json: { status, advanced: true } });
  });
  await page.goto('/connections/google/' + id + '/contacts');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Review Google Contacts');
  await expect(page.getByRole('heading', { name: 'Ana Santos' })).toBeVisible();
  await expect(page.getByRole('main').getByText(/Review each contact to create a person/)).toBeVisible();
  await page.getByRole('button', { name: 'Refresh address book' }).click();
  await expect(page.getByRole('status')).toContainText('temporarily unavailable');
  await expect(page.getByRole('heading', { name: 'Ana Santos' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next contacts' })).toBeDisabled();
  await page.getByRole('button', { name: 'Continue download' }).click();
  await expect(page.getByRole('status')).toContainText('Address book and linked sources updated.');
  await page.getByRole('button', { name: 'Next contacts' }).click();
  await expect(page.getByRole('heading', { name: 'Beatriz Costa' })).toBeVisible();
  await page.getByRole('button', { name: 'First page' }).click();
  await expect(page.getByRole('heading', { name: 'Ana Santos' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search name, email or phone' }).fill('no match');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('main').getByText('No matching Google contacts in this download.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search name, email or phone' }).fill('Ana'); await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ana Santos' })).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze(); expect(axe.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('google-contact-review.png'), fullPage: true });
  expect(starts).toBe(1); expect(steps).toBe(1); expect(requests).toBeGreaterThan(3); expect(errors).toEqual([]);
});

test('an uncertain download acknowledgement is recovered by its receipt and lost permissions clear the provider preview', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  let accountStatus = 'connected', runStatus = 'complete', runId = 'previous-run';
  const operations: string[] = [];
  await page.route('**/api/connections', (route) => route.fulfill({ json: { mode: 'cloud', configured: true, epoch,
    connections: [{ id, email: 'owner@example.test', status: accountStatus, authorization_revision: 1 }] } }));
  await page.route('**/api/connections/' + id + '/contacts?*', (route) => accountStatus === 'connected' ? route.fulfill({ json: { generation: 'complete-preview', count: 1,
    last_synced_at: '2026-10-03T10:00:00Z', items: [{ sourceId: 'a', name: 'Ana Santos', emails: [], phones: [], company: null, title: null, location: null }], next_after: null,
    run: { id: runId, status: runStatus, processed: 1, issue: null, retry_at: 0 } } }) : route.fulfill({ status: 409, json: { error: 'Reconnect this account before reviewing Google Contacts.' } }));
  await page.route('**/api/connections/' + id + '/contacts', async (route) => {
    const operation = route.request().postDataJSON().operation_id; operations.push(operation); runId = operation; runStatus = 'active';
    await route.fulfill(operations.length === 1 ? { status: 503, json: { error: 'The queue acknowledgement was lost. Try again.' } } : { json: { id: runId, status: runStatus } });
  });
  await page.route('**/api/connections/' + id + '/contacts/step', async (route) => {
    expect(route.request().postDataJSON().run_id).toBe(runId); runStatus = 'complete'; await route.fulfill({ json: { status: runStatus, advanced: true } });
  });
  await page.goto('/connections/google/' + id + '/contacts');
  await expect(page.getByRole('heading', { name: 'Ana Santos' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh address book' }).click(); await expect(page.getByRole('main').getByRole('alert')).toContainText('acknowledgement was lost');
  await page.getByRole('button', { name: 'Reload review' }).click(); await expect(page.getByRole('button', { name: 'Continue download' })).toBeVisible();
  expect(operations).toHaveLength(1);
  await page.getByRole('button', { name: 'Continue download' }).click(); await expect(page.getByRole('status')).toContainText('Address book and linked sources updated.');
  await page.getByRole('button', { name: 'Refresh address book' }).click(); await expect(page.getByRole('button', { name: 'Continue download' })).toBeVisible();
  expect(operations).toHaveLength(2); expect(operations[1]).not.toBe(operations[0]);
  accountStatus = 'reconnect_required';
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Reconnect this account', { timeout: 10_000 });
  await expect(page.getByRole('heading', { name: 'Ana Santos' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh address book' })).toHaveCount(0);
});
