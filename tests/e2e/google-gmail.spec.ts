import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const id = 'dd34bba6-a7d2-4f18-a862-958733f456b5', epoch = 'b5cac8f4-758f-442c-8faa-a36a8915d5f4';
const connection = { id, purpose: 'gmail', email: 'owner@example.test', display_name: 'Gmail Owner', status: 'connected', revision: 1, authorization_revision: 1 };
const endpoint = '**/api/connections/' + id + '/gmail';
test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
});

test('Gmail consent is explicit and separate, and stays unavailable without its own configuration', async ({ page }) => {
  let configured = false, authorizations = 0;
  await page.route('**/api/connections', (route) => route.fulfill({ json: { mode: 'cloud', configured: true,
    configured_purposes: { contacts: true, calendar: false, 'calendar-publish': false, gmail: configured }, epoch,
    connections: [connection, { ...connection, id: 'bb34bba6-a7d2-4f18-a862-958733f456b5', purpose: 'contacts', display_name: 'Contacts Owner' }] } }));
  await page.route('**/api/connections/google/authorize', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ purpose: 'gmail', expected_epoch: epoch }); authorizations++;
    await route.fulfill({ json: { authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?scope=gmail-fixture' } });
  });
  await page.route('https://accounts.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Fixture Gmail consent</h1>' }));
  await page.goto('/connections/google/gmail?result=failed');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Gmail connections');
  await expect(page.getByRole('status')).toContainText('cancelled, expired or could not be saved');
  await expect(page.getByRole('article')).toContainText('Gmail Owner');
  await expect(page.getByRole('article')).not.toContainText('Contacts Owner');
  await expect(page.getByRole('main')).toContainText('Email bodies and attachments are outside this permission');
  await expect(page.getByRole('button', { name: 'Connect Gmail metadata', exact: true })).toBeDisabled(); expect(authorizations).toBe(0);
  configured = true; await page.reload();
  await page.getByRole('button', { name: 'Connect Gmail metadata', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fixture Gmail consent', exact: true })).toBeVisible(); expect(authorizations).toBe(1);
});

test('mailbox labels need an explicit preview, support mobile search and paging, and disappear on reload', async ({ page }) => {
  let previews = 0;
  const labels = Array.from({ length: 102 }, (_, index) => ({ id: 'Label_' + index,
    name: index === 0 ? '<Friends> · relações ' + 'long label '.repeat(15) : 'Group ' + index, type: 'user' }));
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { epoch, can_preview: true, connection } });
    expect(route.request().postDataJSON()).toEqual({ expected_epoch: epoch, expected_authorization_revision: 1 }); previews++;
    await route.fulfill({ json: { email: connection.email, labels } });
  });
  await page.goto('/connections/google/' + id + '/gmail');
  const preview = page.getByRole('button', { name: 'Preview mailbox labels', exact: true }); await expect(preview).toBeEnabled();
  expect(previews).toBe(0); await expect(page.getByRole('heading', { name: 'Mailbox labels', exact: true })).toHaveCount(0);
  await preview.click(); await expect(page.getByRole('status')).toContainText('102 labels loaded. No messages imported.');
  const rows = page.getByRole('list', { name: '' }).filter({ has: page.getByText('<Friends>', { exact: false }) });
  await expect(rows.getByRole('listitem')).toHaveCount(50);
  await page.getByRole('button', { name: 'Show more labels', exact: true }).click(); await expect(rows.getByRole('listitem')).toHaveCount(100);
  await page.getByLabel('Find a label', { exact: true }).fill('relações'); await expect(rows.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText(labels[0].name, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze(); expect(axe.violations).toEqual([]);
  expect(await page.evaluate(() => Object.values(localStorage).some((value) => String(value).includes('<Friends>')))).toBe(false);
  await page.reload(); await expect(preview).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Mailbox labels', exact: true })).toHaveCount(0); expect(previews).toBe(1);
});

test('authorization changes during a preview discard the labels and disable revoked accounts', async ({ page }) => {
  let changed = false, previews = 0;
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { epoch, can_preview: !changed,
      connection: changed ? { ...connection, status: 'disconnected', authorization_revision: 2, revision: 2 } : connection } });
    previews++; changed = true;
    await route.fulfill({ json: { email: connection.email, labels: [{ id: 'Label_1', name: 'Private label must be discarded', type: 'user' }] } });
  });
  await page.goto('/connections/google/' + id + '/gmail');
  const button = page.getByRole('button', { name: 'Preview mailbox labels', exact: true }); await expect(button).toBeEnabled(); await button.click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Gmail account changed');
  await expect(page.getByText('Private label must be discarded', { exact: true })).toHaveCount(0);
  await expect(button).toBeDisabled(); expect(previews).toBe(1);
});
