import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const id = 'dd34bba6-a7d2-4f18-a862-958733f456b5', planId = '231bfaca-77d8-4d98-8d14-4d0ffceceec1', op = 'b8ec7dce-22e5-4270-a20d-33f9ea46a692';
const endpoint = '**/api/connections/' + id + '/plan-publications/' + planId;
const path = `/connections/google/${id}/plans/${planId}`;
type Draft = import('../../packages/domain/src/calendar-publication').PublicationDraft;
const initial = () => ({ epoch: planId, authorization_revision: 1, email: 'owner@example.test', plan_fingerprint: 'b'.repeat(64),
  plan: { public_id: planId, contact_id: 1, contact_name: 'Ana', type: 'meetup', planned_date: '2026-10-20', summary: 'PRIVATE PLAN SUMMARY', completed: false },
  publication: null as null | { id: string; revision: number; status: string; issue: string | null; follow_plan_date: boolean; last_plan_date: string | null; confirmed_at: string | null },
  saved_event_id: null as string | null, write: null as null | { id: string; revision: number; kind: string; status: string; attempts: number; issue: string | null; retry_at: number; can_send: boolean; draft: Draft },
  calendar: { id: 'owned@example.test', summary: 'Everclose', time_zone: 'Europe/Lisbon', access_role: 'owner', primary: false, hidden: false }, remote_draft: null as Draft | null,
  remote_facts: null, preview_fingerprint: 'a'.repeat(64), can_prepare: true, problem: null as string | null });
