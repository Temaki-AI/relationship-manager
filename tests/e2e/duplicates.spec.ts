import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

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

async function createResource<T>(page: Page, path: string, body: Record<string, unknown>): Promise<T> {
  return page.evaluate(async ({ resourcePath, payload }) => {
    const response = await fetch(resourcePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': globalThis.crypto.randomUUID(),
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed with ${response.status}`);
    return result;
  }, { resourcePath: path, payload: body }) as Promise<T>;
}

test('duplicate cleanup preserves relationship history and creates a recovery point', async ({ page }, testInfo) => {
  testInfo.setTimeout(60_000);
  await signIn(page);
  const suffix = testInfo.project.name.endsWith('mobile') ? 'Mobile' : 'Desktop';
  const primaryName = `Merge Primary ${suffix}`;
  const duplicateName = `Merge Secondary ${suffix}`;
  const sharedEmail = `merge-${suffix.toLowerCase()}@example.test`;
  const interactionSummary = `Preserved merge interaction ${suffix}`;
  const reminderTitle = `Preserved merge reminder ${suffix}`;

  const primaryResult = await createResource<{ contact: { id: number } }>(page, '/api/contacts', {
    name: primaryName,
    email: sharedEmail,
    tags: ['primary-tag'],
    notes: `Primary notes ${suffix}`,
  });
  const duplicateResult = await createResource<{ contact: { id: number } }>(page, '/api/contacts', {
    name: duplicateName,
    email: sharedEmail,
    tags: ['secondary-tag'],
    notes: `Secondary notes ${suffix}`,
  });
  const primaryId = primaryResult.contact.id;
  const duplicateId = duplicateResult.contact.id;

  await createResource(page, '/api/interactions', {
    contact_id: duplicateId,
    date: '2026-07-11',
    type: 'call',
    summary: interactionSummary,
    notes: 'This interaction must move to the selected primary profile.',
  });
  await createResource(page, '/api/reminders', {
    contact_id: duplicateId,
    title: reminderTitle,
    notes: 'This reminder must move to the selected primary profile.',
    remind_at: '2099-12-31T10:00:00.000Z',
  });

  await page.goto('/contacts/duplicates');
  await expect(page.getByRole('heading', { name: 'Clean up duplicates', level: 1 })).toBeVisible();
  await expect(page).toHaveTitle('Contacts | Everclose CRM');
  const duplicateGroup = page.getByRole('region', { name: /Possible match/ }).filter({
    hasText: sharedEmail,
  });
  await expect(duplicateGroup).toBeVisible();
  await duplicateGroup.getByRole('radio', {
    name: `Keep ${primaryName} as the primary profile`,
  }).check();
  await duplicateGroup.getByRole('button', { name: 'Merge 2 profiles' }).click();

  const dialog = page.getByRole('alertdialog', { name: 'Merge 2 profiles?' });
  await expect(dialog).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(accessibility.violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Merge profiles' }).click();
  await expect(page.getByRole('status').getByText(
    `1 profile merged into ${primaryName}. A recovery point was saved.`,
    { exact: true }
  )).toBeVisible();
  await expect(duplicateGroup).toHaveCount(0);

  const cookieHeader = (await page.context().cookies())
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const removedProfile = await page.request.get(`/api/contacts/${duplicateId}`, {
    headers: { Cookie: cookieHeader },
  });
  expect(removedProfile.status()).toBe(404);

  await page.goto(`/contacts/${primaryId}`);
  await expect(page.getByRole('heading', { name: primaryName, level: 1 })).toBeVisible();
  const relationshipMemory = page
    .getByRole('heading', { name: 'What to remember', level: 2 })
    .locator('..')
    .locator('..');
  await expect(relationshipMemory).toContainText(`Primary notes ${suffix}`);
  await expect(relationshipMemory).toContainText(`Secondary notes ${suffix}`);
  await expect(page.getByText('primary-tag', { exact: true })).toBeVisible();
  await expect(page.getByText('secondary-tag', { exact: true })).toBeVisible();
  if (testInfo.project.name.endsWith('mobile')) await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const relationshipTimeline = page
    .getByRole('heading', { name: /^Relationship timeline/, level: 3 })
    .locator('..')
    .locator('..');
  await expect(relationshipTimeline).toContainText(interactionSummary);
  await expect(relationshipTimeline).toContainText(reminderTitle);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByText('Before duplicate merge', { exact: true }).first()).toBeVisible();
});
