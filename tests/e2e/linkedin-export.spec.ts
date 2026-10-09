import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const header = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On';
function csv(profile: string, email: string, company = 'Original company', first = 'Export', last = 'Ana') {
  return `${header}\n${first},${last},${profile},${email},${company},Engineer,03 Oct 2026\n`;
}
async function upload(page: Page, text: string) {
  const input = page.getByLabel('LinkedIn Connections.csv', { exact: true }); await expect(input).toBeEnabled();
  await input.setInputFiles({ name: 'Connections.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
  await page.getByRole('button', { name: 'Review row 1', exact: true }).click();
}
async function confirm(page: Page) {
  await page.getByRole('button', { name: 'Import reviewed row', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Import this reviewed connection?' }).getByRole('button', { name: 'Confirm row import', exact: true }).click();
}

test('a reviewed LinkedIn export creates a person and retains all exported source context on mobile and desktop', async ({ page }, info) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  const profile = `linkedin.com/in/csv-create-${crypto.randomUUID()}`;
  await page.goto('/connections/linkedin/import'); await upload(page, csv(profile, 'csv@example.test'));
  await page.getByRole('radio', { name: 'Create a new person', exact: true }).check();
  await page.getByLabel('New person name', { exact: true }).fill('My reviewed person');
  await page.getByRole('checkbox', { name: 'Add the exported email as a contact method' }).check();
  await confirm(page);
  await expect(page.getByRole('link', { name: 'Open saved person and source details', exact: true })).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze(); expect(accessibility.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('linkedin-export-review.png') });
  await page.getByRole('link', { name: 'Open saved person and source details', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sources · My reviewed person');
  const card = page.getByRole('article'); await expect(card.getByLabel('Position on LinkedIn', { exact: true })).toHaveValue('Engineer');
  await expect(card.getByLabel('Connection date in export on LinkedIn', { exact: true })).toHaveValue('03 Oct 2026');
  await expect(card.getByText('Original: Export Ana', { exact: true })).toBeVisible();
});

test('export attachment and reimport keep one person, preferred email and private history while preserving original source facts', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  const name = `My CSV person ${crypto.randomUUID()}`, profile = `linkedin.com/in/csv-attach-${crypto.randomUUID()}`;
  const created = await page.request.post('/api/contacts', { headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { name, email: 'preferred@example.test', notes: 'Private relationship history' } });
  const person = (await created.json()).contact;
  await page.goto('/connections/linkedin/import'); await upload(page, csv(profile, 'added@example.test'));
  await page.getByRole('radio', { name: 'Attach to an existing person', exact: true }).check();
  await page.getByLabel('Find an Everclose person', { exact: true }).fill(name);
  await expect(page.getByRole('option', { name: `${name} · preferred@example.test`, exact: true })).toBeAttached();
  await page.getByLabel('Person to attach', { exact: true }).selectOption(String(person.id));
  await expect(page.getByRole('checkbox', { name: 'Replace the person name with this exported name' })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Add the exported email as a contact method' }).check(); await confirm(page);
  await expect(page.getByRole('link', { name: 'Open saved person and source details', exact: true })).toBeVisible();
  await upload(page, csv(profile, 'later@example.test', 'Updated company', 'New', 'Export name'));
  await page.getByRole('button', { name: 'Review linked person', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Replace the person name with this exported name' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Add the exported email as a contact method' })).not.toBeChecked();
  await confirm(page); await expect(page.getByRole('link', { name: 'Open saved person and source details', exact: true })).toBeVisible();
  const current = (await (await page.request.get(`/api/contacts/${person.id}`)).json()).contact;
  expect(current.name).toBe(name); expect(current.email).toBe('preferred@example.test'); expect(current.notes).toBe('Private relationship history'); expect(JSON.parse(current.contact_methods)).toHaveLength(2);
  const sources = (await (await page.request.get(`/api/contacts/${person.id}/sources`)).json()).sources; expect(sources).toHaveLength(1);
  const facts = JSON.parse(sources[0].fields); expect(facts.company.original_value).toBe('Original company'); expect(facts.company.observed_value).toBe('Updated company');
  expect(facts.email.observed_value).toBe('later@example.test'); expect(facts.email.applied_value).toBe('added@example.test');
});

test('an uncertain export row survives tab reload and retries identical body and key without creating another person', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { password: 'bonds-e2e-account-password' } });
  const profile = `linkedin.com/in/csv-retry-${crypto.randomUUID()}`, requests: Array<{ body: string | null; key: string }> = []; let lose = true;
  await page.route('**/api/sources/linkedin/import', async (route) => {
    requests.push({ body: route.request().postData(), key: route.request().headers()['idempotency-key'] });
    const response = await route.fetch();
    if (lose) { lose = false; await route.fulfill({ status: 503, json: { error: 'The saved reply was not received.' } }); }
    else await route.fulfill({ response });
  });
  await page.goto('/connections/linkedin/import'); await upload(page, csv(profile, 'retry@example.test'));
  await page.getByRole('radio', { name: 'Create a new person', exact: true }).check(); await confirm(page);
  await expect(page.getByRole('heading', { name: 'Unconfirmed row', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name: 'Retry unchanged row', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry unchanged row', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open saved person and source details', exact: true })).toBeVisible();
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('everclose:linkedin-row:')).length)).toBe(0);
  const target = await page.getByRole('link', { name: 'Open saved person and source details', exact: true }).getAttribute('href');
  const sources = (await (await page.request.get(`/api${target}`)).json()).sources; expect(sources).toHaveLength(1); expect(sources[0].revision).toBe(1);
});
