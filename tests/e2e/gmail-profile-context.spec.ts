import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { gmailContextFixture } from '../helpers/gmail-context-fixture.ts';

test('contact profiles show bounded reviewed Gmail context and discard a changed private review', async ({ page }, info) => {
  test.setTimeout(60000); test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Profile cards require a cloud UI build.');
  const f = await gmailContextFixture(55);
  try {
    await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    await page.route('**/api/contacts/*', async (route) => { const url = new URL(route.request().url()); const result = await f.h.call(url.pathname.slice(5) + url.search); await route.fulfill({ status: result.status, json: result.body }); });
    await page.route('**/api/calendar/events?*', (route) => route.fulfill({ json: { events: [], more: false } }));
    await page.route('**/api/v1/gmail-context*', async (route) => { const url = new URL(route.request().url()); const result = await f.h.call(url.pathname.slice(5) + url.search); await route.fulfill({ status: result.status, json: result.body }); });
    await page.goto('/contacts/' + f.person.id);
    const card = page.getByRole('heading', { name: 'Reviewed email context', exact: true }).locator('..');
    await expect(card.getByText('Subject not retained', { exact: true })).toHaveCount(3);
    await expect(card.getByText('friend@example.test', { exact: true })).toHaveCount(3);
    await expect(card).not.toContainText('Optional fixture subject');
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('gmail-profile-context.png'), fullPage: true });
    await card.getByRole('button', { name: 'Show all 50 reviewed messages on this page', exact: true }).click();
    await expect(card.getByText('Subject not retained', { exact: true })).toHaveCount(50);
    await card.getByRole('button', { name: 'Older reviewed messages', exact: true }).click();
    await expect(card.getByText('Subject not retained', { exact: true })).toHaveCount(3);
    await expect(card.getByRole('button', { name: 'Show all 5 reviewed messages on this page', exact: true })).toBeVisible();
    await f.h.db.prepare('UPDATE provider_gmail_matching SET revision=revision+1 WHERE connection_id=?').bind(f.connection.id).run();
    await card.getByRole('button', { name: 'Refresh email context', exact: true }).click();
    await expect(card.getByText('Subject not retained', { exact: true })).toHaveCount(3);
    await f.h.db.prepare('DELETE FROM provider_gmail_match_rules WHERE connection_id=?').bind(f.connection.id).run();
    await f.h.db.prepare('UPDATE provider_gmail_matching SET revision=revision+1 WHERE connection_id=?').bind(f.connection.id).run();
    await card.getByRole('button', { name: 'Refresh email context', exact: true }).click();
    await expect(card.getByText('Subject not retained', { exact: true })).toHaveCount(0);
    await expect(card).toContainText('No reviewed correspondence');
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('friend@example.test');
    expect((await f.h.db.prepare('SELECT COUNT(*) n FROM interactions').first())!.n).toBe(0);
  } finally { await f.close(); }
});
