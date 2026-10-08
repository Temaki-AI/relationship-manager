import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test('email reminder settings show honest availability and save a verified opt-in', async ({ page }) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  const h = await createCloudHarness();
  try {
    await h.db.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES ('user-1', 'Owner', 'owner@example.com', 1, 1, 1)`).run();
    await h.db.prepare("INSERT INTO workspace_members (workspace_id, user_id) VALUES ('test', 'user-1')").run();
    await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    await page.route('**/api/reminders/email-preferences', async (route) => {
      const request = route.request();
      const response = await h.emailSettings(new Request(request.url(), {
        method: request.method(),
        headers: { 'Content-Type': 'application/json' },
        body: request.postData() || undefined,
      }));
      await route.fulfill({ status: response.status, json: await response.json() });
    });
    await page.route('**/api/reminders?page=*', async (route) => {
      const response = await h.call(`reminders${new URL(route.request().url()).search}`);
      await route.fulfill({ status: response.status, json: response.body });
    });

    await page.goto('/reminders');
    await expect(page.getByRole('heading', { name: 'Email alerts' })).toBeVisible();
    await expect(page.getByText('Email delivery is not set up yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enable email' })).toHaveCount(0);
    h.emailEnv.EMAIL_DELIVERY_ENABLED = 'true';
    h.emailEnv.EMAIL = { send: async () => ({ messageId: 'fake' }) };
    await page.reload();
    await page.getByRole('textbox', { name: 'Time zone' }).fill('Europe/Lisbon');
    await page.getByRole('button', { name: 'Enable email' }).click();
    await expect(page.getByText(/Email alerts are on for due reminders and contact or child birthdays\./)).toBeVisible();
    const saved = await h.db.prepare("SELECT enabled, time_zone FROM reminder_email_preferences WHERE workspace_id = 'test' AND user_id = 'user-1'")
      .first<{ enabled: number; time_zone: string }>();
    expect(saved).toMatchObject({ enabled: 1, time_zone: 'Europe/Lisbon' });
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Turn off email' }).click();
    await expect(page.getByRole('button', { name: 'Enable email' })).toBeVisible();
  } finally { await h.close(); }
});
