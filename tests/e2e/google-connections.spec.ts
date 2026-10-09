import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const id = '0c9b942a-7f07-470a-b495-a2158dbfca25';
const epoch = '1c9b942a-7f07-470a-b495-a2158dbfca25';
test('Google connection permissions and pending revocation are explicit on desktop and mobile', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  let status = 'connected', revision = 1, stops = 0;
  await page.route('**/api/connections', (route) => route.fulfill({ json: { mode: 'cloud', configured: true, epoch, automatic_sync: false,
    connections: [{ id, email: 'personal.relationship.address.with.a.long.name@example.test', display_name: 'Personal Google account', status, revision }] } }));
  await page.route('**/api/connections/' + id, async (route) => {
    expect(route.request().method()).toBe('DELETE'); expect(route.request().postDataJSON().expected_revision).toBe(revision);
    stops++; revision++; status = stops === 1 ? 'revocation_pending' : 'disconnected';
    await route.fulfill({ json: { disconnected: true, revocation_pending: status === 'revocation_pending' } });
  });
  await page.goto('/connections/google');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Google Contacts connections');
  await expect(page.getByRole('main').getByText(/Requested access: read-only Google Contacts/)).toBeVisible();
  await expect(page.getByRole('main').getByText(/Import selected people and enable updates explicitly/)).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Disconnect Google Contacts?' });
  await expect(dialog).toContainText('private notes and history stay');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(stops).toBe(0);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await dialog.getByRole('button', { name: 'Disconnect account', exact: true }).click();
  await expect(page.getByRole('article')).toContainText('Google revocation pending');
  await expect(page.getByRole('article').getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze(); expect(axe.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('google-revocation.png') });
  await page.getByRole('button', { name: 'Retry Google revocation', exact: true }).click();
  await expect(page.getByRole('article')).toContainText('Disconnected');
  await expect(page.getByRole('status')).toContainText('people, notes and history were kept'); expect(stops).toBe(2);
  expect(errors).toEqual([]);
});

test('authorization requires an enabled server and opens the separate Google consent URL', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  let configured = false, began = false;
  await page.route('**/api/connections', (route) => route.fulfill({ json: { mode: 'cloud', configured, epoch, connections: [] } }));
  await page.route('**/api/connections/google/authorize', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ purpose: 'contacts', expected_epoch: epoch }); began = true;
    await route.fulfill({ json: { authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=test-only-consent' } });
  });
  await page.route('https://accounts.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<html><body>Test Google consent page</body></html>' }));
  await page.goto('/connections/google');
  await expect(page.getByRole('button', { name: 'Connect a Google account', exact: true })).toBeDisabled();
  configured = true; await page.reload();
  await page.getByRole('button', { name: 'Connect a Google account', exact: true }).click();
  await expect(page).toHaveURL('https://accounts.google.com/o/oauth2/v2/auth?state=test-only-consent'); expect(began).toBe(true);
});
