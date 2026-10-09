import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCloudHarness } from '../helpers/cloud-harness.ts';
import { googleActor as actor } from '../helpers/google-contact-fixture.ts';
import { selectedCalendar, calendarEnvironment as environment, calendarId, calendarEvent } from '../helpers/google-calendar-fixture.ts';

async function fixture(page: Page) {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
  const h = await createCloudHarness(), c = await selectedCalendar(h);
  const ana = (await h.call('contacts', { method: 'POST', body: { name: 'Ana One', notes: 'Private relationship notes' } })).body.contact;
  const sam = (await h.call('contacts', { method: 'POST', body: { name: 'Sam Two' } })).body.contact;
  const plan = (await h.call('plans', { method: 'POST', body: { contact_id: sam.id, type: 'meetup', summary: 'Personal plan with Sam', planned_date: '2026-10-10' } })).body.plan;
  const run = await h.eventDownloads.startEventDownload(h.db, actor, environment, c.connection.id, { ...c.body, operation_id: crypto.randomUUID() });
  const items = [
    { ...calendarEvent('earlier'), summary: 'Earlier reviewed context', start: { dateTime: '2026-11-03T12:00:00Z', timeZone: 'UTC' }, end: { dateTime: '2026-11-03T13:00:00Z', timeZone: 'UTC' } },
    { ...calendarEvent('linked'), summary: 'Reviewed group meeting', location: 'Sala ' + 'L'.repeat(160) },
    { ...calendarEvent('span'), summary: 'Multi-day gathering', start: { date: '2026-09-29' }, end: { date: '2026-10-06' } },
    { ...calendarEvent('private'), summary: 'Hidden provider secret', visibility: 'private' },
    { ...calendarEvent('cancelled'), summary: 'Cancelled reunião ' + 'L'.repeat(80), status: 'cancelled' },
  ];
  await h.eventDownloads.advanceEventDownload(h.db, actor, environment, c.connection.id, run.id, async () => Response.json({ items }));
  const saved = [];
  for (const item of items) {
    const preview = await h.eventLinks.eventLinkPreview(h.db, actor, c.connection.id, new URLSearchParams({ calendar_id: calendarId, event_id: item.id }));
    const event = (await h.eventLinks.linkCalendarEvent(h.db, actor, c.connection.id, { operation_id: crypto.randomUUID(), expected_epoch: preview.epoch,
      expected_authorization_revision: preview.authorization_revision, expected_selection_revision: preview.selection_revision, expected_generation: preview.generation,
      calendar_id: calendarId, event_id: item.id, expected_event_revision: null, contact_ids: item.id === 'private' ? [] : [ana.id], plan_ids: item.id === 'linked' ? [plan.id] : [] })).event!;
    saved.push(event);
  }
  await h.providers.disconnectGoogleConnection(h.db, actor, environment, c.connection.id, c.connection.revision, async () => new Response(null, { status: 200 }));
  for (const pattern of ['**/api/calendar?*', '**/api/calendar/events?*', '**/api/contacts/*?*']) await page.route(pattern, async (route) => {
    const request = route.request(), url = new URL(request.url());
    const result = await h.call(url.pathname.slice(5) + url.search, { method: request.method() });
    await route.fulfill({ status: result.status, json: result.body });
  });
  return { h, ana, sam, plan, saved };
}

