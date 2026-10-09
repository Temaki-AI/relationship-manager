import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function signIn(page: Page) {
  await page.goto('/contacts');
  await page.getByLabel('Account password').fill('bonds-e2e-account-password');
  await page.getByRole('button', { name: 'Open my CRM' }).click();
  await expect(page.getByRole('heading', { name: 'Your people', level: 1 })).toBeVisible();
}

test('primary screens keep navigation and content usable at narrow and desktop sizes', async ({ page }, testInfo) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI === 'true', 'Uses an isolated local workspace. Cloud task flows have separate fixtures.');
  test.setTimeout(150_000);
  await signIn(page);
  const person = await page.getByRole('link', { name: 'Open', exact: true }).first().getAttribute('href');
  expect(person).toMatch(/^\/contacts\/\d+$/);
  const screens: Array<[string, string]> = [
    ['/', 'today'], ['/contacts', 'people'], [person!, 'profile'], ['/calendar', 'calendar'],
    ['/reminders', 'reminders'], ['/groups', 'groups'], ['/smart-lists', 'smart-lists'],
    ['/settings', 'settings'], ['/integrations', 'connections'], ['/contacts/new', 'new-person'],
    ['/contacts/duplicates', 'duplicates'], [`${person}/edit`, 'edit-person'],
    ['/design-system', 'design-system'],
  ];
  const widths = testInfo.project.name.endsWith('mobile') ? [393, 320] : [1280, 768];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 850 });
    for (const [route, name] of screens) {
      await page.goto(route);
      await expect(page.locator('main h1')).toBeVisible();
      await expect(page.locator('.skeleton').first()).toBeHidden();
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveTitle(/Everclose/);
      const mainNav = page.getByRole('navigation', { name: 'Main navigation', exact: true }).filter({ visible: true });
      const labels = await mainNav.getByRole('link').allTextContents();
      expect(labels.map((label) => label.trim())).toEqual(['Today', 'People', 'Calendar', 'Settings']);
      for (const link of await mainNav.getByRole('link').all()) {
        const box = await link.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflows at ${width}px`).toBe(true);
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(audit.violations, `${name} accessibility at ${width}px`).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`), fullPage: true });
    }
  }
});

test('secondary tools are discoverable without obscuring the daily tasks', async ({ page }) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI === 'true', 'Uses the isolated local workspace.');
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Grid', exact: true })).toBeHidden();
  await page.getByText('Manage', { exact: true }).click();
  await page.getByRole('button', { name: 'Grid', exact: true }).click();
  await expect(page).toHaveURL(/view=grid/);
  await expect(page.getByRole('button', { name: 'Grid', exact: true })).toBeHidden();
  await page.getByText('Manage', { exact: true }).click();
  await page.getByRole('button', { name: 'Compact list', exact: true }).click();
  await expect(page).toHaveURL(/view=list/);
  await page.getByText('Manage', { exact: true }).click();
  await page.getByRole('button', { name: 'Transfer contacts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bring your people with you' })).toBeVisible();
  await page.getByRole('button', { name: 'Close import tools' }).click();
  await expect(page.getByRole('heading', { name: 'Bring your people with you' })).toBeHidden();
  await page.goto('/contacts?import=1&view=list');
  await expect(page.getByRole('heading', { name: 'Bring your people with you' })).toBeVisible();
  await expect(page).not.toHaveURL(/import=1/);
  await expect(page).toHaveURL(/view=list/);
  await page.getByRole('button', { name: 'Close import tools' }).click();
  await expect(page.getByRole('heading', { name: 'Bring your people with you' })).toBeHidden();
  await page.getByText('Manage', { exact: true }).click();
  await page.getByRole('button', { name: 'Select people', exact: true }).click();
  await page.getByRole('button', { name: 'Done selecting' }).click();
  await expect(page.getByRole('button', { name: 'Done selecting' })).toBeHidden();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Next up' })).toBeVisible();
  await expect(page.getByText('Open reminders', { exact: true })).toBeHidden();
  await page.getByText('Relationship overview', { exact: true }).click();
  await expect(page.getByText('Open reminders', { exact: true })).toBeVisible();
  await page.goto('/settings');
  await expect(page.getByLabel('Backup passphrase', { exact: true })).toBeHidden();
  await page.getByText('Download an encrypted backup', { exact: true }).click();
  await expect(page.getByLabel('Backup passphrase', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Backup file to restore', { exact: true })).toBeHidden();
  await page.getByText('Restore a backup', { exact: true }).click();
  await expect(page.getByLabel('Backup file to restore', { exact: true })).toBeVisible();
});
