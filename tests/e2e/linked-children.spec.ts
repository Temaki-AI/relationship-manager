import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test('a child entry can link to a profile and later be unlinked', async ({ page }, testInfo) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  const h = await createCloudHarness();
  try {
    const parent = (await h.call('contacts', { method: 'POST', body: { name: 'Parent contact' } })).body.contact;
    const profile = (await h.call('contacts', { method: 'POST', body: { name: 'Child profile', birthday: '2020-07-16' } })).body.contact;
    await h.call(`contacts/${parent.id}/children`, { method: 'POST', body: { name: 'Old alias', birthday: '2020-07-16' } });

    await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    await page.route('**/api/contacts**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const result = await h.call(`${url.pathname.slice('/api/'.length)}${url.search}`, {
        method: request.method(),
        body: request.postData() ? request.postDataJSON() : undefined,
        key: request.headers()['idempotency-key'] || null,
      });
      await route.fulfill({ status: result.status, json: result.body });
    });

    await page.goto(`/contacts/${parent.id}`);
    if (testInfo.project.name === 'chromium-mobile') {
      await page.getByRole('navigation', { name: 'Profile sections' }).getByRole('button', { name: 'Details' }).click();
    }
    await expect(page.getByText('Old alias', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit child Old alias' }).click();
    await page.getByLabel('Link to an existing contact (optional)').fill('Child profile');
    await page.getByRole('option', { name: 'Child profile' }).click();
    await expect(page.getByText('Name and birthday come from this profile.')).toBeVisible();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('link', { name: 'Child profile' }).first()).toBeVisible();
    const linked = (await h.call(`contacts/${parent.id}/children`)).body.children[0];
    expect(linked.linked_contact_id).toBe(profile.id);
    expect(linked.birthday).toBe('2020-07-16');
    expect((await h.call('calendar?start=2026-07-16&end=2026-07-16')).body.events.filter(
      (event: { kind: string }) => event.kind === 'birthday'
    )).toHaveLength(1);

    await page.getByRole('button', { name: 'Edit child Child profile' }).click();
    await page.getByRole('button', { name: 'Unlink' }).click();
    await expect(page.getByLabel('Birthday')).toHaveValue('2020-07-16');
    await page.getByRole('button', { name: 'Save changes' }).click();
    expect((await h.call(`contacts/${parent.id}/children`)).body.children[0].linked_contact_id).toBeNull();
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await h.close(); }
});
