import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test('people and profile use neutral check-in timing with quick capture', async ({ page }) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  const h = await createCloudHarness();
  try {
    const ada = (await h.call('contacts', { method: 'POST', body: {
      name: 'Ada Lovelace', email: 'ada@example.com', contact_frequency: 14,
      tags: ['Friend'], custom_fields: { social: { website: 'https://example.com' } },
    } })).body.contact;
    const grace = (await h.call('contacts', { method: 'POST', body: { name: 'Grace Hopper', contact_frequency: 14 } })).body.contact;
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
    expect((await h.call('interactions', { method: 'POST', body: { contact_id: grace.id, date: eightDaysAgo, type: 'call', summary: 'Caught up about her travels' } })).status).toBe(201);

    await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    for (const pattern of ['**/api/contacts**', '**/api/interactions']) {
      await page.route(pattern, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const result = await h.call(`${url.pathname.slice('/api/'.length)}${url.search}`, {
          method: request.method(),
          body: request.postData() ? request.postDataJSON() : undefined,
          key: request.headers()['idempotency-key'] || null,
        });
        await route.fulfill({ status: result.status, json: result.body });
      });
    }

    await page.goto('/contacts');
    await expect(page.getByRole('heading', { name: 'Your people' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Search contacts' })).toBeVisible();
    await page.getByText('Manage', { exact: true }).click();
    await page.getByRole('button', { name: 'Grid', exact: true }).click();
    await expect(page.getByText('Not tracking yet')).toBeVisible();
    await expect(page.getByText('On your rhythm')).toBeVisible();
    await expect(page.getByText('Bulk actions')).toHaveCount(0);
    await expect(page.getByText('Health', { exact: true })).toHaveCount(0);
    await page.getByText('Manage', { exact: true }).click();
    await expect(page.getByRole('link', { name: 'Clean up duplicates' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Import reports' })).toBeVisible();
    await page.getByText('Manage', { exact: true }).click();
    const directoryAxe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(directoryAxe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('people-grid.png'), fullPage: true });

    await page.getByText('Manage', { exact: true }).click();
    await page.getByRole('button', { name: 'Select people' }).click();
    await expect(page.getByText('Bulk actions')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select Ada Lovelace' })).toBeVisible();
    await page.getByRole('button', { name: 'Done selecting' }).click();
    await expect(page.getByText('Bulk actions')).toHaveCount(0);
    await page.getByText('Manage', { exact: true }).click();
    await page.getByRole('button', { name: 'Compact list' }).click();
    await expect(page.getByText('Check-in rhythm', { exact: true })).toHaveCount(2);

    await page.goto(`/contacts/${ada.id}`);
    await expect(page.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible();
    await expect(page.getByText('Not tracking yet')).toBeVisible();
    await expect(page.getByText('100%')).toHaveCount(0);
    const mobile = test.info().project.name === 'chromium-mobile';
    if (mobile) {
      await expect(page.getByRole('navigation', { name: 'Profile sections' })).toBeVisible();
      await page.getByRole('button', { name: 'Activity', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'All activity' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Relationship brief' })).toBeHidden();
      await page.getByRole('navigation', { name: 'Activity filters' }).getByRole('button', { name: 'Conversations' }).click();
      await expect(page.getByRole('heading', { name: 'Conversations' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'All activity' })).toBeHidden();
      await page.getByRole('button', { name: 'Details', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Family & connections' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Profile details' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Website' })).toBeVisible();
      await expect(page.locator('#profile-details').getByText('Friend', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Overview', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Relationship brief' })).toBeHidden();
      await page.getByText('Conversation suggestions', { exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Relationship brief' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Email Ada Lovelace' })).toHaveAttribute('href', 'mailto:ada@example.com');
    }
    const quickLog = page.getByRole('button', { name: 'Log moment' });
    await expect(quickLog).toBeVisible();
    await page.locator('summary[aria-label="More contact actions"]').click();
    await expect(page.getByRole('link', { name: 'Edit profile' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete contact' })).toBeVisible();
    await page.locator('summary[aria-label="More contact actions"]').click();
    await page.screenshot({ path: test.info().outputPath('profile-header.png') });
    await quickLog.click();
    await expect(page.locator('#interaction-form')).toBeInViewport();
    if (mobile) await expect(quickLog).toBeInViewport();
    await page.getByLabel('Summary', { exact: true }).fill('Talked about a new project');
    await page.screenshot({ path: test.info().outputPath('profile-quick-log.png') });
    await page.locator('#interaction-form').getByRole('button', { name: 'Save' }).click();
    if (mobile) {
      await expect(page.getByRole('button', { name: 'Activity', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('heading', { name: 'Conversations' })).toBeVisible();
      await page.getByRole('button', { name: 'Overview', exact: true }).click();
    }
    await expect(page.getByText('Last in touch today')).toBeVisible();
    const history = await h.db.prepare('SELECT COUNT(*) AS count FROM interactions WHERE workspace_id = ? AND contact_id = ?').bind('test', ada.id).first<{ count: number }>();
    expect(history?.count).toBe(1);
    const profileAxe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(profileAxe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await h.close(); }
});
