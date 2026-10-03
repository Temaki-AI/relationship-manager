import { expect, test, type Page } from '@playwright/test';

const accountPassword = 'bonds-e2e-account-password';
const browserErrors = new WeakMap<Page, string[]>();

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

async function signIn(page: Page, returnPath: string) {
  await page.goto(returnPath);
  await expect(page).toHaveURL((url) =>
    url.pathname === '/login' && url.searchParams.get('next') === returnPath
  );
  await expect(page.getByRole('heading', { name: 'Welcome back to Everclose CRM' })).toBeVisible();
  await page.getByLabel('Account password').fill(accountPassword);
  await page.getByRole('button', { name: 'Open my CRM' }).click();
  await expect(page).toHaveURL((url) => url.pathname === returnPath);
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
}

async function expectUnloadGuard(page: Page, active: boolean) {
  const guarded = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return !window.dispatchEvent(event);
  });
  expect(guarded).toBe(active);
}

async function traverseBrowserHistory(page: Page, direction: 'back' | 'forward') {
  await page.evaluate((nextDirection) => {
    if (nextDirection === 'back') window.history.back();
    else window.history.forward();
  }, direction);
}

async function openSettingsFromHeader(page: Page) {
  await page.getByRole('navigation').getByRole('link', { name: 'Settings', exact: true }).click();
}

async function expectHistoryPoint(page: Page, expectedPoint: number) {
  await expect.poll(() => page.evaluate(() => (
    Number((window.history.state as Record<string, unknown> | null)?.__bondsHistoryPoint)
  ))).toBe(expectedPoint);
}

