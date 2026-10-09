import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { GmailDownloadRun, GmailMessageFacts, GmailSourceReview } from '../../packages/domain/src/gmail';

const id = 'dd34bba6-a7d2-4f18-a862-958733f456b5', epoch = 'b5cac8f4-758f-442c-8faa-a36a8915d5f4';
const connection = { id, email: 'owner@example.test', display_name: 'Gmail Owner', status: 'connected', revision: 1, authorization_revision: 1 };
const path = '/api/connections/' + id + '/gmail', generation = '20ce1542-772e-42d4-b65b-2d7fcbacbc40';
test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
});
async function fixture(page: Page, options: { loseStart?: boolean; loseSchedule?: boolean; revokeDuringMessages?: boolean } = {}) {
  let source: GmailSourceReview | null = null, canPreview = true, authRevision = 1;
  const calls: Array<{ action: string; body: Record<string, unknown> | null }> = [];
  const facts: GmailMessageFacts[] = [0, 1, 2].map((index) => ({ id: 'message_' + index, thread_id: 'thread_' + index,
    received_at: Date.now() - 1000 - index * 1000, direction: 'incoming', participants: [{ email: 'friend@example.test', roles: ['from'] }],
    participants_incomplete: false, subject: options.revokeDuringMessages ? 'Private subject must disappear' : null, message_id: null }));
  await page.route('**' + path, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { epoch, can_preview: canPreview, connection: { ...connection, authorization_revision: authRevision, status: canPreview ? 'connected' : 'disconnected' }, source: canPreview ? source : null } });
    calls.push({ action: 'preview', body: route.request().postDataJSON() });
    return route.fulfill({ json: { email: connection.email, labels: [{ id: 'INBOX', name: 'Inbox', type: 'system' }, { id: 'SENT', name: 'Sent', type: 'system' }] } });
  });
  await page.route('**' + path + '/**', async (route) => {
    const url = new URL(route.request().url()), action = url.pathname.slice(path.length);
    const body = route.request().method() === 'GET' ? null : route.request().postDataJSON();
    calls.push({ action, body });
    if (action === '/settings') {
      source = { settings_revision: (source?.settings_revision ?? 0) + 1, choices: body.choices, generation: null,
        coverage: 'none', window_start: null, window_end: null, last_downloaded_at: null, run: null,
        schedule: { enabled: false, interval: 86400, revision: (source?.schedule.revision ?? -1) + 1, next_at: 0, repair_required: false } };
      return route.fulfill({ json: source });
    }
    if (action === '/schedule') {
      expect(body.expected_settings_revision).toBe(source!.settings_revision); expect(body.expected_schedule_revision).toBe(source!.schedule.revision);
      source!.schedule = { enabled: body.enabled, interval: body.interval, revision: source!.schedule.revision + 1, next_at: body.enabled ? Date.now() : 0, repair_required: false };
      if (options.loseSchedule && calls.filter((call) => call.action === action).length === 1) return route.abort('failed');
      return route.fulfill({ json: source });
    }
    if (action === '/downloads') {
      if (options.loseStart && calls.filter((call) => call.action === action).length === 1) return route.abort('failed');
      const run: GmailDownloadRun = { id: body.operation_id, mode: body.mode, phase: 'profile', status: 'active', pages: 0, processed: 0, limited: false, retry_at: 0, issue: null };
      source!.run = run; return route.fulfill({ json: run });
    }
    if (action.endsWith('/step')) {
      source!.run = { ...source!.run!, phase: 'publish', status: 'complete', pages: 2, processed: 3 };
      source!.generation = generation; source!.coverage = 'scanned'; source!.last_downloaded_at = new Date().toISOString();
      return route.fulfill({ json: source!.run });
    }
    if (action === '/messages') {
      expect(url.searchParams.get('generation')).toBe(generation);
      if (options.revokeDuringMessages) { canPreview = false; authRevision++; }
      const more = url.searchParams.has('after');
      return route.fulfill({ json: { generation, coverage: 'scanned', more: !more, next: more ? null : JSON.stringify([facts[1].received_at, facts[1].id]),
        messages: (more ? facts.slice(2) : facts.slice(0, 2)).map((item) => ({ facts: item, observed_at: Date.now() })) } });
    }
    if (route.request().method() === 'DELETE') { source!.run!.status = 'cancelled'; return route.fulfill({ json: source!.run }); }
    throw new Error('Unexpected fixture Gmail route ' + action);
  });
  return { calls };
}
async function saveChoices(page: Page) {
  await page.goto('/connections/google/' + id + '/gmail');
  await page.getByRole('button', { name: 'Preview mailbox labels', exact: true }).click();
  await page.getByLabel('Use label Inbox', { exact: true }).check();
  await expect(page.getByLabel('Retain email subjects', { exact: true })).not.toBeChecked();
  await page.getByLabel('Your other email addresses', { exact: true }).fill('alias@example.test');
  await page.getByLabel('Past days to retain', { exact: true }).fill('45');
  await page.getByRole('button', { name: 'Save download choices', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start full metadata scan', exact: true })).toBeEnabled();
}
test('reviewed metadata downloads are explicit, durable, paged, mobile accessible and discarded from view on reload', async ({ page }) => {
  const f = await fixture(page); await saveChoices(page);
  const save = f.calls.find((call) => call.action === '/settings')!.body!;
  expect(save.choices).toEqual({ label_ids: ['INBOX'], own_addresses: ['alias@example.test', 'owner@example.test'], mode: 'existing_people', past_days: 45, scan_limit: 1000, retain_subject: false });
  expect(f.calls.filter((call) => call.action === '/downloads')).toHaveLength(0);
  await page.getByRole('button', { name: 'Start full metadata scan', exact: true }).click();
  const advance = page.getByRole('button', { name: 'Continue download', exact: true }); await expect(advance).toBeEnabled();
  expect(f.calls.some((call) => call.action.endsWith('/step'))).toBe(false);
  await page.reload(); await expect(advance).toBeEnabled(); expect(f.calls.filter((call) => call.action === '/downloads')).toHaveLength(1);
  await advance.click(); await expect(page.getByText('Download complete · 2 pages · 3 messages processed.', { exact: true })).toBeVisible();
  expect(f.calls.some((call) => call.action === '/messages')).toBe(false);
  await page.getByRole('button', { name: 'Show downloaded metadata', exact: true }).click();
  await expect(page.getByText('2 messages shown.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Show more messages', exact: true }).click();
  await expect(page.getByText('3 messages shown.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'test-results/gmail-downloads-' + test.info().project.name + '.png', fullPage: true });
  expect(await page.evaluate(() => Object.values(localStorage).some((value) => String(value).includes('friend@example.test')))).toBe(false);
  await page.reload(); await expect(page.getByRole('button', { name: 'Show downloaded metadata', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Downloaded message metadata', exact: true })).toHaveCount(0);
  await page.getByLabel('Retain email subjects', { exact: true }).check();
  await page.getByRole('button', { name: 'Save download choices', exact: true }).click();
  const confirmation = page.getByRole('group', { name: 'Confirm changed Gmail choices', exact: true }); await expect(confirmation).toBeVisible();
  expect(f.calls.filter((call) => call.action === '/settings')).toHaveLength(1);
  await page.getByRole('button', { name: 'Replace download choices', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show downloaded metadata', exact: true })).toBeDisabled();
  expect(f.calls.filter((call) => call.action === '/settings')).toHaveLength(2);
});
test('a lost start response retries the frozen operation and never starts an unreviewed scan', async ({ page }) => {
  const f = await fixture(page, { loseStart: true }); await saveChoices(page);
  await page.getByRole('button', { name: 'Start full metadata scan', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry starting download', exact: true }); await expect(retry).toBeEnabled();
  await expect(page.getByLabel('Past days to retain', { exact: true })).toBeDisabled();
  await retry.click(); await expect(page.getByRole('button', { name: 'Continue download', exact: true })).toBeEnabled();
  const starts = f.calls.filter((call) => call.action === '/downloads'); expect(starts).toHaveLength(2); expect(starts[1].body).toEqual(starts[0].body);
  expect(f.calls.some((call) => call.action.endsWith('/step'))).toBe(false);
  await page.getByRole('button', { name: 'Cancel download', exact: true }).click();
  await expect(page.getByText('Download cancelled', { exact: false })).toBeVisible();
});
test('changed authorization after message reads suppresses subjects, participant data and the source review', async ({ page }) => {
  await fixture(page, { revokeDuringMessages: true }); await saveChoices(page);
  await page.getByRole('button', { name: 'Start full metadata scan', exact: true }).click();
  await page.getByRole('button', { name: 'Continue download', exact: true }).click();
  await page.getByRole('button', { name: 'Show downloaded metadata', exact: true }).click();
  await expect(page.getByText('This connection needs review', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Gmail metadata downloads', exact: true })).toHaveCount(0);
  await expect(page.getByText('Private subject must disappear', { exact: true })).toHaveCount(0);
  await expect(page.getByText('friend@example.test', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Mailbox labels', exact: true })).toHaveCount(0);
});

test('automatic Gmail checks require explicit saved choices, survive reload and reset after reviewing changed retention', async ({ page }) => {
  const f = await fixture(page); await saveChoices(page);
  const frequency = page.getByLabel('Refresh frequency', { exact: true });
  await expect(frequency).toHaveValue('manual'); expect(f.calls.filter((call) => call.action === '/schedule')).toHaveLength(0);
  await frequency.selectOption('86400'); await page.getByRole('button', { name: 'Enable daily email refresh', exact: true }).click();
  await expect(page.getByText('Saved setting: Daily checks.', { exact: true })).toBeVisible();
  expect(f.calls.find((call) => call.action === '/schedule')!.body).toEqual({ enabled: true, interval: 86400, expected_epoch: epoch,
    expected_authorization_revision: 1, expected_settings_revision: 1, expected_schedule_revision: 0 });
  await page.reload(); await expect(frequency).toHaveValue('86400'); expect(f.calls.filter((call) => call.action === '/schedule')).toHaveLength(1);
  await page.getByLabel('Past days to retain', { exact: true }).fill('30');
  await expect(page.getByRole('button', { name: 'Enable daily email refresh', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save download choices', exact: true }).click();
  await expect(page.getByText('turns automatic refresh off', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Replace download choices', exact: true }).click();
  await expect(frequency).toHaveValue('manual'); await frequency.selectOption('3600');
  await page.getByRole('button', { name: 'Enable hourly email refresh', exact: true }).click();
  await expect(page.getByText('Saved setting: Hourly checks.', { exact: true })).toBeVisible();
  await frequency.selectOption('manual'); await page.getByRole('button', { name: 'Save manual email refresh', exact: true }).click();
  await expect(page.getByText('Saved setting: Manual refresh only.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'test-results/gmail-recurring-' + test.info().project.name + '.png', fullPage: true });
});

test('a lost Gmail schedule reply reloads the authoritative setting without sending another opt-in', async ({ page }) => {
  const f = await fixture(page, { loseSchedule: true }); await saveChoices(page);
  await page.getByLabel('Refresh frequency', { exact: true }).selectOption('86400');
  await page.getByRole('button', { name: 'Enable daily email refresh', exact: true }).click();
  await expect(page.getByText('Saved setting: Daily checks.', { exact: true })).toBeVisible();
  expect(f.calls.filter((call) => call.action === '/schedule')).toHaveLength(1);
  await page.reload(); await expect(page.getByLabel('Refresh frequency', { exact: true })).toHaveValue('86400');
  expect(f.calls.filter((call) => call.action === '/schedule')).toHaveLength(1);
});