test('Agenda and month show saved meetings once, filter all linked people, preserve source dates and keep cancellations read-only', async ({ page }, info) => {
  test.setTimeout(60_000); const f = await fixture(page), errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('/calendar'); await page.locator('#calendar-month').fill('2026-10');
    if (info.project.name === 'chromium-desktop') await page.getByRole('button', { name: 'Agenda', exact: true }).click();
    const group = page.getByRole('article', { name: 'Reviewed group meeting', exact: true });
    await expect(group).toBeVisible(); await expect(page.getByRole('article')).toHaveCount(5);
    await expect(group).toContainText('Europe/Lisbon'); await expect(group).toContainText('GMT+1');
    await expect(group).toContainText('Source review required'); await expect(group).toContainText('Last observed');
    await expect(group.getByRole('link', { name: /Personal plan with Sam/ })).toHaveAttribute('href', '/contacts/' + f.sam.id);
    await expect(page.getByRole('article', { name: 'Busy', exact: true })).toContainText('Private details were not saved.');
    await expect(page.getByText('Hidden provider secret')).toHaveCount(0);
    const cancelled = page.getByRole('article', { name: 'Cancelled event', exact: true }); await expect(cancelled).toContainText('Cancelled meeting');
    await expect(cancelled.getByRole('button')).toHaveCount(0); await expect(cancelled.getByRole('link', { name: 'Meeting link', exact: true })).toHaveCount(0);
    if (info.project.name === 'chromium-mobile') await page.getByRole('button', { name: /Filters/ }).click();
    await page.getByLabel('Filter by contact', { exact: true }).selectOption(String(f.sam.id));
    await expect(group).toBeVisible(); await expect(page.getByRole('article')).toHaveCount(2);
    await page.getByRole('button', { name: 'Google meetings', exact: true }).click(); await expect(group).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Personal plan with Sam', exact: true })).toBeVisible();
    await page.reload(); if (info.project.name === 'chromium-mobile') await page.getByRole('button', { name: /Filters/ }).click();
    await expect(page.getByRole('button', { name: 'Google meetings', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Reset filters', exact: true }).click(); await expect(group).toBeVisible();
    await page.getByLabel('Show completed', { exact: true }).uncheck(); await expect(cancelled).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('calendar-source-agenda.png'), fullPage: true });
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: /^Friday, October 2,/ }).click();
    const aside = page.locator('aside'); await expect(aside.getByRole('article', { name: 'Multi-day gathering', exact: true })).toBeVisible();
    await expect(aside).toContainText('All day');
    await page.getByRole('button', { name: /^Tuesday, October 6,/ }).click(); await expect(aside.getByRole('article', { name: 'Multi-day gathering', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
    expect((await f.h.db.prepare('SELECT COUNT(*) n FROM interactions').first<{ n: number }>())!.n).toBe(0);
    expect((await f.h.db.prepare('SELECT completed_at FROM plans WHERE id = ?').bind(f.plan.id).first<{ completed_at: string | null }>())!.completed_at).toBeNull();
  } finally { await f.h.close(); }
});

test('A person profile previews three saved contexts including a current plan owner and recovers a failed preview', async ({ page }, info) => {
  test.setTimeout(60_000); test.skip(process.env.BONDS_E2E_CLOUD_UI !== 'true', 'Profile cards require a cloud UI build.');
  const f = await fixture(page); let first = true;
  try {
    await page.route('**/api/calendar/events?*', async (route) => {
      const params = new URL(route.request().url()).searchParams;
      expect(params.get('limit')).toBe('3'); expect(params.get('contact_id')).toBe(String(f.ana.id));
      if (first) { first = false; await route.fulfill({ status: 503, json: { error: 'Saved meetings temporarily unavailable' } }); return; }
      const result = await f.h.call('calendar/events?' + params); await route.fulfill({ status: result.status, json: result.body });
    });
    await page.goto('/contacts/' + f.ana.id); await expect(page.getByRole('heading', { name: 'Saved meetings', exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Saved meetings temporarily unavailable' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry saved meetings' }).click(); await expect(page.getByRole('article')).toHaveCount(3);
    await expect(page.getByRole('article', { name: 'Reviewed group meeting', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'All saved meetings for this person', exact: true })).toHaveAttribute('href', '/calendar/events?contact_id=' + f.ana.id);
    await expect(page.getByRole('heading', { name: 'Relationship brief', exact: true })).toBeHidden();
    await expect(page.getByText('Conversation suggestions', { exact: true })).toBeVisible();
    await expect(page.getByText('Private relationship notes', { exact: true })).toBeVisible();
    // Retry scrolls to the lower context card. Inspect the stable overview
    // viewport rather than a disclosure passing beneath the sticky section bar.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page).toHaveTitle(/Everclose/);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('person-source-context.png'), fullPage: true });
    // The group's plan links Sam even though the explicit person link is Ana.
    await page.unroute('**/api/calendar/events?*');
    await page.route('**/api/calendar/events?*', async (route) => {
      const params = new URL(route.request().url()).searchParams;
      expect(params.get('contact_id')).toBe(String(f.sam.id)); const result = await f.h.call('calendar/events?' + params); await route.fulfill({ status: result.status, json: result.body });
    });
    await page.getByRole('article', { name: 'Reviewed group meeting', exact: true }).getByRole('link', { name: /Personal plan with Sam/ }).click();
    await expect(page.getByRole('heading', { name: 'Sam Two', exact: true })).toBeVisible(); await expect(page.getByRole('article')).toHaveCount(1);
    await expect(page.getByRole('article', { name: 'Reviewed group meeting', exact: true })).toBeVisible();
  } finally { await f.h.close(); }
});

test('Calendar reports bounded or unplaced source context with a path to all saved meetings', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
  await page.route('**/api/calendar?*', (route) => route.fulfill({ json: { events: [], truncated: false, source_events_available: true, source_truncated: true, source_date_uncertain: true } }));
  await page.goto('/calendar'); await expect(page.getByText('More saved meetings are available', { exact: false })).toBeVisible();
  await expect(page.getByText('Some saved meetings have no reliable date', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review all saved context', exact: true })).toHaveAttribute('href', '/calendar/events');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
