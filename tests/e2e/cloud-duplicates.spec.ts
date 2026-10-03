import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test('cloud duplicate review recovers a lost merge response without merging twice', async ({ page }, testInfo) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  testInfo.setTimeout(90_000);
  const h = await createCloudHarness();
  try {
    const primary = (await h.call('contacts', { method: 'POST', body: {
      name: 'Ada Primary', email: 'ada.merge@example.test', notes: 'Primary note',
    } })).body.contact;
    const duplicate = (await h.call('contacts', { method: 'POST', body: {
      name: 'Ada Secondary', email: 'ada.merge@example.test', notes: 'Secondary note',
    } })).body.contact;
    await h.call('interactions', { method: 'POST', body: {
      contact_id: duplicate.id, date: '2026-09-01', type: 'call', summary: 'Preserved conversation',
    } });
    const login = await page.request.post('/api/auth/login', {
      data: { password: 'bonds-e2e-account-password' },
    });
    expect(login.ok()).toBe(true);
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    const keys: string[] = [];
    let loseFirstMergeResponse = true;
    await page.route('**/api/contacts/duplicates*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const key = request.headers()['idempotency-key'] || null;
      if (request.method() === 'POST') keys.push(key || '');
      const result = await h.call(`contacts/duplicates${url.search}`, {
        method: request.method(),
        body: request.postData() ? request.postDataJSON() : undefined,
        key,
      });
      if (request.method() === 'POST' && loseFirstMergeResponse) {
        loseFirstMergeResponse = false;
        await route.abort('failed');
        return;
      }
      await route.fulfill({ status: result.status, json: result.body });
    });

    await page.goto('/contacts/duplicates');
    await expect(page.getByRole('heading', { name: 'Clean up duplicates', level: 1 })).toBeVisible();
    const group = page.getByRole('region', { name: /Possible match/ }).filter({ hasText: 'ada.merge@example.test' });
    await expect(group).toBeVisible();
    await group.getByRole('radio', { name: 'Keep Ada Primary as the primary profile' }).check();
    await expect(group.getByRole('link', { name: 'Inspect Ada Secondary' })).toBeVisible();
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(axe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('cloud-duplicate-review.png'), fullPage: true });

    await group.getByRole('button', { name: 'Merge 2 profiles' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Merge 2 profiles?' });
    await dialog.getByRole('button', { name: 'Merge profiles' }).click();
    await expect(page.getByText('Could not confirm the merge response. Retry this same merge safely.')).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Merge profiles' }).click();
    await expect(page.getByText('This merge into Ada Primary had already completed. Review your current recovery points in Settings.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your people are tidy' })).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect((await h.call('settings/backups')).body.backups).toHaveLength(1);
    expect((await h.call(`contacts/${duplicate.id}`)).status).toBe(404);
    const merged = (await h.call(`contacts/${primary.id}`)).body.contact;
    expect(merged.notes).toContain('Primary note');
    expect(merged.notes).toContain('Secondary note');
  } finally { await h.close(); }
});

test('cloud duplicate review hydrates only the visible page of matches', async ({ page }) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  const h = await createCloudHarness();
  try {
    for (let index = 1; index <= 11; index += 1) {
      for (const name of [`Match ${index} first`, `Match ${index} second`]) {
        const result = await h.call('contacts', { method: 'POST', body: {
          name, email: `match-${index}@example.test`,
        } });
        expect(result.status).toBe(201);
      }
    }
    const login = await page.request.post('/api/auth/login', {
      data: { password: 'bonds-e2e-account-password' },
    });
    expect(login.ok()).toBe(true);
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    const detailSizes: number[] = [];
    await page.route('**/api/contacts/duplicates*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has('ids')) detailSizes.push(url.searchParams.get('ids')!.split(',').length);
      const result = await h.call(`contacts/duplicates${url.search}`);
      await route.fulfill({ status: result.status, json: result.body });
    });

    await page.goto('/contacts/duplicates');
    await expect(page.getByText('Page 1 of 2')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Possible match 1', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Possible match 10', exact: true })).toBeVisible();
    expect(detailSizes).toEqual([20]);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    const lastGroup = page.getByRole('region', { name: 'Possible match 11', exact: true });
    await expect(lastGroup.getByRole('radio', { name: 'Keep Match 11 first as the primary profile' })).toBeVisible();
    expect(detailSizes).toEqual([20, 2]);
  } finally { await h.close(); }
});
