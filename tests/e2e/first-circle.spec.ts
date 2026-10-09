import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test('first-run journey grows from one chosen person to a real logged moment', async ({ page }, testInfo) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  test.setTimeout(90_000);
  const h = await createCloudHarness();
  try {
    await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    for (const pattern of ['**/api/intelligence/overview*', '**/api/contacts**', '**/api/interactions**']) {
      await page.route(pattern, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const endpoint = `${url.pathname.slice('/api/'.length)}${url.search}`;
        const result = await h.call(endpoint, {
          method: request.method(),
          body: request.postData() ? request.postDataJSON() : undefined,
          key: request.headers()['idempotency-key'] || null,
        });
        await route.fulfill({ status: result.status, json: result.body });
      });
    }

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Start with one person', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Add your first person' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Ana Silva');
    await page.getByRole('button', { name: 'Add contact', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ana Silva', level: 1 })).toBeVisible();
    expect((await h.call('contacts', { method: 'POST', body: { name: 'Bea Costa' } })).status).toBe(201);

    await page.goto('/');
    await page.getByText('Set up your first connections', { exact: true }).click();
    const journey = page.getByRole('region', { name: 'Start close, not wide.' });
    await expect(journey).toBeVisible();
    await expect(journey.getByText('0 in your circle')).toBeVisible();
    await journey.getByRole('checkbox', { name: 'Ana Silva' }).check();
    await journey.getByRole('button', { name: 'Add 1 to my circle' }).click();
    await expect(journey.getByText('1 in your circle')).toBeVisible();
    const tags = await h.db.prepare('SELECT name, tags FROM contacts WHERE workspace_id = ? ORDER BY name')
      .bind('test').all<{ name: string; tags: string | null }>();
    expect(JSON.parse(tags.results.find((contact) => contact.name === 'Ana Silva')?.tags || '[]')).toContain('Close circle');
    expect(tags.results.find((contact) => contact.name === 'Bea Costa')?.tags).toBeNull();
    const overviewBefore = (await h.call('intelligence/overview?timeZone=UTC')).body.firstSteps;
    expect(overviewBefore.hasLoggedMoment).toBe(false);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('first-circle.png'), fullPage: true });
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await journey.getByRole('link', { name: "Add Ana Silva's birthday" }).click();
    await expect(page).toHaveURL((url) => /\/contacts\/\d+\/edit$/.test(url.pathname) && url.searchParams.get('focus') === 'birthday');
    await expect(page.getByLabel('Birthday', { exact: true })).toBeFocused();
    await page.getByLabel('Birthday', { exact: true }).fill('1989-08-03');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { name: 'Ana Silva', level: 1 })).toBeVisible();

    await page.goto('/');
    await page.getByText('Set up your first connections', { exact: true }).click();
    await expect(journey.getByRole('link', { name: 'Review birthday' })).toBeVisible();
    await journey.getByRole('link', { name: 'Log a moment' }).click();
    await expect(page.locator('#interaction-form')).toBeVisible();
    await page.locator('#interaction-form').getByLabel('Summary').fill('Caught up over coffee');
    await page.locator('#interaction-form').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Caught up over coffee', { exact: true }).last()).toBeVisible();
    const logged = await h.db.prepare('SELECT COUNT(*) AS count FROM interactions WHERE workspace_id = ? AND summary = ?')
      .bind('test', 'Caught up over coffee').first<{ count: number }>();
    expect(logged?.count).toBe(1);

    await page.goto('/');
    await expect(journey).toHaveCount(0);
    const overviewAfter = (await h.call('intelligence/overview?timeZone=UTC')).body.firstSteps;
    expect(overviewAfter.hasLoggedMoment).toBe(true);
  } finally { await h.close(); }
});
