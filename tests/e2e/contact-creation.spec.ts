import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test('contact creation stays quick and recovers an opt-in draft without duplicate saves', async ({ page }, testInfo) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  test.setTimeout(60_000);
  const h = await createCloudHarness();
  try {
    await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
    let mockUserId = 'test-user';
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: {
      session: { id: 'test-session', userId: mockUserId },
      user: { id: mockUserId, name: 'Test User', email: 'test@example.com' },
    } }));
    let loseFirstCreateResponse = true;
    for (const pattern of ['**/api/contacts**', '**/api/intelligence/overview*']) {
      await page.route(pattern, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const endpoint = `${url.pathname.slice('/api/'.length)}${url.search}`;
        const result = await h.call(endpoint, {
          method: request.method(),
          body: request.postData() ? request.postDataJSON() : undefined,
          key: request.headers()['idempotency-key'] || null,
        });
        if (endpoint === 'contacts' && request.method() === 'POST' && loseFirstCreateResponse) {
          loseFirstCreateResponse = false;
          await route.abort('failed');
          return;
        }
        await route.fulfill({ status: result.status, json: result.body });
      });
    }

    await page.goto('/contacts/new');
    await expect(page.getByRole('heading', { name: 'Add someone new' })).toBeVisible();
    await expect(page.getByLabel('Company')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add contact', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('quick-contact.png') });
    const mobile = testInfo.project.name === 'chromium-mobile';
    if (mobile) {
      const position = await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.trim() === 'Add contact');
        const bounds = button?.getBoundingClientRect();
        return bounds ? { top: bounds.top, bottom: bounds.bottom, viewport: innerHeight } : null;
      });
      expect(position).not.toBeNull();
      expect(position!.top).toBeGreaterThan(0);
      expect(position!.bottom).toBeLessThan(position!.viewport - 72);
    }

    await page.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
    await page.getByLabel('Email', { exact: true }).fill('ada@example.com');
    await page.getByLabel('A note to remember').fill('Ask about the next engine');
    await page.getByRole('checkbox', { name: /Keep a draft in this tab/ }).check();
    await page.getByRole('button', { name: 'Work & place' }).click();
    await page.getByLabel('Company').fill('Analytical Engines');
    await expect.poll(async () => page.evaluate(() => Object.entries(sessionStorage)
      .find(([key]) => key.startsWith('everclose:new-contact-draft:v2:'))?.[1] || null)).toContain('Ada Lovelace');
    const draftAxe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(draftAxe.violations).toEqual([]);

    mockUserId = 'another-user';
    page.once('dialog', (dialog) => dialog.accept());
    await page.reload();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('');
    mockUserId = 'test-user';
    await page.reload();
    await expect(page.getByText('Draft restored from this browser tab.')).toBeVisible();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Ada Lovelace');
    await expect(page.getByLabel('Company')).toHaveValue('Analytical Engines');
    await page.getByRole('link', { name: 'Cancel', exact: true }).click();
    const guard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await expect(guard.getByRole('button', { name: 'Keep draft and leave' })).toBeVisible();
    await guard.getByRole('button', { name: 'Keep draft and leave' }).click();
    await expect(page).toHaveURL(/\/contacts$/);
    await page.goto('/contacts/new');
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Ada Lovelace');
    await expect(page.getByLabel('Company')).toHaveValue('Analytical Engines');

    await page.getByRole('button', { name: 'Add contact', exact: true }).click();
    await expect(page.getByText(/could not confirm whether the contact was saved/i)).toBeVisible();
    await page.getByLabel('A note to remember').fill('This changed after the first save');
    await page.getByRole('button', { name: 'Add contact', exact: true }).click();
    await expect(page).toHaveURL(/\/contacts\/\d+$/);
    await expect(page.getByText(/earlier save was confirmed/i)).toBeVisible();
    const saved = await h.db.prepare('SELECT id, notes, custom_fields FROM contacts WHERE workspace_id = ? AND name = ?')
      .bind('test', 'Ada Lovelace').all<{ id: number; notes: string | null; custom_fields: string | null }>();
    expect(saved.results).toHaveLength(1);
    expect(saved.results[0].notes).toBe('Ask about the next engine');
    expect(JSON.parse(saved.results[0].custom_fields || '{}').company).toBe('Analytical Engines');
    expect(await page.evaluate(() => Object.keys(sessionStorage)
      .some((key) => key.startsWith('everclose:new-contact-draft:v2:')))).toBe(false);

    await page.goto('/contacts/new');
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('');
    await page.getByLabel('Name', { exact: true }).fill('Grace Hopper');
    await page.getByRole('button', { name: 'Add contact', exact: true }).click();
    await expect(page).toHaveURL(/\/contacts\/\d+$/);
    const count = await h.db.prepare('SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = ?')
      .bind('test').first<{ count: number }>();
    expect(count?.count).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await h.close(); }
});
