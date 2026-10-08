import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test.describe.configure({ timeout: 90_000 });
type Harness = Awaited<ReturnType<typeof createCloudHarness>>;

async function connect(page: Page, h: Harness, failures: { upload?: boolean; advance?: boolean } = {}) {
  // The real cloud handlers and migrations run against disposable SQL storage.
  // Only the HTTP/auth boundary is replaced; deployed OAuth is tested separately.
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
  await page.route('**/api/import/**', async (route) => {
    const req = route.request();
    const endpoint = new URL(req.url()).pathname.slice('/api/'.length) + new URL(req.url()).search;
    const multipart = req.headers()['content-type']?.startsWith('multipart/form-data');
    const form = multipart ? await new Request(req.url(), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() }).formData() : undefined;
    const body = !multipart && req.postData() ? req.postDataJSON() : undefined;
    const result = await h.call(endpoint, { method: req.method(), form, body, key: req.headers()['idempotency-key'] || null });
    if ((multipart && failures.upload) || (body?.action === 'advance' && failures.advance)) {
      if (multipart) failures.upload = false;
      else failures.advance = false;
      await route.abort('failed');
      return;
    }
    if (result.headers.get('content-type')?.includes('application/json')) await route.fulfill({ status: result.status, json: result.body });
    else await route.fulfill({ status: result.status, body: Buffer.from(result.body), contentType: 'application/octet-stream' });
  });
}

async function stage(h: Harness, source: string) {
  const form = new FormData();
  form.set('file', new File([source], 'people.csv'));
  const upload = await h.call('import/csv', { method: 'POST', form });
  expect(upload.status).toBe(201);
  return upload.body.job.id as string;
}

test('import report supports duplicate review, reconciliation, source download and removal', async ({ page }) => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const source = 'Name,Email\nAda,ada@example.com\nGrace,grace@example.com\nInvalid,bad-address';
    const id = await stage(h, source);
    await connect(page, h);
    await page.goto(`/contacts/imports/${id}`);
    await page.getByRole('button', { name: 'Prepare preview' }).click();
    await expect(page.getByRole('heading', { name: 'Choose who to bring in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import 1 contact', exact: true })).toBeDisabled();
    const ada = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Ada', exact: true }) });
    await expect(ada.getByRole('link', { name: 'Ada (opens new tab)' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('import-preview.png'), fullPage: true });
    await ada.getByRole('button', { name: 'Create separate contact' }).click();
    await page.getByRole('button', { name: 'Import 2 contacts' }).click();
    await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible();
    expect((await h.call('contacts')).body.pagination.total).toBe(3);
    await page.getByLabel('Show', { exact: true }).selectOption('invalid');
    await expect(page.getByRole('article')).toHaveCount(1);
    await expect(page.getByText('Email must be a valid address.')).toBeVisible();
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Original file' }).click();
    expect((await download).suggestedFilename()).toBeTruthy();
    await page.getByRole('button', { name: 'Remove report and original' }).click();
    await page.getByRole('button', { name: 'Remove report and file', exact: true }).click();
    await expect(page).toHaveURL(/\/contacts\/imports$/);
    await expect(page.getByRole('heading', { name: 'Your next import starts with a preview' })).toBeVisible();
    expect((await h.call('contacts')).body.pagination.total).toBe(3);
  } finally { await h.close(); }
});

test('an uncertain import response can be refreshed and resumed without duplicates', async ({ page }) => {
  const h = await createCloudHarness();
  try {
    const id = await stage(h, 'Name\n' + Array.from({ length: 23 }, (_, i) => `Person ${i}`).join('\n'));
    await connect(page, h, { advance: true });
    await page.goto(`/contacts/imports/${id}`);
    await page.getByRole('button', { name: 'Prepare preview' }).click();
    await page.getByRole('button', { name: 'Import 23 contacts' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
    expect((await h.call('contacts')).body.pagination.total).toBe(10);
    await page.getByRole('button', { name: 'Refresh report' }).click();
    await page.getByRole('button', { name: 'Resume import' }).click();
    await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible();
    expect((await h.call('contacts')).body.pagination.total).toBe(23);
  } finally { await h.close(); }
});

test('cloud upload retries reuse the saved job and open its preview', async ({ page }) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  const h = await createCloudHarness();
  try {
    await connect(page, h, { upload: true });
    await page.goto('/contacts');
    await page.locator('summary').filter({ hasText: 'Manage' }).click();
    await page.getByText('Manage', { exact: true }).click();
  await page.getByRole('button', { name: 'Transfer contacts' }).click();
    await page.locator('#csv-import').setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from('Name\nAda') });
    await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
    expect((await h.call('import/jobs')).body.jobs).toHaveLength(1);
    await page.getByRole('button', { name: 'Retry people.csv' }).click();
    await expect(page.getByRole('heading', { name: 'Prepare your preview' })).toBeVisible();
    expect((await h.call('import/jobs')).body.jobs).toHaveLength(1);
    expect((await h.call('contacts')).body.pagination.total).toBe(0);
  } finally { await h.close(); }
});
