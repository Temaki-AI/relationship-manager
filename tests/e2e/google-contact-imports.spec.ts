import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const connectionId = '0c9b942a-7f07-470a-b495-a2158dbfca25', epoch = '1c9b942a-7f07-470a-b495-a2158dbfca25', generation = '2c9b942a-7f07-470a-b495-a2158dbfca25';
const facts = { sourceId: 'a', resourceName: 'people/a', etag: 'v1', name: 'Google Ana', company: 'Company', title: 'Engineer', location: 'Lisbon',
  emails: [{ value: 'ana.long.address.for.relationship.review@example.test', label: 'work', primary: true, canonical: null }], phones: [{ value: '+351 912 345 678', label: 'mobile', primary: true, canonical: '+351912345678' }] };
const person = { id: 42, name: 'My preferred Ana', edit_revision: 'a'.repeat(64) };
test('Google selected imports offer confirmed matches and recover an uncertain response with identical choices on desktop and mobile', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  await page.route('**/api/connections/' + connectionId + '/contacts/import-preview?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { epoch, generation, facts_revision: 'b'.repeat(64), facts, connection: { id: connectionId, email: 'owner@example.test', authorization_revision: 1 },
      linked_contact: null, matches: [person], people: query.get('q') ? [person] : [], target: query.get('contact_id') ? person : null } });
  });
  const requests: Array<{ key: string | null; body: unknown }> = [];
  await page.route('**/api/connections/' + connectionId + '/contacts/import', async (route) => {
    requests.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
    if (requests.length === 1) return route.abort('failed');
    await route.fulfill({ json: { contact_id: person.id, replayed: true } });
  });
  await page.goto('/connections/google/' + connectionId + '/contacts/import?' + new URLSearchParams({ generation, source_id: 'a' }));
  await expect(page.getByLabel('New person’s name')).toHaveValue('Google Ana');
  await page.getByRole('button', { name: 'Attach to My preferred Ana', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create a new person instead', exact: true })).toBeVisible();
  await page.getByLabel(/ana.long.address/).check();
  await expect(page.getByLabel(/Use Google’s name/)).not.toBeChecked();
  await page.getByLabel('Keep selected values updated from Google', { exact: true }).check();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze(); expect(axe.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: info.outputPath('google-selected-import.png'), fullPage: true });
  await page.getByRole('button', { name: 'Attach source and selected fields', exact: true }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText('not confirmed');
  await expect(page.getByLabel(/ana.long.address/)).toBeDisabled();
  await page.getByRole('button', { name: 'Retry same import', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open person', exact: true })).toHaveAttribute('href', '/contacts/42');
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].body).toMatchObject({ expected_epoch: epoch, contact_id: 42, use_name: false, create_name: null, emails: [0], phones: [], keep_updated: true });
  expect(errors).toEqual([]);
});

test('saved Google details show original and accepted fields and unlink only after a concrete review', async ({ page }, info) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  const created = (await (await page.request.post('/api/contacts', { data: { name: 'Saved Google person', notes: 'Private note' }, headers: { 'Idempotency-Key': crypto.randomUUID() } })).json()).contact;
  const publicId = '3c9b942a-7f07-470a-b495-a2158dbfca25'; let linked = true;
  const source = { public_id: publicId, provider: 'google', account_key: 'google-owner', account_email: 'owner@example.test', external_id: 'a', resource_name: 'people/a',
    original_facts: JSON.stringify(facts), observed_facts: JSON.stringify(facts), applied_fields: JSON.stringify({ name: null, methods: [] }), status: 'available', revision: 1,
    observed_at: '2026-10-04T10:00:00Z', created_at: '2026-10-04T10:00:00Z', updated_at: '2026-10-04T10:00:00Z' };
  await page.route('**/api/contacts/' + created.id + '/provider-sources', (route) => route.fulfill({ json: { epoch, links: linked ? [source] : [] } }));
  await page.route('**/api/contacts/' + created.id + '/provider-sources/' + publicId, (route) => {
    expect(route.request().method()).toBe('DELETE'); expect(route.request().postDataJSON()).toEqual({ expected_epoch: epoch, expected_revision: 1 }); linked = false;
    return route.fulfill({ json: { success: true } });
  });
  await page.goto('/contacts/' + created.id + '/sources');
  const section = page.getByRole('region', { name: 'Google sources', exact: true });
  await expect(section.getByText('Original source details', { exact: true })).toBeVisible();
  await section.getByText('Fields accepted from this source', { exact: true }).click();
  await expect(section.getByText('Source details only; no CRM fields selected.')).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze(); expect(axe.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('google-saved-sources.png'), fullPage: true });
  await section.getByRole('button', { name: 'Unlink Google source', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Unlink Google source?', exact: true }); await expect(dialog).toContainText('private notes and relationship history stay');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(linked).toBe(true);
  await section.getByRole('button', { name: 'Unlink Google source', exact: true }).click();
  await dialog.getByRole('button', { name: 'Unlink source', exact: true }).click(); await expect(section.getByRole('article')).toHaveCount(0);
  expect((await (await page.request.get('/api/contacts/' + created.id)).json()).contact.notes).toBe('Private note');
});
