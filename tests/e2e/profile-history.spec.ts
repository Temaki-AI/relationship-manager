import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test('profile activity filters source history and edits an older conversation', async ({ page }) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Morgan Ellis' } })).body.contact;
    await h.db.prepare(`INSERT INTO interactions (workspace_id, contact_id, date, type, summary)
      SELECT 'test', ?, '2026-08-01', 'call', 'Moment ' || value FROM json_each(?)`)
      .bind(contact.id, JSON.stringify(Array.from({ length: 40 }, (_, index) => index))).run();
    await h.call('reminders', { method: 'POST', body: {
      contact_id: contact.id, title: 'Send a postcard', remind_at: '2026-10-12T10:00:00Z',
    } });

    await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    for (const pattern of ['**/api/contacts**', '**/api/interactions**']) {
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

    await page.goto(`/contacts/${contact.id}`);
    if (test.info().project.name === 'chromium-mobile') {
      await page.getByRole('navigation', { name: 'Profile sections' }).getByRole('button', { name: 'Activity' }).click();
    }
    const filters = page.getByRole('navigation', { name: 'Activity filters' });
    await expect(filters).toBeVisible();
    await expect(page.getByRole('heading', { name: 'All activity' })).toBeVisible();
    await filters.getByRole('button', { name: 'Reminders' }).click();
    await expect(page.getByRole('heading', { name: /^Reminders\b/ })).toBeVisible();
    await expect(page.getByText('Reminder scheduled')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit interaction: Moment 39' })).toBeHidden();
    await filters.getByRole('button', { name: 'All activity' }).click();
    await expect(page.getByRole('heading', { name: 'All activity' })).toBeVisible();

    await page.getByRole('button', { name: 'Load older activity' }).click();
    await expect(page.getByRole('button', { name: 'Edit interaction: Moment 0' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit interaction: Moment 0' }).click();
    await expect(filters.getByRole('button', { name: 'Conversations' })).toHaveAttribute('aria-pressed', 'true');
    const editForm = page.locator('form[id^="interaction-edit-"]');
    await expect(editForm).toBeVisible();
    await expect(editForm.getByLabel('Summary')).toHaveValue('Moment 0');
    await editForm.getByLabel('Summary').fill('Old memory, corrected');
    await editForm.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Old memory, corrected')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'All activity' })).toBeHidden();
    if (test.info().project.name === 'chromium-desktop') {
      const conversationBox = await page.getByRole('heading', { name: /^Conversations\b/ }).boundingBox();
      const plansBox = await page.getByRole('heading', { name: /^Plans\b/ }).boundingBox();
      expect(conversationBox && plansBox && conversationBox.y < plansBox.y).toBe(true);
    }
    const updated = await h.db.prepare('SELECT summary FROM interactions WHERE workspace_id = ? AND contact_id = ? AND summary = ?')
      .bind('test', contact.id, 'Old memory, corrected').first<{ summary: string }>();
    expect(updated?.summary).toBe('Old memory, corrected');

    await page.evaluate(() => window.scrollTo(0, 0));
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('profile-history.png'), fullPage: true });
  } finally {
    await h.close();
  }
});
