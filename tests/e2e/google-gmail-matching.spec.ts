import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { GmailConnectionReview } from '../../lib/cloud/google-gmail-connection';
import type { GmailCorrespondent, GmailMatchDecision, GmailMatchPage, GmailPersonContext } from '../../packages/domain/src/gmail-matching';

const id = 'dd34bba6-a7d2-4f18-a862-958733f456b5', epoch = 'b5cac8f4-758f-442c-8faa-a36a8915d5f4', generation = '20ce1542-772e-42d4-b65b-2d7fcbacbc40';
const path = '/api/connections/' + id + '/gmail';
const bob = { id: 1, public_id: '51c28a34-63ef-4fd3-81d7-225b226b2f39', name: 'Bob' };
const ana = { id: 2, public_id: 'd8f18c4a-627a-4308-9b01-54d1e6c6f8e3', name: 'Ana' }, marta = { id: 3, public_id: '698d67f0-2f8e-43ed-a54d-af275e207389', name: 'Marta' };
const longEmail = 'new.' + 'sender'.repeat(9) + '@' + 'example'.repeat(7) + '.test';
test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/get-session*', (route) => route.fulfill({ json: { session: null, user: null } }));
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
});
async function fixture(page: Page, options: { loseChoice?: boolean; revokeContext?: boolean; changeCatalog?: boolean } = {}) {
  let ready = false, revision = 0, directoryRevision = 1, connected = true, auth = 1;
  const choices: GmailMatchDecision[] = [], actions: string[] = [], rules = new Map<string, GmailMatchDecision>();
  function connection(): GmailConnectionReview {
    return { epoch, can_preview: connected, connection: { id, email: 'owner@example.test', display_name: 'Fixture mailbox', status: connected ? 'connected' : 'disconnected', revision: 1, authorization_revision: auth },
      source: connected ? { choices: { label_ids: ['INBOX'], own_addresses: ['owner@example.test'], mode: 'review_inbox', past_days: 90, scan_limit: 1000, retain_subject: false },
        settings_revision: 1, generation, coverage: 'scanned', window_start: Date.now() - 90 * 86400000, window_end: Date.now(), last_downloaded_at: new Date().toISOString(), run: null } : null };
  }
  function matching(): GmailMatchPage {
    const rows: GmailCorrespondent[] = [
      { email: 'bob@example.test', messages: 3, latest_at: Date.now() - 1000, candidates: [bob], candidates_more: false, status: 'suggested', linked_person: null },
      { email: 'shared@example.test', messages: 2, latest_at: Date.now() - 2000, candidates: [ana, marta], candidates_more: false, status: 'ambiguous', linked_person: null },
      { email: longEmail, messages: 1, latest_at: Date.now() - 3000, candidates: [], candidates_more: false, status: 'unmatched', linked_person: null },
    ];
    for (const row of rows) { const rule = rules.get(row.email); if (!rule) continue;
      row.status = rule.action === 'exclude' ? 'excluded' : 'linked'; row.linked_person = row.status === 'linked' ? row.candidates.find((person) => person.public_id === rule.target_public_id)! : null;
    }
    return { epoch, authorization_revision: auth, settings_revision: 1, generation, directory_revision: directoryRevision, matching_revision: revision,
      directory_ready: ready, mode: 'review_inbox', correspondents: ready ? rows : [], more: false, next: null };
  }
  await page.route('**' + path, async (route) => { expect(route.request().method()).toBe('GET'); return route.fulfill({ json: connection() }); });
  await page.route('**' + path + '/**', async (route) => {
    const url = new URL(route.request().url()), action = url.pathname.slice(path.length); actions.push(action);
    if (action === '/matches/directory') { ready = true; return route.fulfill({ json: matching() }); }
    if (action === '/matches' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as GmailMatchDecision; choices.push(body);
      if (!rules.has(body.email)) { if (body.action !== 'clear') rules.set(body.email, body); revision++; }
      else if (body.action === 'clear') { rules.delete(body.email); revision++; }
      if (options.loseChoice && choices.length === 1) return route.abort('failed');
      return route.fulfill({ json: { operation_id: body.operation_id, revision, action: body.action, email: body.email, target_public_id: body.target_public_id } });
    }
    if (action === '/matches') {
      if (options.changeCatalog && url.searchParams.has('directory_revision') && ready && !choices.length) directoryRevision++;
      if (url.searchParams.has('directory_revision') && Number(url.searchParams.get('directory_revision')) !== directoryRevision) return route.fulfill({ status: 409, json: { error: 'Contact matching changed. Refresh this review.' } });
      return route.fulfill({ json: matching() });
    }
    if (action === '/people/' + bob.public_id) {
      if (options.revokeContext) { connected = false; auth++; }
      const more = url.searchParams.has('after');
      const messages = (more ? [2] : [0, 1]).map((n) => ({ facts: { id: 'observed_' + n, thread_id: 'thread_' + n, received_at: Date.now() - 1000 - n * 1000,
        direction: 'incoming' as const, participants: [{ email: 'bob@example.test', roles: ['from' as const] }], participants_incomplete: false,
        subject: options.revokeContext ? 'Private email subject must disappear' : null, message_id: null }, linked_addresses: ['bob@example.test'] }));
      const value: GmailPersonContext = { ...matching(), person: bob, messages, more: !more, next: more ? null : JSON.stringify({ at: messages[1].facts.received_at, id: messages[1].facts.id }) };
      return route.fulfill({ json: value });
    }
    throw new Error('Unexpected matching fixture route ' + action);
  });
  return { choices, actions };
}
async function prepare(page: Page) {
  await page.goto('/connections/google/' + id + '/gmail');
  await page.getByRole('button', { name: 'Show correspondence review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Prepare contact matching', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Prepare contact matching', exact: true }).click();
}
test('correspondence review handles explicit identity choices, observed context, exclusions, mobile layout and reload', async ({ page }) => {
  const f = await fixture(page); await prepare(page);
  const select = page.getByLabel('Person for bob@example.test', { exact: true }); await expect(select).toHaveValue('');
  const confirm = page.getByRole('button', { name: 'Confirm person for bob@example.test', exact: true }); await expect(confirm).toBeDisabled();
  expect(f.choices).toHaveLength(0); await select.selectOption(bob.public_id); await confirm.click();
  expect(f.choices[0]).toMatchObject({ action: 'link', email: 'bob@example.test', target_public_id: bob.public_id, expected_generation: generation, expected_directory_revision: 1 });
  await page.getByRole('button', { name: 'Show correspondence for Bob', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Correspondence with Bob', exact: true })).toBeVisible();
  await expect(page.getByText('2 observed messages shown.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Show more correspondence', exact: true }).click();
  await expect(page.getByText('3 observed messages shown.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Person for shared@example.test', { exact: true })).toHaveValue('');
  await page.getByLabel('Person for shared@example.test', { exact: true }).selectOption(marta.public_id);
  await page.getByRole('button', { name: 'Confirm person for shared@example.test', exact: true }).click();
  expect(f.choices[1]).toMatchObject({ target_public_id: marta.public_id, expected_matching_revision: 1 });
  await page.getByRole('button', { name: 'Exclude ' + longEmail, exact: true }).click();
  await expect(page.getByText('Excluded from correspondence', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'test-results/gmail-matching-' + test.info().project.name + '.png', fullPage: true });
  expect(await page.evaluate(() => Object.values(localStorage).some((value) => String(value).includes('bob@example.test')))).toBe(false);
  await page.reload(); await expect(page.getByRole('button', { name: 'Show correspondence review', exact: true })).toBeEnabled();
  await expect(page.getByText('bob@example.test', { exact: true })).toHaveCount(0);
  expect(f.actions.some((action) => action.startsWith('/downloads'))).toBe(false);
});
test('uncertain matching saves retry the identical choice and never default to the first shared-address person', async ({ page }) => {
  const f = await fixture(page, { loseChoice: true }); await prepare(page);
  await page.getByLabel('Person for bob@example.test', { exact: true }).selectOption(bob.public_id);
  await page.getByRole('button', { name: 'Confirm person for bob@example.test', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry saving choice', exact: true }); await expect(retry).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Show correspondence review', exact: true })).toBeDisabled();
  await retry.click(); await expect(page.getByRole('button', { name: 'Show correspondence for Bob', exact: true })).toBeVisible();
  expect(f.choices).toHaveLength(2); expect(f.choices[1]).toEqual(f.choices[0]);
  await expect(page.getByLabel('Person for shared@example.test', { exact: true })).toHaveValue('');
});
test('revoked authorization suppresses private correspondence replies', async ({ page }) => {
  await fixture(page, { revokeContext: true }); await prepare(page);
  await page.getByLabel('Person for bob@example.test', { exact: true }).selectOption(bob.public_id);
  await page.getByRole('button', { name: 'Confirm person for bob@example.test', exact: true }).click();
  await page.getByRole('button', { name: 'Show correspondence for Bob', exact: true }).click();
  await expect(page.getByText('This connection needs review', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Correspondence review', exact: true })).toHaveCount(0);
  await expect(page.getByText('Private email subject must disappear', { exact: true })).toHaveCount(0);
  await expect(page.getByText('bob@example.test', { exact: true })).toHaveCount(0);
});
test('contact changes during browser authorization checks suppress earlier candidate suggestions', async ({ page }) => {
  await fixture(page, { changeCatalog: true }); await prepare(page);
  await expect(page.getByRole('alert').filter({ hasText: 'Contact matching changed' })).toBeVisible();
  await expect(page.getByLabel('Person for bob@example.test', { exact: true })).toHaveCount(0);
});
