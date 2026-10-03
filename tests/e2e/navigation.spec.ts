import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function signIn(page: Page) {
  await page.goto('/contacts');
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel('Account password').fill('bonds-e2e-account-password');
  await page.getByRole('button', { name: 'Open my CRM' }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/contacts');
}

test('primary and Add navigation lead to real capture flows', async ({ page }, testInfo) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI === 'true', 'The local-auth fixture supplies selectable contacts.');
  test.setTimeout(60_000);
  await signIn(page);

  const peopleSections = page.getByRole('navigation', { name: 'People sections' });
  await expect(peopleSections.getByRole('link', { name: 'People' })).toHaveAttribute('aria-current', 'page');
  await peopleSections.getByRole('link', { name: 'Groups' }).click();
  await expect(page.getByRole('heading', { name: 'Groups', level: 1 })).toBeVisible();
  await peopleSections.getByRole('link', { name: 'Smart Lists' }).click();
  await expect(page.getByRole('heading', { name: 'Smart Lists', level: 1 })).toBeVisible();
  await peopleSections.getByRole('link', { name: 'People' }).click();

  const add = page.getByRole('button', { name: 'Add', exact: true });
  await add.click();
  await expect(add).toHaveAttribute('aria-expanded', 'true');
  const menu = page.locator(testInfo.project.name.endsWith('mobile') ? '#mobile-add-actions' : '#desktop-add-actions');
  await expect(menu.getByRole('link')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('add-menu.png') });
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(add).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeHidden();
  await expect(add).toBeFocused();

  await add.click();
  await menu.getByRole('link', { name: /^Reminder/ }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/calendar');
  await expect(page.getByRole('heading', { name: 'New reminder' })).toBeVisible();
  await expect(page.locator('#calendar-reminder-title')).toBeFocused();
  if (testInfo.project.name.endsWith('mobile')) {
    const formTop = await page.locator('#calendar-reminder-form').evaluate((form) => form.getBoundingClientRect().top);
    expect(formTop).toBeGreaterThan(40);
    expect(formTop).toBeLessThan(180);
  }
  await page.screenshot({ path: testInfo.outputPath('new-reminder.png') });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await add.click();
  await menu.getByRole('link', { name: /^Log moment/ }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/contacts' && url.searchParams.get('intent') === 'log');
  await expect(page.getByText('Who was this moment with?')).toBeVisible();
  await page.getByRole('link', { name: 'Log moment', exact: true }).first().click();
  await expect(page).toHaveURL((url) => /^\/contacts\/\d+$/.test(url.pathname) && url.searchParams.get('capture') === 'moment');
  await expect(page.locator('#interaction-form')).toBeVisible();

  await add.click();
  await menu.getByRole('link', { name: /^Person/ }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/contacts/new');
  await expect(page.getByRole('heading', { name: 'Add someone new' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
