import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('contact methods retain labels, preferred values and drafts across mobile and desktop journeys', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  const created = await page.request.post('/api/contacts', { headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { name: `Methods ${testInfo.project.name}`, email: 'personal@example.test' } });
  expect(created.ok()).toBe(true);
  const { contact } = await created.json();
  await page.goto(`/contacts/${contact.id}/methods`);
  await expect(page.getByRole('heading', { name: /Contact methods/ })).toBeVisible();
  await page.getByRole('button', { name: 'Add email', exact: true }).click();
  const email = page.getByRole('group', { name: 'Email address', exact: true }).last();
  await email.getByLabel('Value', { exact: true }).fill('work@example.test');
  await email.getByLabel('Label', { exact: true }).fill('Work');
  await email.getByRole('checkbox', { name: 'Preferred email' }).check();
  await page.getByRole('button', { name: 'Add phone', exact: true }).click();
  const phone = page.getByRole('group', { name: 'Phone number', exact: true });
  await phone.getByLabel('Value', { exact: true }).fill('912 345 678');
  await phone.getByLabel('Label', { exact: true }).fill('Personal phone');
  await phone.getByLabel('Country code, if known').fill('PT');
  await page.getByRole('button', { name: 'Add profile', exact: true }).click();
  const profile = page.getByRole('group', { name: 'Profile link', exact: true });
  await profile.getByLabel('Value', { exact: true }).fill('https://example.test/profile');
  await profile.getByLabel('Label', { exact: true }).fill('Profile');
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('methods-editor.png') });
  const save = page.getByRole('button', { name: 'Save methods', exact: true });
  await save.click(); await expect(save).toBeDisabled();
  const saved = (await (await page.request.get(`/api/contacts/${contact.id}`)).json()).contact;
  expect(saved.email).toBe('work@example.test');
  expect(JSON.parse(saved.contact_methods)).toHaveLength(4);
  const identities = JSON.parse(saved.contact_methods).map((item: { id: string }) => item.id).sort();
  await page.getByRole('link', { name: 'Back to person', exact: true }).click();
  await expect(page.getByRole('link', { name: 'work@example.test', exact: true })).toBeVisible();
  const additional = page.locator('[aria-label="Additional contact methods"]');
  await expect(additional.getByRole('link', { name: 'personal@example.test', exact: true })).toBeVisible();
  await expect(additional.getByRole('link', { name: 'Profile: https://example.test/profile', exact: true })).toHaveAttribute('rel', 'noreferrer noopener');
  await page.screenshot({ path: testInfo.outputPath('methods-profile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (testInfo.project.name === 'chromium-desktop') {
    const toolbar = await page.getByRole('button', { name: 'Log moment', exact: true }).boundingBox();
    const brief = await page.getByText('Conversation suggestions', { exact: true }).boundingBox();
    expect(toolbar!.y + toolbar!.height).toBeLessThan(brief!.y - 8);
  }

  await page.goto(`/contacts/${contact.id}/methods`);
  await expect(page.getByRole('group', { name: 'Email address', exact: true })).toHaveCount(2);
  const originalId = JSON.parse(saved.contact_methods).find((item: { value: string }) => item.value === 'personal@example.test').id;
  const original = page.getByRole('group', { name: 'Email address', exact: true }).filter({ has: page.locator(`#value-${originalId}`) });
  await original.getByLabel('Value', { exact: true }).fill('draft@example.test');
  const concurrent = await page.request.patch(`/api/contacts/${contact.id}`, { data: { notes: 'Changed on another device', expected_edit_revision: saved.edit_revision } });
  expect(concurrent.ok()).toBe(true);
  await save.click(); await expect(page.getByRole('alert').filter({ hasText: 'This contact changed' })).toBeVisible();
  await expect(original.getByLabel('Value', { exact: true })).toHaveValue('draft@example.test');
  await page.getByRole('link', { name: 'Back to person', exact: true }).click();
  const guard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(guard).toBeVisible(); await guard.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(original.getByLabel('Value', { exact: true })).toHaveValue('draft@example.test');
  const current = (await (await page.request.get(`/api/contacts/${contact.id}`)).json()).contact;
  expect(JSON.parse(current.contact_methods).map((item: { id: string }) => item.id).sort()).toEqual(identities);
  expect(current.notes).toBe('Changed on another device');
  expect(errors).toEqual([]);
});

test('CSV uploads keep secondary methods and preferred values in the self-hosted app', async ({ page }, testInfo) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  const methods = [
    { id: crypto.randomUUID(), kind: 'email', value: `${testInfo.project.name}@example.test`, label: 'Work', country: null, preferred: true },
    { id: crypto.randomUUID(), kind: 'phone', value: testInfo.project.name === 'chromium-mobile' ? '912 333 444' : '912 222 333', label: 'Home', country: 'PT', preferred: true },
    { id: crypto.randomUUID(), kind: 'profile', value: 'https://example.test/imported', label: 'Website', country: null, preferred: false },
  ];
  const row = JSON.stringify(methods).replace(/"/gu, '""');
  const response = await page.request.post('/api/import/csv', { multipart: { file: { name: 'methods.csv', mimeType: 'text/csv', buffer: Buffer.from(`Name,Contact Methods\nImported ${testInfo.project.name},"${row}"\n`) } } });
  expect(response.ok()).toBe(true); const report = await response.json(); expect(report.imported, JSON.stringify(report)).toBe(1);
  const result = await page.request.get(`/api/contacts?search=${encodeURIComponent(`${testInfo.project.name}@example.test`)}`);
  const { contacts } = await result.json();
  const imported = contacts.find((contact: { name: string }) => contact.name === `Imported ${testInfo.project.name}`);
  expect(imported.email).toBe(`${testInfo.project.name}@example.test`);
  expect(imported.phone).toBe(methods[1].value);
  const detail = (await (await page.request.get(`/api/contacts/${imported.id}`)).json()).contact;
  expect(JSON.parse(detail.contact_methods).map((item: { id: string }) => item.id).sort()).toEqual(methods.map((item) => item.id).sort());
});
