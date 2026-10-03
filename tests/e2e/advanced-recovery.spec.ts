import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const id = '7a9d9fbc-e4c0-4597-ae15-2df10dfb4955';
const now = '2026-10-02T20:00:00.000Z';

test('advanced recovery requires explicit confirmation and completes a resumable restore', async ({ page }) => {
  let state = 'ready';
  let background = 'idle';
  let polls = 0;
  const restore = () => ({ id, state, background, source: 'target', targetCaptureId: id,
    rollbackAvailable: true, tableIndex: 0, chunkIndex: 0, rowIndex: 0,
    createdAt: now, updatedAt: now });
  await page.route('**/api/settings/large-recovery', async (route) => {
    if (state === 'deleting' && ++polls >= 2) { state = 'completed'; background = 'complete'; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      enabled: true,
      captures: [{ id, state: 'manifest_ready', contactCount: 148, chunkCount: 19,
        createdAt: now, updatedAt: now }],
      restore: restore(),
    }) });
  });
  await page.route('**/api/settings/large-recovery/**', async (route) => {
    if (route.request().url().endsWith('/apply')) {
      expect(route.request().postDataJSON()).toEqual({ confirmation: 'RESTORE' });
      state = 'deleting';
      background = 'running';
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ restore: restore() }) });
      return;
    }
    await route.fulfill({ status: 404 });
  });

  await page.goto('/settings/advanced-recovery');
  await expect(page).toHaveURL(/\/login\?/);
  await page.getByLabel('Account password').fill('bonds-e2e-account-password');
  await page.getByRole('button', { name: 'Open my CRM' }).click();
  await page.goto('/settings/advanced-recovery');
  await expect(page).toHaveTitle('Advanced recovery | Everclose CRM');
  await expect(page.getByRole('heading', { name: 'Advanced recovery', level: 1 })).toBeVisible();
  await expect(page.getByText('148 contacts')).toBeVisible();
  await page.getByRole('button', { name: 'Apply verified snapshot' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Apply this snapshot?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start restore' })).toBeDisabled();
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(audit.violations).toEqual([]);
  await dialog.getByLabel('Type RESTORE to continue').fill('RESTORE');
  await dialog.getByRole('button', { name: 'Start restore' }).click();
  await expect(page.getByRole('heading', { name: 'Restore complete' })).toBeVisible();
  await expect(page.getByText('The selected snapshot was verified and restored.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