test('authenticated navigation remains usable at consumer breakpoints', async ({ page }) => {
  await signIn(page, '/contacts');
  await expect(page.getByRole('heading', { name: 'Your people' })).toBeVisible();
  await expect(page.getByText(/^\d+ contacts(?: · \d+ matching)?$/)).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const headerStyle = await page.locator('header').evaluate((header) => {
    const style = getComputedStyle(header);
    return { background: style.backgroundColor, backdrop: style.backdropFilter };
  });
  if ((page.viewportSize()?.width || 0) < 640) {
    expect(headerStyle.background).toBe('rgb(255, 255, 255)');
    expect(headerStyle.backdrop).toBe('none');
    await page.getByRole('button', { name: 'More navigation' }).click();
    await expect(page.locator('#mobile-more-menu').getByRole('link', { name: 'Groups', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  } else {
    expect(headerStyle.backdrop).toContain('blur');
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Groups' })).toBeVisible();
  }

  await page.getByRole('textbox', { name: 'Search contacts' }).fill('Sarah Martinez');
  await expect(page.getByText('1 matching contact', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Sarah Martinez/ })).toBeVisible();

  for (const route of [
    { path: '/groups', heading: 'Groups' },
    { path: '/smart-lists', heading: 'Smart Lists' },
    { path: '/reminders', heading: 'Reminders' },
    { path: '/settings', heading: 'Data & recovery' },
  ]) {
    await page.goto(route.path);
    await expect(page.getByRole('heading', { name: route.heading, level: 1 })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test('a contact and reminder can be created and completed end to end', async ({ page }, testInfo) => {
  await signIn(page, '/contacts/new');
  const suffix = testInfo.project.name.endsWith('mobile') ? 'Mobile' : 'Desktop';
  const contactName = `E2E Ada ${suffix}`;
  const reminderTitle = `Follow up with ${contactName}`;

  await page.getByLabel('Name').fill(contactName);
  await page.getByLabel('Email').fill(`ada-${suffix.toLowerCase()}@example.test`);
  await page.getByRole('button', { name: 'Work & place' }).click();
  await page.getByLabel('Company').fill('Analytical Engines');
  await page.getByRole('button', { name: 'Save contact with details' }).click();

  await expect(page).toHaveURL(/\/contacts\/\d+$/);
  await expect(page.getByRole('heading', { name: contactName, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Reminder', exact: true }).click();
  await page.getByLabel('Reminder title').fill(reminderTitle);
  await page.getByLabel('Reminder date and time').fill('2099-12-31T10:00');
  await page.getByLabel('Reminder notes').fill('Created by the isolated browser release gate.');
  await page.getByRole('button', { name: 'Save reminder' }).click();

  await expect(page.getByRole('status').getByText('Reminder set', { exact: true })).toBeVisible();
  await page.goto('/reminders');
  await expect(page.getByRole('heading', { name: 'Reminders', level: 1 })).toBeVisible();
  await expect(page.getByText(reminderTitle, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Mark ${reminderTitle} as complete` }).click();
  await expect(page.getByText(reminderTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByText('Reminder completed', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('long contact forms protect unsaved drafts from accidental navigation', async ({ page }, testInfo) => {
  await signIn(page, '/contacts');
  const suffix = testInfo.project.name.endsWith('mobile') ? 'Mobile' : 'Desktop';
  const draftName = `Unsaved ${suffix} draft`;
  const directoryHistoryPoint = Number(await page.evaluate(() => (
    (window.history.state as Record<string, unknown> | null)?.__bondsHistoryPoint
  )));

  await page.locator('a[href="/contacts/new"]:visible').first().click();
  await expect(page).toHaveURL((url) => url.pathname === '/contacts/new');
  await expectHistoryPoint(page, directoryHistoryPoint + 1);
  await expectUnloadGuard(page, false);
  await page.getByLabel('Name').fill(draftName);
  await expectUnloadGuard(page, true);
  await page.getByRole('link', { name: 'Cancel', exact: true }).click();
  const createDialog = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/contacts/new');
  await expect(page.getByLabel('Name')).toHaveValue(draftName);
  await expectUnloadGuard(page, true);

  await traverseBrowserHistory(page, 'back');
  await expect(page).toHaveURL((url) => url.pathname === '/contacts/new');
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Name')).toHaveValue(draftName);

  await traverseBrowserHistory(page, 'back');
  await expect(page).toHaveURL((url) => url.pathname === '/contacts/new');
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/contacts');
  await expect(page.getByRole('heading', { name: 'Your people', level: 1 })).toBeVisible();
  await expectHistoryPoint(page, directoryHistoryPoint);

  await page.locator('a[href="/contacts/new"]:visible').first().click();
  await expectHistoryPoint(page, directoryHistoryPoint + 1);
  await openSettingsFromHeader(page);
  await expect(page).toHaveURL((url) => url.pathname === '/settings');
  await expect(page.getByRole('heading', { name: 'Data & recovery', level: 1 })).toBeVisible();
  await expectHistoryPoint(page, directoryHistoryPoint + 2);
  await traverseBrowserHistory(page, 'back');
  await expect(page).toHaveURL((url) => url.pathname === '/contacts/new');
  await expectHistoryPoint(page, directoryHistoryPoint + 1);
  await expect(page.getByLabel('Name')).toHaveValue('');
  const forwardDraftName = `Forward ${suffix} draft`;
  await page.getByLabel('Name').fill(forwardDraftName);
  await expectUnloadGuard(page, true);

  await traverseBrowserHistory(page, 'forward');
  await expect(page).toHaveURL((url) => url.pathname === '/contacts/new');
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Name')).toHaveValue(forwardDraftName);

  await traverseBrowserHistory(page, 'forward');
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/settings');
  await expect(page.getByRole('heading', { name: 'Data & recovery', level: 1 })).toBeVisible();

  await page.goto('/contacts/1/edit');
  await expect(page.getByRole('heading', { name: 'Edit contact', level: 1 })).toBeVisible();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toHaveValue('Sarah Martinez');
  await name.fill(`Sarah Martinez ${suffix}`);
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  const editDialog = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(editDialog).toBeVisible();
  await editDialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/contacts/1');
  await expect(page.getByRole('heading', { name: 'Sarah Martinez', level: 1 })).toBeVisible();
});
