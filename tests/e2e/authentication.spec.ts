import { expect, test, type Page } from '@playwright/test';

const accountPassword = 'bonds-e2e-account-password';
const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) || []).toEqual([
    'console: Failed to load resource: the server responded with a status of 401 (Unauthorized)',
    'console: Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
  ]);
});

async function getSignOutButton(page: Page) {
  const button = page.getByRole('button', { name: 'Sign out', exact: true });
  if ((page.viewportSize()?.width || 0) < 640 && !await button.isVisible()) {
    await page.getByRole('button', { name: 'More navigation' }).click();
  }
  await expect(button).toBeVisible();
  return button;
}

test('a mistyped password and failed logout remain safely retryable', async ({ page }) => {
  await page.goto('/contacts');
  await expect(page).toHaveURL((url) =>
    url.pathname === '/login' && url.searchParams.get('next') === '/contacts'
  );
  await expect(page).toHaveTitle('Sign in | Everclose CRM');

  const password = page.getByLabel('Account password');
  await password.fill('incorrect account password');
  await page.getByRole('button', { name: 'Open my CRM' }).click();
  await expect(page.getByRole('alert').getByText('Invalid password.')).toBeVisible();
  await expect(password).toHaveValue('');

  await password.fill(accountPassword);
  await page.getByRole('button', { name: 'Open my CRM' }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/contacts');
  await expect(page).toHaveTitle('Contacts | Everclose CRM');
  await expect(page.getByRole('heading', { name: 'Your people', level: 1 })).toBeVisible();

  await page.route('**/api/auth/logout', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Temporary sign-out failure.' }),
    });
  });
  await (await getSignOutButton(page)).click();
  await expect(page.getByRole('alert').getByText(/session is still active/i)).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === '/contacts');

  await page.unroute('**/api/auth/logout');
  await (await getSignOutButton(page)).click();
  await expect(page).toHaveURL((url) => url.pathname === '/login');
  await expect(page).toHaveTitle('Sign in | Everclose CRM');

  await page.goto('/contacts');
  await expect(page).toHaveURL((url) =>
    url.pathname === '/login' && url.searchParams.get('next') === '/contacts'
  );
});
