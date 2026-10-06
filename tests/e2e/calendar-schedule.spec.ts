import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { addDays, addMonths, format, startOfMonth } from 'date-fns';
import { createCloudHarness } from '../helpers/cloud-harness.ts';

test('calendar reschedules across months, retries the same date and preserves a conflicted draft', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Use a Google-mode preview with disposable routed storage.');
  const h = await createCloudHarness();
  try {
    const day = format(addDays(new Date(), 2), 'yyyy-MM-dd'), next = format(addMonths(startOfMonth(new Date()), 1), 'yyyy-MM-dd');
    const person = (await h.call('contacts', { method: 'POST', body: { name: 'Calendar Schedule QA' } })).body.contact;
    const reminder = (await h.call('reminders', { method: 'POST', body: { contact_id: person.id, title: 'Check in QA', notes: 'Keep this reminder note', remind_at: new Date(`${day}T09:00`).toISOString() } })).body.reminder;
    const plan = (await h.call('plans', { method: 'POST', body: { contact_id: person.id, type: 'call', summary: 'Catch up QA', notes: 'Original plan note', planned_date: day } })).body.plan;
    await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
    await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
    const dateBodies: string[] = [];
    let loseFirstDateReply = true;
    for (const pattern of ['**/api/calendar?*', '**/api/reminders/*', '**/api/plans/*']) {
      await page.route(pattern, async (route) => {
        const request = route.request(), url = new URL(request.url()), endpoint = `${url.pathname.slice('/api/'.length)}${url.search}`;
        const body = request.postData() ? request.postDataJSON() : undefined;
        const result = await h.call(endpoint, { method: request.method(), body });
        if (endpoint === `reminders/${reminder.id}` && body?.calendar_schedule) {
          dateBodies.push(request.postData()!);
          if (loseFirstDateReply) { loseFirstDateReply = false; await route.abort('failed'); return; }
        }
        await route.fulfill({ status: result.status, json: result.body });
      });
    }
    await page.goto('/calendar');
    await page.getByRole('button', { name: 'Agenda', exact: true }).click();
    await page.locator('#calendar-month').fill(day.slice(0, 7));
    await page.getByRole('button', { name: 'Reschedule reminder Check in QA', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Reschedule reminder' });
    await dialog.getByLabel('New reminder date and time').fill(`${next}T16:30`);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('calendar-reschedule-dialog.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Save new date' }).click();
    await expect(dialog.getByText(/date change is unconfirmed/)).toBeVisible();
    await expect(dialog.getByLabel('New reminder date and time')).toBeDisabled();
    await dialog.getByRole('button', { name: 'Retry unchanged date change' }).click();
    await expect(dialog).toHaveCount(0);
    expect(dateBodies).toHaveLength(2); expect(dateBodies[1]).toBe(dateBodies[0]);
    await expect(page.locator('#calendar-month')).toHaveValue(next.slice(0, 7));
    const savedReminder = await h.db.prepare('SELECT title, notes, remind_at, completed_at FROM reminders WHERE id = ?').bind(reminder.id).first<{ title: string; notes: string; remind_at: string; completed_at: null }>();
    expect(savedReminder).toEqual({ title: 'Check in QA', notes: 'Keep this reminder note', remind_at: new Date(`${next}T16:30`).toISOString(), completed_at: null });

    await page.locator('#calendar-month').fill(day.slice(0, 7));
    await page.getByRole('button', { name: 'Reschedule plan Catch up QA', exact: true }).click();
    const planDialog = page.getByRole('alertdialog', { name: 'Reschedule plan' });
    await planDialog.getByLabel('New plan date').fill(next);
    await h.call(`plans/${plan.id}`, { method: 'PATCH', body: { notes: 'New private plan note' } });
    await planDialog.getByRole('button', { name: 'Save new date' }).click();
    await expect(planDialog.getByText(/changed after you opened/)).toBeVisible();
    await planDialog.getByRole('button', { name: 'Review current event' }).click();
    await expect(planDialog.getByLabel('New plan date')).toHaveValue(next, 'the proposed date survives conflict review');
    await planDialog.getByRole('button', { name: 'Save new date' }).click();
    await expect(planDialog).toHaveCount(0);
    const savedPlan = await h.db.prepare('SELECT type, summary, notes, planned_date, completed_at FROM plans WHERE id = ?').bind(plan.id).first();
    expect(savedPlan).toEqual({ type: 'call', summary: 'Catch up QA', notes: 'New private plan note', planned_date: next, completed_at: null });
    expect((await h.db.prepare('SELECT COUNT(*) count FROM interactions').first<{ count: number }>())?.count).toBe(0);
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reschedule plan Catch up QA', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('calendar-rescheduled-month.png'), fullPage: true });
  } finally { await h.close(); }
});
