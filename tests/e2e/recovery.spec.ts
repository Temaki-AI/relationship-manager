import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const accountPassword = 'bonds-e2e-account-password';
const backupPassphrase = 'isolated e2e portable backup phrase';
const browserErrors = new WeakMap<Page, string[]>();
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) || []).toEqual([]);
});

async function signIn(page: Page) {
  await page.goto('/settings');
  await expect(page).toHaveURL((url) =>
    url.pathname === '/login' && url.searchParams.get('next') === '/settings'
  );
  await page.getByLabel('Account password').fill(accountPassword);
  await page.getByRole('button', { name: 'Open my CRM' }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
}

test('an encrypted workspace backup restores the earlier consumer state', async ({ page }, testInfo) => {
  testInfo.setTimeout(60_000);
  await signIn(page);

  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByRole('status').getByText('Database backup created')).toBeVisible();
  await page.getByText('Download an encrypted backup', { exact: true }).click();
  await page.getByLabel('Backup passphrase').fill(backupPassphrase);
  await page.getByLabel('Confirm passphrase').fill(backupPassphrase);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download latest encrypted' }).click();
  const download = await downloadPromise;
  const downloadFilename = download.suggestedFilename();
  expect(downloadFilename).toMatch(/\.bonds$/);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('Playwright did not retain the encrypted backup download.');
  const encryptedBackup = {
    name: downloadFilename,
    mimeType: 'application/vnd.bonds.backup',
    buffer: await readFile(downloadPath),
  };
  await expect(page.getByRole('status').getByText(/Encrypted backup ready/)).toBeVisible();

  const suffix = testInfo.project.name.endsWith('mobile') ? 'Mobile' : 'Desktop';
  const probeName = `Recovery Probe ${suffix}`;
  await page.goto('/contacts/new');
  await page.getByLabel('Name').fill(probeName);
  await page.getByLabel('Email').fill(`recovery-probe-${suffix.toLowerCase()}@example.test`);
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  await expect(page.getByRole('heading', { name: probeName, level: 1 })).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page).toHaveTitle('Data & recovery | Everclose CRM');
  await page.getByText('Restore a backup', { exact: true }).click();
  await page.getByLabel('Backup file to restore').setInputFiles(encryptedBackup);
  await page.getByLabel('Encrypted backup passphrase').fill('incorrect but long backup phrase');
  await page.getByLabel('Restore safety confirmation').fill('RESTORE');
  await page.getByRole('button', { name: 'Restore selected file' }).click();

  const dialog = page.getByRole('alertdialog', { name: 'Restore the selected file?' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveTitle('Data & recovery | Everclose CRM');
  const accessibility = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(accessibility.violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Restore database' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alert').getByText(/passphrase is incorrect/i)).toBeVisible();
  const probeCountAfterRejectedRestore = await page.evaluate(async (name) => {
    const response = await fetch(`/api/contacts?search=${encodeURIComponent(name)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Contact verification failed with ${response.status}`);
    const result = await response.json() as { pagination?: { total?: number } };
    return Number(result.pagination?.total) || 0;
  }, probeName);
  expect(probeCountAfterRejectedRestore).toBe(1);

  await page.getByLabel('Encrypted backup passphrase').fill(backupPassphrase);
  await page.getByRole('button', { name: 'Restore selected file' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Restore database' }).click();
  await expect(page.getByRole('status').getByText(/Database file restored/)).toBeVisible();

  await page.goto('/contacts');
  await page.getByRole('textbox', { name: 'Search contacts' }).fill(probeName);
  await expect(page.getByText('0 matching contacts', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No matches' })).toBeVisible();
});
