import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test('Today supports outreach, snooze and undo, safe log retry, and explicit reminder completion', async ({ page }) => {
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  const h = await createCloudHarness();
  try {
    const contactResult = await h.call('contacts', { method: 'POST', body: { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550101', last_contacted: '2025-01-01', contact_frequency: 7 } });
    expect(contactResult.status).toBe(201);
    const contactId = contactResult.body.contact.id as number;
    const reminderResult = await h.call('reminders', { method: 'POST', body: { contact_id: contactId, title: 'Ask Ada about her project', remind_at: '2025-01-02T09:00:00Z' } });
    expect(reminderResult.status).toBe(201);
    const reminderId = reminderResult.body.reminder.id as number;
    expect((await h.call('interactions', { method: 'POST', body: { contact_id: contactId, type: 'message', date: '2025-01-01', summary: 'Talked about the engine' } })).status).toBe(201);

    await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    let loseFirstLogResponse = true;
    let loseFirstCompletionResponse = true;
    for (const pattern of ['**/api/intelligence/overview*', '**/api/today/snooze', '**/api/interactions', '**/api/reminders/*']) {
      await page.route(pattern, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const endpoint = `${url.pathname.slice('/api/'.length)}${url.search}`;
        const result = await h.call(endpoint, {
          method: request.method(),
          body: request.postData() ? request.postDataJSON() : undefined,
          key: request.headers()['idempotency-key'] || null,
        });
        if (endpoint === 'interactions' && request.method() === 'POST' && loseFirstLogResponse) {
          loseFirstLogResponse = false;
          await route.abort('failed');
          return;
        }
        if (endpoint === `reminders/${reminderId}` && request.method() === 'PATCH' && loseFirstCompletionResponse) {
          loseFirstCompletionResponse = false;
          await route.abort('failed');
          return;
        }
        await route.fulfill({ status: result.status, json: result.body });
      });
    }

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Ask Ada about her project' }) });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Overdue since Jan 2, 2025');
    await expect(card.getByText('Talked about the engine')).toBeVisible();
    await card.getByRole('button', { name: 'Reach out' }).click();
    await expect(card.getByRole('link', { name: 'Call', exact: true })).toHaveAttribute('href', 'tel:+15550101');
    await expect(card.getByRole('link', { name: 'Email', exact: true })).toHaveAttribute('href', 'mailto:ada@example.com');
    expect((await h.call('intelligence/overview?timeZone=UTC')).body.feed.some((item: { reminderId?: number }) => item.reminderId === reminderId)).toBe(true);

    await card.getByRole('button', { name: 'Snooze' }).click();
    await card.getByRole('button', { name: 'Tomorrow' }).click();
    await expect(page.getByText('Ask Ada about her project', { exact: true })).toHaveCount(1);
    await page.getByText('Snoozed prompts (1)').click();
    await page.getByRole('button', { name: 'Bring back' }).click();
    await expect(card).toBeVisible();
    expect((await h.call('intelligence/overview?timeZone=UTC')).body.snoozes).toHaveLength(0);

    await card.getByRole('button', { name: 'Log a moment' }).click();
    await card.getByLabel('What would you like to remember?').fill('Discussed the next prototype');
    await card.getByRole('button', { name: 'Save moment' }).click();
    await expect(card.getByRole('alert')).toBeVisible();
    await expect(card.getByRole('alert')).toContainText('Your note is still here');
    await expect(card.getByLabel('What would you like to remember?')).toHaveValue('Discussed the next prototype');
    await card.getByRole('button', { name: 'Save moment' }).click();
    await expect(page.getByText('Discussed the next prototype')).toBeVisible();
    const count = await h.db.prepare('SELECT COUNT(*) AS count FROM interactions WHERE workspace_id = ? AND contact_id = ? AND summary = ?').bind('test', contactId, 'Discussed the next prototype').first<{ count: number }>();
    expect(count?.count).toBe(1);

    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Dismiss notification' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Dismiss notification' }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: test.info().outputPath('today.png'), fullPage: true });

    await card.getByRole('button', { name: 'Mark Ask Ada about her project as done' }).click();
    await expect(card.getByRole('alert')).toContainText('safe to try again');
    await card.getByRole('button', { name: 'Mark Ask Ada about her project as done' }).click();
    await expect(page.getByRole('heading', { name: "You're caught up" })).toBeVisible();
    const completed = await h.db.prepare('SELECT completed_at FROM reminders WHERE workspace_id = ? AND id = ?').bind('test', reminderId).first<{ completed_at: string | null }>();
    expect(completed?.completed_at).toBeTruthy();
    const interactions = await h.db.prepare('SELECT COUNT(*) AS count FROM interactions WHERE workspace_id = ? AND contact_id = ?').bind('test', contactId).first<{ count: number }>();
    expect(interactions?.count).toBe(2, 'completing a reminder must not create a conversation');
  } finally { await h.close(); }
});
