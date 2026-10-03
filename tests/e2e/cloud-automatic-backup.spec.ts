import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test('cloud recovery shows honest scheduled-backup coverage and failures', async ({ page }) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  const h = await createCloudHarness();
  try {
    h.emailEnv.CLOUD_AUTOMATIC_BACKUP_ENABLED = 'true';
    await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    await page.route('**/api/settings/backups**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const result = await h.call(`${url.pathname.slice('/api/'.length)}${url.search}`, { method: request.method() });
      await route.fulfill({ status: result.status, json: result.body });
    });

    await page.goto('/settings');
    await expect(page.getByText('Automatic protection needs attention')).toBeVisible();
    await expect(page.getByText(/No automatic recovery point has been verified yet/)).toBeVisible();

    expect((await h.runAutomaticBackups(new Date())).created).toBe(2);
    await page.reload();
    await expect(page.getByText('Automatic protection is active')).toBeVisible();
    await expect(page.getByText(/latest verified automatic snapshot/i)).toBeVisible();

    const filename = (await h.call('settings/backups')).body.backups[0].filename;
    await h.assets.delete(`test/backups/${filename}`);
    await page.reload();
    await expect(page.getByText(/latest scheduled snapshot is missing/)).toBeVisible();

    await h.db.prepare(`UPDATE cloud_backup_schedules SET last_failure_code = 'too_large'
      WHERE workspace_id = 'test'`).run();
    await page.reload();
    await expect(page.getByText(/New scheduled snapshots cannot be created yet/)).toBeVisible();

    h.emailEnv.CLOUD_AUTOMATIC_BACKUP_ENABLED = 'false';
    await page.reload();
    await expect(page.getByText('Automatic backups are off')).toBeVisible();
    await expect(page.getByText(/Scheduled cloud backups are not enabled yet/)).toBeVisible();
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await h.close(); }
});
