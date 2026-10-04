import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('shared iPhone observations are readable on web and unlink retries the exact uncertain request', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  const person = (await (await page.request.post('/api/contacts', { data: { name: 'My corrected Ana', notes: 'Private memory', email: 'preferred@example.test' }, headers: { 'Idempotency-Key': crypto.randomUUID() } })).json()).contact;
  const epoch = '1c9b942a-7f07-470a-b495-a2158dbfca25', publicId = '3c9b942a-7f07-470a-b495-a2158dbfca25';
  const facts = { device_id: 'opaque-phone-address-id', name: 'iPhone Ana', phones: [], emails: [{ source_id: 'os-email', value: 'a.long.address.for.a.saved.phone.observation@example.test', label: 'Home' }] };
  const source = { public_id: publicId, installation_id: '4c9b942a-7f07-470a-b495-a2158dbfca25', external_id: facts.device_id,
    original_facts: JSON.stringify(facts), observed_facts: JSON.stringify({ ...facts, name: 'Updated iPhone Ana' }), applied_fields: '{"name":null,"methods":[]}', revision: 2,
    observed_at: '2026-10-04T10:00:00.000Z', created_at: '2026-10-03T10:00:00.000Z', updated_at: '2026-10-04T10:00:00.000Z' };
  let linked = true; const requests: string[] = [];
  await page.route('**/api/contacts/' + person.id + '/device-sources', (route) => route.fulfill({ json: { epoch, contact_id: publicId, links: linked ? [source] : [] } }));
  await page.route('**/api/v1/device-sources/push', (route) => {
    expect(route.request().method()).toBe('POST'); requests.push(route.request().postData()!); linked = false;
    if (requests.length === 1) return route.abort('failed');
    return route.fulfill({ json: { operation_id: JSON.parse(requests[0]).operation_id, epoch, action: 'unlink', contact_id: publicId, source: null } });
  });
  await page.goto('/contacts/' + person.id + '/sources');
  const section = page.getByRole('region', { name: 'iPhone sources', exact: true });
  await expect(section.getByText('iPhone Ana', { exact: true })).toBeVisible(); await expect(section.getByText('Updated iPhone Ana', { exact: true })).toBeVisible();
  await section.getByText('Fields accepted from this source', { exact: true }).click(); await expect(section.getByText('Source details only; no profile fields selected.')).toBeVisible();
  await expect(section).not.toContainText('opaque-phone-address-id');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: info.outputPath('shared-iphone-sources.png'), fullPage: true });
  await section.getByRole('button', { name: 'Unlink iPhone source', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Unlink iPhone source?', exact: true });
  await expect(dialog).toContainText('private relationship history stay');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(requests).toHaveLength(0);
  await section.getByRole('button', { name: 'Unlink iPhone source', exact: true }).click(); await dialog.getByRole('button', { name: 'Unlink source', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('fetch'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Unlink source', exact: true }).click(); await expect(section.getByRole('article')).toHaveCount(0);
  expect(requests).toHaveLength(2); expect(requests[1]).toBe(requests[0]);
  expect(JSON.parse(requests[0])).toMatchObject({ epoch, action: 'unlink', source_id: publicId, installation_id: source.installation_id, external_id: facts.device_id, expected_revision: 2 });
  const current = (await (await page.request.get('/api/contacts/' + person.id)).json()).contact;
  expect(current.name).toBe('My corrected Ana'); expect(current.notes).toBe('Private memory'); expect(current.email).toBe('preferred@example.test'); expect(errors).toEqual([]);
});
