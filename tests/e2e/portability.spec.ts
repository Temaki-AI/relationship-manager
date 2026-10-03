import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const accountPassword = 'bonds-e2e-account-password';
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
  await page.goto('/contacts');
  await expect(page).toHaveURL((url) =>
    url.pathname === '/login' && url.searchParams.get('next') === '/contacts'
  );
  await page.getByLabel('Account password').fill(accountPassword);
  await page.getByRole('button', { name: 'Open my CRM' }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/contacts');
  await expect(page.getByRole('heading', { name: 'Your people', level: 1 })).toBeVisible();
}

test('CSV and vCard transfers round-trip through the consumer UI', async ({ page }, testInfo) => {
  testInfo.setTimeout(60_000);
  await signIn(page);
  const suffix = testInfo.project.name.endsWith('mobile') ? 'Mobile' : 'Desktop';
  const importedName = `Portability Ada ${suffix}`;
  const importedEmail = `portability-${suffix.toLowerCase()}@example.test`;
  const importedPhone = suffix === 'Mobile' ? '+1 555 900 1002' : '+1 555 900 1001';
  const csvImportedName = `Portability Grace ${suffix}`;
  const csvImportedEmail = `portability-grace-${suffix.toLowerCase()}@example.test`;
  const csvImportedPhone = suffix === 'Mobile' ? '+1 555 900 2002' : '+1 555 900 2001';
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${importedName}`,
    `EMAIL;TYPE=INTERNET:${importedEmail}`,
    `TEL;TYPE=CELL:${importedPhone}`,
    'NOTE:Imported through the responsive release gate.',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Sarah Existing',
    'EMAIL:sarah@example.com',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'EMAIL:missing-name@example.test',
    'END:VCARD',
  ].join('\r\n');
  const importFile = {
    name: `bonds-portability-${suffix.toLowerCase()}.vcf`,
    mimeType: 'text/vcard',
    buffer: Buffer.from(vcard),
  };
  const csvFile = {
    name: `bonds-portability-${suffix.toLowerCase()}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from([
      'Name,Email,Phone,Tags,Notes',
      `${csvImportedName},${csvImportedEmail},${csvImportedPhone},imported,Imported through the CSV release gate.`,
      'Sarah Existing,sarah@example.com,,,',
      ',missing-name-csv@example.test,,,',
    ].join('\n')),
  };

  await page.getByRole('button', { name: 'Transfer contacts' }).click();
  await expect(page.getByText(/only to this Everclose CRM installation/i)).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.locator('#vcard-import').setInputFiles(importFile);
  await expect(page.getByRole('status').getByText(
    '1 imported, 1 duplicate skipped, 1 invalid skipped',
    { exact: true }
  )).toBeVisible();
  await expect(page.getByText('Bring your people with you')).toHaveCount(0);

  await page.getByRole('textbox', { name: 'Search contacts' }).fill(importedName);
  await expect(page.getByText('1 matching contact', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(importedName) })).toBeVisible();

  await page.getByRole('button', { name: 'Transfer contacts' }).click();
  await page.locator('#vcard-import').setInputFiles(importFile);
  await expect(page.getByRole('status').getByText(
    '0 imported, 2 duplicates skipped, 1 invalid skipped',
    { exact: true }
  )).toBeVisible();

  await page.locator('#csv-import').setInputFiles(csvFile);
  await expect(page.getByRole('status').getByText(
    '1 imported, 1 duplicate skipped, 1 invalid skipped',
    { exact: true }
  )).toBeVisible();
  await page.getByRole('textbox', { name: 'Search contacts' }).fill(csvImportedName);
  await expect(page.getByText('1 matching contact', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(csvImportedName) })).toBeVisible();

  await page.getByRole('button', { name: 'Transfer contacts' }).click();

  const csvDownloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'CSV', exact: true }).click();
  const csvDownload = await csvDownloadPromise;
  expect(csvDownload.suggestedFilename()).toMatch(/^bonds-contacts-\d{4}-\d{2}-\d{2}\.csv$/);
  const csvPath = await csvDownload.path();
  if (!csvPath) throw new Error('Playwright did not retain the CSV export.');
  const csv = await readFile(csvPath, 'utf8');
  expect(csv).toContain('Name,Email,Phone');
  expect(csv).toContain(importedName);
  expect(csv).toContain(importedEmail);
  expect(csv).toContain(csvImportedName);
  expect(csv).toContain(csvImportedEmail);

  const vcardDownloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'vCard', exact: true }).click();
  const vcardDownload = await vcardDownloadPromise;
  expect(vcardDownload.suggestedFilename()).toMatch(/^bonds-contacts-\d{4}-\d{2}-\d{2}\.vcf$/);
  const vcardPath = await vcardDownload.path();
  if (!vcardPath) throw new Error('Playwright did not retain the vCard export.');
  const exportedVcard = await readFile(vcardPath, 'utf8');
  expect(exportedVcard).toContain('BEGIN:VCARD');
  expect(exportedVcard).toContain(`FN:${importedName}`);
  expect(exportedVcard).toContain(`EMAIL;TYPE=INTERNET:${importedEmail}`);
  expect(exportedVcard).toContain(`FN:${csvImportedName}`);
  expect(exportedVcard).toContain(`EMAIL;TYPE=INTERNET:${csvImportedEmail}`);
});
