import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test('people filters, pagination, and view survive profile navigation and browser history', async ({ page }) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  const h = await createCloudHarness();
  try {
    await h.db.batch(Array.from({ length: 52 }, (_, index) => h.db.prepare(
      'INSERT INTO contacts (workspace_id, name, tags) VALUES (?, ?, ?)'
    ).bind('test', `Person ${String(index + 1).padStart(3, '0')}`, JSON.stringify(index < 3 ? ['Friends', 'Family'] : ['Friends']))));

    await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    await page.route('**/api/contacts**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const result = await h.call(`${url.pathname.slice('/api/'.length)}${url.search}`, { method: request.method() });
      await route.fulfill({ status: result.status, json: result.body });
    });

    await page.goto('/contacts?search=Person&tag=Friends&view=list');
    await expect(page.getByRole('textbox', { name: 'Search contacts' })).toHaveValue('Person');
    await expect(page.getByRole('button', { name: 'Friends' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByText('Manage', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Compact list' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByText('Manage', { exact: true }).click();
    await expect(page.getByText('Page 1 of 2')).toBeVisible();

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/\/contacts\?.*page=2/u);
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await expect(page.getByText('Person 051')).toBeVisible();
    await page.getByRole('link', { name: 'Open' }).first().click();
    await expect(page.getByRole('heading', { name: 'Person 051' })).toBeVisible();
    await page.goBack();
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Search contacts' })).toHaveValue('Person');
    await page.getByText('Manage', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Compact list' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByText('Manage', { exact: true }).click();

    await page.getByRole('button', { name: 'Family' }).click();
    await expect(page).toHaveURL(/tag=Family/u);
    await expect(page).not.toHaveURL(/page=2/u);
    await expect(page.getByText('52 contacts · 3 matching')).toBeVisible();
    await page.goBack();
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Friends' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByText('Manage', { exact: true }).click();
    await page.getByRole('button', { name: 'Grid' }).click();
    await expect(page).toHaveURL(/view=grid/u);
    await page.goBack();
    await page.getByText('Manage', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Compact list' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByText('Manage', { exact: true }).click();

    await page.getByRole('textbox', { name: 'Search contacts' }).fill('Person 052');
    await expect(page).toHaveURL(/search=Person\+052/u);
    await expect(page).not.toHaveURL(/page=2/u);
    await expect(page.getByText('Person 052')).toBeVisible();
    await expect(page.getByText('Person 051')).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole('textbox', { name: 'Search contacts' })).toHaveValue('Person');
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await page.goForward();
    await expect(page.getByRole('textbox', { name: 'Search contacts' })).toHaveValue('Person 052');
    await expect(page.getByText('Person 052')).toBeVisible();
    await page.getByRole('link', { name: 'Open' }).first().click();
    await expect(page.getByRole('heading', { name: 'Person 052' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('textbox', { name: 'Search contacts' })).toHaveValue('Person 052');
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.goto('/contacts?tag=Family&page=99&view=list');
    await expect(page.getByText('52 contacts · 3 matching')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Family' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page).not.toHaveURL(/page=99/u);
  } finally { await h.close(); }
});
