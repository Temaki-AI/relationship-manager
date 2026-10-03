import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test('cloud export page prepares, exposes download, and removes a complete contact file', async ({ page }) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  const h = await createCloudHarness();
  try {
    await h.db.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 27)
      INSERT INTO contacts(workspace_id, name) SELECT 'test', printf('Person %02d', n) FROM numbers`).run();
    await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    await page.context().route('**/api/export/**', async (route) => {
      const req = route.request();
      const endpoint = new URL(req.url()).pathname.slice('/api/'.length);
      const result = await h.call(endpoint, {
        method: req.method(), body: req.postData() ? req.postDataJSON() : undefined,
        key: req.headers()['idempotency-key'] || null,
      });
      if (result.headers.get('content-type')?.includes('application/json')) {
        await route.fulfill({ status: result.status, json: result.body });
      } else {
        await route.fulfill({ status: result.status, body: Buffer.from(result.body),
          contentType: result.headers.get('content-type') || 'application/octet-stream',
          headers: { 'content-disposition': result.headers.get('content-disposition') || '' } });
      }
    });
    await page.goto('/contacts/exports');
    await expect(page.getByRole('heading', { name: 'Contact exports' })).toBeVisible();
    await page.getByRole('button', { name: 'Prepare CSV' }).click();
    await expect(page.getByText('Ready to download')).toBeVisible();
    const job = (await h.call('export/jobs')).body.jobs[0];
    const direct = await h.call(`export/jobs/${job.id}/download`);
    expect(direct.status).toBe(200);
    expect(direct.headers.get('content-disposition')).toMatch(/^attachment; filename="everclose-contacts-/);
    await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `/api/export/jobs/${job.id}/download`);
    expect(direct.headers.get('content-type')).toMatch(/text\/csv/);
    expect(Buffer.from(direct.body).toString('utf8')).toContain('Person 27');
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('contact-exports.png'), fullPage: true });
    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('heading', { name: 'No exports yet' })).toBeVisible();
    const result = await h.call('export/jobs');
    expect(result.body.jobs).toHaveLength(0);
  } finally { await h.close(); }
});