test.beforeEach(async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { user: null, session: null } }));
});
test('event reviews preserve private notes, show invitation effects and verify an uncertain reply', async ({ page }, info) => {
  let data = initial(), prepared = 0, sent = 0, verified = 0;
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: data });
    const body = route.request().postDataJSON(); prepared++; expect(Object.keys(body).sort()).toEqual(['draft', 'expected_preview_fingerprint', 'operation_id']);
    expect(JSON.stringify(body)).not.toContain('PRIVATE');
    data = { ...data, publication: { id: op, revision: 1, status: 'pending', issue: null, follow_plan_date: false, last_plan_date: null, confirmed_at: null },
      write: { id: body.operation_id, revision: 1, kind: 'create', status: 'pending', attempts: 0, issue: null, retry_at: 0, can_send: true, draft: body.draft } };
    await route.fulfill({ json: { write: data.write } });
  });
  await page.route(endpoint + '/step', async (route) => {
    const body = route.request().postDataJSON(); expect(body.operation_id).toBe(data.write!.id);
    if (body.mode === 'send') { sent++; data.write = { ...data.write!, status: 'unknown', attempts: 1, revision: 2, issue: 'retry' }; await route.abort('failed'); }
    else { verified++; data = { ...data, write: { ...data.write!, status: 'confirmed', revision: 3, can_send: false, issue: null }, publication: { ...data.publication!, status: 'published', revision: 2, confirmed_at: '2026-10-04T10:00:00Z' }, saved_event_id: planId, remote_draft: data.write!.draft }; await route.fulfill({ json: data }); }
  });
  await page.goto(path); await expect(page.getByLabel('Event title')).toHaveValue('meetup with Ana');
  await page.getByLabel('Event title').fill('Coffee with Ana'); await page.getByLabel('Invitee emails').fill('ana@example.test');
  await page.getByRole('button', { name: 'Review event details', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('ana@example.test'); await expect(page.getByRole('alertdialog')).toContainText('Google will send invitations');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save review', exact: true }).click(); expect(prepared).toBe(1); expect(sent).toBe(0);
  await page.getByRole('button', { name: 'Review publishing', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: 'Publish reviewed event', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('reply is unconfirmed'); await expect(page.getByText('Status: unknown', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Event title')).toBeDisabled(); await page.getByRole('button', { name: 'Verify original event', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Published event verified', exact: true })).toBeVisible(); expect(sent).toBe(1); expect(verified).toBe(1); await expect(page.getByLabel('Event title')).toHaveValue('Coffee with Ana');
  await expect(page.getByRole('link', { name: 'Saved event context', exact: true })).toHaveAttribute('href', '/calendar/events/' + planId);
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: info.outputPath('plan-publication-verified.png'), fullPage: true });
});
test('a lost review-save reply retries exactly the same draft and operation ID', async ({ page }) => {
  const data = initial(); let first: object | null = null;
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: data });
    const body = route.request().postDataJSON();
    if (!first) { first = body; return route.abort('failed'); } expect(body).toEqual(first);
    data.write = { id: body.operation_id, revision: 1, kind: 'create', status: 'unknown', attempts: 0, issue: 'retry', retry_at: 0, can_send: true, draft: body.draft };
    await route.fulfill({ json: { write: data.write } });
  });
  await page.goto(path); await page.getByRole('button', { name: 'Review event details', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review save is unconfirmed', exact: true })).toBeVisible(); await expect(page.getByLabel('Event title')).toBeDisabled();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Review save is unconfirmed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry review save', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Retained publication review', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard unsent review', exact: true })).toBeVisible();
});
test('invalid daylight-saving times stay local and a removed event has no publishing action', async ({ page }) => {
  let data = initial(), writes = 0;
  await page.route(endpoint, (route) => { if (route.request().method() !== 'GET') writes++; return route.fulfill({ json: data }); });
  await page.goto(path); await page.getByLabel('All-day event', { exact: true }).uncheck();
  await page.getByLabel('Start', { exact: true }).fill('2026-10-25T01:30:00'); await page.getByLabel('End', { exact: true }).fill('2026-10-25T03:00:00');
  await page.getByRole('button', { name: 'Review event details', exact: true }).click(); await expect(page.getByRole('main').getByRole('alert')).toContainText('occurs twice'); expect(writes).toBe(0);
  data = { ...data, can_prepare: false, problem: 'missing' }; await page.getByRole('button', { name: 'Refresh publication status', exact: true }).click();
  await expect(page.getByText('The known event was not found. It will not be recreated.', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: 'Review event details', exact: true })).toBeDisabled();
});
test('plan selection pages preserve the connection and paginate existing plans', async ({ page }) => {
  await page.route('**/api/plans?*', (route) => { const second = new URL(route.request().url()).searchParams.get('page') === '2'; return route.fulfill({ json: { plans: [{ public_id: planId, contact_name: second ? 'Bruno' : 'Ana', planned_date: '2026-10-20', type: 'meetup' }], pagination: { totalPages: 2 } } }); });
  await page.goto(`/connections/google/${id}/plans`); await expect(page.getByRole('link', { name: 'Ana · meetup', exact: false })).toHaveAttribute('href', path);
  await page.getByRole('button', { name: 'Next', exact: true }).click(); await expect(page.getByRole('link', { name: 'Bruno · meetup', exact: false })).toBeVisible();
});
test('a previously confirmed receipt does not claim that a missing event was freshly verified', async ({ page }) => {
  const data = initial(); data.can_prepare = false; data.problem = 'missing';
  data.publication = { id: op, revision: 2, status: 'missing', issue: 'missing', follow_plan_date: false, last_plan_date: null, confirmed_at: '2026-10-04T10:00:00Z' };
  data.write = { id: op, revision: 3, kind: 'create', status: 'confirmed', attempts: 1, issue: null, retry_at: 0, can_send: false,
    draft: { summary: 'Last reviewed event', location: '', visibility: 'private', start: { date: '2026-10-20', date_time: null, time_zone: null }, end: { date: '2026-10-21', date_time: null, time_zone: null }, attendee_emails: [], follow_plan_date: false } };
  await page.route(endpoint, (route) => route.fulfill({ json: data }));
  await page.route(endpoint + '/step', (route) => { expect(route.request().postDataJSON().mode).toBe('verify'); return route.fulfill({ json: data }); });
  await page.goto(path); await expect(page.getByLabel('Event title')).toHaveValue('Last reviewed event');
  await expect(page.getByRole('heading', { name: 'Published event verified', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Verify original event', exact: true }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText('original event is unavailable');
  await expect(page.getByRole('button', { name: 'Review publishing', exact: true })).toHaveCount(0);
});
