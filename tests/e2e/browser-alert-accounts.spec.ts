import { expect, test } from '@playwright/test';

test('browser alerts never inherit another cloud account preference or ledger', async ({ page }) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  let userId = 'alert-user-a';
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  await page.addInitScript(() => {
    localStorage.setItem('bonds-reminder-notifications-enabled', 'true');
    localStorage.setItem('bonds-reminder-notification-ledger-v1', '["19@2026-01-01T00:00:00.000Z"]');
    const alerts: string[] = [];
    (window as unknown as { __alerts: string[] }).__alerts = alerts;
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: (() => void) | null = null;
      constructor(_title: string, options: { body?: string }) { alerts.push(options.body || ''); }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification });
  });
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: {
    session: { id: 'test-session', userId },
    user: { id: userId, name: 'Test User', email: `${userId}@example.com` },
  } }));
  await page.route('**/api/reminders/email-preferences', (route) => route.fulfill({ json: {
    available: false, verifiedEmail: true, enabled: false, timeZone: 'UTC',
    quietStartHour: 22, quietEndHour: 8, failedCount: 0, lastSentAt: null,
  } }));
  await page.route('**/api/reminders?*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('view') === 'notifications') {
      return route.fulfill({ json: { reminders: [{ id: 19, remind_at: dueAt }], birthdays: [] } });
    }
    return route.fulfill({ json: { reminders: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 } } });
  });

  await page.goto('/reminders');
  await expect(page.getByRole('button', { name: 'Enable browser alerts' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __alerts: string[] }).__alerts.length)).toBe(0);
  await page.getByRole('button', { name: 'Enable browser alerts' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __alerts: string[] }).__alerts.length)).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('bonds-reminder-notifications-enabled:google%3Aalert-user-a'))).toBe('true');

  userId = 'alert-user-b';
  await page.reload();
  await expect(page.getByRole('button', { name: 'Enable browser alerts' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __alerts: string[] }).__alerts.length)).toBe(0);
  await page.getByRole('button', { name: 'Enable browser alerts' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __alerts: string[] }).__alerts.length)).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('bonds-reminder-notifications-enabled:google%3Aalert-user-b'))).toBe('true');

  userId = 'alert-user-a';
  await page.reload();
  await expect(page.getByRole('button', { name: 'Turn off alerts' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __alerts: string[] }).__alerts.length)).toBe(0);
});
