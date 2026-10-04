import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const connectionId = '0c9b942a-7f07-470a-b495-a2158dbfca25', epoch = '1c9b942a-7f07-470a-b495-a2158dbfca25', publicId = '3c9b942a-7f07-470a-b495-a2158dbfca25', methodId = '4c9b942a-7f07-470a-b495-a2158dbfca25';
test('Google source field controls preserve a draft on conflict and explicitly reset or accept saved values on desktop and mobile', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  const created = (await (await page.request.post('/api/contacts', { data: { name: 'My Ana', notes: 'Private note' }, headers: { 'Idempotency-Key': crypto.randomUUID() } })).json()).contact;
  const facts = { sourceId: 'a', resourceName: 'people/a', etag: null, name: 'Google Ana', company: null, title: null, location: null,
    emails: [{ value: 'latest.google@example.test', label: 'work', primary: true, canonical: null }, { value: 'additional@example.test', label: 'home', primary: false, canonical: null }], phones: [] };
  const method = { id: methodId, kind: 'email', value: 'my.correction@example.test', label: 'My label', country: null, preferred: true, source: 'manual', source_value: null, user_override: true };
  const source = { public_id: publicId, provider: 'google', account_key: 'google-owner', account_email: 'owner@example.test', external_id: 'a', resource_name: 'people/a', original_facts: JSON.stringify(facts), observed_facts: JSON.stringify(facts), applied_fields: JSON.stringify({ name: null, methods: [{ method, source_value: facts.emails[0].value }] }), status: 'available', revision: 1, observed_at: '2026-10-04T10:00:00Z', created_at: '2026-10-04T10:00:00Z', updated_at: '2026-10-04T10:00:00Z' };
  const rules = { source_public_id: publicId, revision: 1, fields: { name: { mode: 'keep', overridden: false, last_applied: null, issue: null }, methods: [{ id: methodId, kind: 'email', mode: 'follow', overridden: true, last_applied: 'previous@example.test', issue: null, slot: facts.emails[0] }] } };
  const contact = { name: 'My Ana', contact_methods: JSON.stringify([method]), edit_revision: 'a'.repeat(64) };
  const endpoint = '/api/contacts/' + created.id + '/provider-sources';
  await page.route('**' + endpoint, (route) => route.fulfill({ json: { epoch, links: [source], rules: [rules], contact } }));
  const writes: Record<string, unknown>[] = []; let conflict = true;
  await page.route('**' + endpoint + '/' + publicId, (route) => {
    expect(route.request().method()).toBe('PATCH'); const body = route.request().postDataJSON(); writes.push(body);
    if (conflict) { conflict = false; rules.revision = 2; facts.emails.reverse(); source.observed_facts = JSON.stringify(facts); source.revision = 2; return route.fulfill({ status: 409, json: { error: 'This person changed. Reload while keeping your choices.' } }); }
    if (body.action === 'reset') { rules.fields.methods[0].overridden = false; method.value = facts.emails[body.source_index].value; contact.contact_methods = JSON.stringify([method]); }
    rules.revision++; return route.fulfill({ json: { success: true } });
  });
  await page.goto('/contacts/' + created.id + '/sources'); const section = page.getByRole('region', { name: 'Google sources', exact: true });
  await expect(section.getByText('Your correction or removal is protected.')).toBeVisible();
  await section.getByLabel('Saved Google email to use', { exact: true }).selectOption('0');
  await section.getByText('Accept additional saved source fields', { exact: true }).click(); await section.getByLabel('additional@example.test (home)', { exact: true }).check();
  const name = section.getByLabel('Name: My Ana', { exact: true }); await name.selectOption('follow');
  await section.getByRole('button', { name: 'Save field choices', exact: true }).click(); await expect(section.getByRole('alert')).toContainText('keeping your choices');
  await section.getByRole('button', { name: 'Reload Google sources', exact: true }).click(); await expect(name).toHaveValue('follow');
  await expect(section.getByLabel('additional@example.test (home)', { exact: true })).not.toBeChecked(); await expect(section.getByLabel('Saved Google email to use', { exact: true })).toHaveValue('');
  await section.getByRole('button', { name: 'Save field choices', exact: true }).click(); await expect(section.getByText('Google source field choices saved.', { exact: true })).toBeVisible();
  expect(writes[1]).toMatchObject({ action: 'settings', name_mode: 'follow', expected_policy_revision: 2, expected_epoch: epoch, expected_revision: 2 });
  await section.getByLabel('Saved Google email to use', { exact: true }).selectOption('1');
  await section.getByRole('button', { name: 'Use selected Google value', exact: true }).click(); await expect(section.getByText('Your correction or removal is protected.')).toHaveCount(0);
  expect(writes[2]).toMatchObject({ action: 'reset', field: 'method', method_id: methodId, source_index: 1 });
  await section.getByLabel('additional@example.test (home)', { exact: true }).check();
  await section.getByLabel('Follow these selected values on future downloads', { exact: true }).check(); await section.getByRole('button', { name: 'Accept selected fields', exact: true }).click();
  await expect(section.getByLabel('additional@example.test (home)', { exact: true })).not.toBeChecked(); expect(writes[3]).toMatchObject({ action: 'accept', emails: [0], phones: [], follow: true });
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze(); expect(axe.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: info.outputPath('google-field-controls.png'), fullPage: true });
  expect(errors).toEqual([]); expect((await (await page.request.get('/api/contacts/' + created.id)).json()).contact.notes).toBe('Private note');
});
test('Google automatic downloads expose manual, daily and hourly choices with versioned requests', async ({ page }, info) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  await page.route('**/api/connections', (route) => route.fulfill({ json: { epoch, connections: [{ id: connectionId, email: 'owner@example.test', status: 'connected', authorization_revision: 1 }] } }));
  const schedule = { enabled: false, interval: 86400, revision: 1, next_at: 0 };
  const endpoint = '/api/connections/' + connectionId + '/contacts', writes: unknown[] = [];
  await page.route('**' + endpoint + '?*', (route) => route.fulfill({ json: { generation: null, last_synced_at: null, count: 0, items: [], next_after: null, import_available: true, automatic_sync: schedule.enabled, schedule, run: null } }));
  await page.route('**' + endpoint + '/schedule', (route) => { const body = route.request().postDataJSON(); expect(route.request().method()).toBe('PATCH'); writes.push(body); schedule.enabled = body.enabled; schedule.interval = body.interval; schedule.revision++; return route.fulfill({ json: { success: true } }); });
  await page.goto('/connections/google/' + connectionId + '/contacts'); const frequency = page.getByLabel('Check Google for changes', { exact: true }); await expect(frequency).toHaveValue('0');
  await frequency.selectOption('86400'); await expect(frequency).toBeEnabled(); await expect(frequency).toHaveValue('86400');
  await frequency.selectOption('3600'); await expect(frequency).toBeEnabled(); await expect(frequency).toHaveValue('3600');
  await frequency.selectOption('0'); await expect(frequency).toBeEnabled(); await expect(frequency).toHaveValue('0');
  expect(writes).toEqual([ { expected_epoch: epoch, expected_authorization_revision: 1, expected_settings_revision: 1, enabled: true, interval: 86400 }, { expected_epoch: epoch, expected_authorization_revision: 1, expected_settings_revision: 2, enabled: true, interval: 3600 }, { expected_epoch: epoch, expected_authorization_revision: 1, expected_settings_revision: 3, enabled: false, interval: 3600 } ]);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze(); expect(axe.violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await frequency.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('google-recurring-downloads.png') });
});
