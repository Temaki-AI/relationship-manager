import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { addDays, format } from 'date-fns';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test('calendar is agenda-first on phones and supports reminder capture and completion', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Run against a preview built with NEXT_PUBLIC_AUTH_MODE=google.');
  const h = await createCloudHarness();
  try {
    const day = format(addDays(new Date(), 2), 'yyyy-MM-dd');
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada Lovelace' } })).body.contact;
    const reminder = (await h.call('reminders', {
      method: 'POST',
      body: { contact_id: contact.id, title: 'Ask Ada about her project', remind_at: new Date(`${day}T12:00`).toISOString() },
    })).body.reminder;
    const plan = (await h.call('plans', {
      method: 'POST',
      body: { contact_id: contact.id, type: 'call', planned_date: day, summary: 'Call Ada', notes: null },
    })).body.plan;

    await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    let loseFirstCreateResponse = true;
    for (const pattern of ['**/api/calendar?*', '**/api/contacts?*', '**/api/reminders', '**/api/reminders/*', '**/api/plans/*']) {
      await page.route(pattern, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const endpoint = `${url.pathname.slice('/api/'.length)}${url.search}`;
        const result = await h.call(endpoint, {
          method: request.method(),
          body: request.postData() ? request.postDataJSON() : undefined,
          key: request.headers()['idempotency-key'] || null,
        });
        if (endpoint === 'reminders' && request.method() === 'POST' && loseFirstCreateResponse) {
          loseFirstCreateResponse = false;
          await route.abort('failed');
          return;
        }
        await route.fulfill({ status: result.status, json: result.body });
      });
    }

    await page.goto('/calendar');
    await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible();
    const mobile = testInfo.project.name === 'chromium-mobile';
    await expect(page.getByRole('button', { name: 'Agenda' })).toHaveAttribute('aria-pressed', String(mobile));
    await expect(page.getByRole('button', { name: 'Month', exact: true })).toHaveAttribute('aria-pressed', String(!mobile));
    if (!mobile) await page.getByRole('button', { name: 'Agenda' }).click();
    await expect(page.getByRole('button', { name: /Filters/ })).toBeVisible({ visible: mobile });
    await page.locator('#calendar-month').fill(day.slice(0, 7));
    await expect(page.getByRole('heading', { name: 'Ask Ada about her project' })).toBeVisible();

    await page.getByRole('button', { name: 'Mark reminder Ask Ada about her project done' }).click();
    await expect(page.getByRole('button', { name: 'Mark reminder Ask Ada about her project done' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Mark plan Call Ada done' }).click();
    await expect(page.getByText('Plan completed and added to history')).toBeVisible();
    const savedReminder = await h.db.prepare('SELECT completed_at FROM reminders WHERE workspace_id = ? AND id = ?')
      .bind('test', reminder.id).first<{ completed_at: string | null }>();
    const savedPlan = await h.db.prepare('SELECT completed_at FROM plans WHERE workspace_id = ? AND id = ?')
      .bind('test', plan.id).first<{ completed_at: string | null }>();
    expect(savedReminder?.completed_at).toBeTruthy();
    expect(savedPlan?.completed_at).toBeTruthy();
    const history = await h.db.prepare('SELECT COUNT(*) AS count FROM interactions WHERE workspace_id = ? AND contact_id = ?')
      .bind('test', contact.id).first<{ count: number }>();
    expect(history?.count).toBe(1, 'only completing a plan creates history');

    await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
    await page.getByLabel('What should we remind you?').fill('Send Ada a note');
    await page.getByLabel('Date and time').fill(`${day}T15:30`);
    await page.getByRole('button', { name: 'Ada Lovelace', exact: true }).click();
    const formAxe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(formAxe.violations).toEqual([]);
    await page.getByRole('button', { name: 'Save reminder' }).click();
    await expect(page.getByText(/Could not confirm the reminder/)).toBeVisible();
    await page.getByRole('button', { name: 'Save reminder' }).click();
    await expect(page.getByRole('heading', { name: 'Send Ada a note' })).toBeVisible();
    const created = await h.db.prepare('SELECT COUNT(*) AS count FROM reminders WHERE workspace_id = ? AND title = ?')
      .bind('test', 'Send Ada a note').first<{ count: number }>();
    expect(created?.count).toBe(1);

    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await page.getByRole('button', { name: 'Add reminder for this day' }).click();
    await expect(page.getByLabel('Date and time')).toHaveValue(`${day}T09:00`);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Agenda' }).click();

    if (mobile) await page.getByRole('button', { name: /Filters/ }).click();
    await page.getByRole('searchbox', { name: 'Search calendar' }).fill('Ada');
    await page.reload();
    if (mobile) await page.getByRole('button', { name: /Filters/ }).click();
    await expect(page.getByRole('searchbox', { name: 'Search calendar' })).toHaveValue('Ada');
    await expect(page.getByRole('button', { name: 'Agenda' })).toHaveAttribute('aria-pressed', 'true');
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('calendar-agenda.png'), fullPage: true });
  } finally { await h.close(); }
});
