import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const accountPassword = 'bonds-e2e-account-password';
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

test.describe.configure({ timeout: 90_000 });

function formatViolations(
  route: string,
  violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']
) {
  return violations.map((violation) => ({
    route,
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.flatMap((node) => node.target.map(String)),
  }));
}

async function getAccessibilityViolations(page: Page, route: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  return formatViolations(route, results.violations);
}

async function signIn(page: Page) {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Welcome back to Everclose CRM' })).toBeVisible();
  await page.getByLabel('Account password').fill(accountPassword);
  await page.getByRole('button', { name: 'Open my CRM' }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/');
}

test('the signed-out experience has no automated WCAG A or AA violations', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel('Account password')).toBeVisible();
  await expect(page).toHaveTitle('Sign in | Everclose CRM');
  expect(await getAccessibilityViolations(page, '/login')).toEqual([]);
});

test('primary signed-in routes have no automated WCAG A or AA violations', async ({ page }) => {
  await signIn(page);
  const violations = [];

  for (const route of [
    { path: '/', heading: 'Today', title: 'Everclose CRM - Personal Relationship Manager' },
    { path: '/contacts', heading: 'Your people', title: 'Contacts | Everclose CRM' },
    { path: '/contacts/1', heading: 'Sarah Martinez', title: 'Contacts | Everclose CRM' },
    { path: '/contacts/new', heading: 'Add someone new', title: 'Contacts | Everclose CRM' },
    { path: '/groups', heading: 'Groups', title: 'Groups | Everclose CRM' },
    { path: '/smart-lists', heading: 'Smart Lists', title: 'Smart Lists | Everclose CRM' },
    { path: '/reminders', heading: 'Reminders', title: 'Reminders | Everclose CRM' },
    { path: '/integrations', heading: 'Connections', title: 'Data connections | Everclose CRM' },
    { path: '/settings', heading: 'Settings', title: 'Data & recovery | Everclose CRM' },
  ]) {
    await page.goto(route.path);
    await expect(page.getByRole('heading', { name: new RegExp(route.heading), level: 1 })).toBeVisible();
    await expect(page).toHaveTitle(route.title);
    violations.push(...await getAccessibilityViolations(page, route.path));
  }

  expect(violations).toEqual([]);
});

test('dynamic relationship forms and dialogs have no automated WCAG A or AA violations', async ({ page }) => {
  await signIn(page);
  await page.goto('/contacts/1');
  await expect(page.getByRole('heading', { name: 'Sarah Martinez', level: 1 })).toBeVisible();
  await expect(page).toHaveTitle('Contacts | Everclose CRM');

  await page.getByRole('button', { name: 'Reminder', exact: true }).click();
  await expect(page.getByLabel('Reminder title')).toBeVisible();
  expect(await getAccessibilityViolations(page, '/contacts/1#reminder-form')).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.getByLabel("What's the plan?")).toBeVisible();
  expect(await getAccessibilityViolations(page, '/contacts/1#plan-form')).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('button', { name: 'Log moment' }).click();
  await expect(page.getByLabel('Summary', { exact: true })).toBeVisible();
  expect(await getAccessibilityViolations(page, '/contacts/1#interaction-form')).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('navigation', { name: 'Activity filters' }).getByRole('button', { name: 'All activity' }).click();
  await page.getByRole('button', {
    name: 'Edit interaction: Shared a long-run training plan',
  }).click();
  await expect(page.getByRole('navigation', { name: 'Activity filters' }).getByRole('button', { name: 'Conversations' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Shared a long-run training plan');
  expect(await getAccessibilityViolations(page, '/contacts/1#interaction-edit')).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('button', {
    name: 'Delete interaction: Shared a long-run training plan',
  }).click();
  await expect(page.getByRole('alertdialog', { name: 'Delete interaction?' })).toBeVisible();
  expect(await getAccessibilityViolations(page, '/contacts/1#delete-interaction')).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.locator('summary[aria-label="More contact actions"]').click();
  await page.getByRole('button', { name: 'Delete contact' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Delete Sarah Martinez?' })).toBeVisible();
  expect(await getAccessibilityViolations(page, '/contacts/1#delete-contact')).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.goto('/contacts/new');
  await page.getByLabel('Name').fill('Accessibility draft');
  await page.getByRole('link', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeVisible();
  expect(await getAccessibilityViolations(page, '/contacts/new#unsaved-draft')).toEqual([]);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
});
