import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

function file(text: string, name = 'people.csv') {
  const form = new FormData();
  form.set('file', new File([text], name));
  return form;
}
type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
const act = (h: Harness, id: string, action: string, extra = {}) => h.call(`import/jobs/${id}`, { method: 'POST', body: { action, ...extra } });

test('cloud imports preview every row and require decisions before saving contacts', async () => {
  const h = await createCloudHarness();
  try {
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    const source = 'Name,Email,Last Contacted\nAda,ada@example.com,2026-01-01\nGrace,grace@example.com,2026-02-02\nInvalid,bad-email,\nGrace,other@example.com,\n';
    assert.equal((await h.call('import/csv', { method: 'POST', form: file(source), key: null })).status, 400);
    const upload = await h.call('import/csv', { method: 'POST', form: file(source) });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    const id = upload.body.job.id;
    assert.equal(upload.body.counts.invalid, 1);
    assert.equal((await h.call('contacts')).body.pagination.total, 1);
    const preview = await act(h, id, 'prepare');
    assert.equal(preview.body.job.state, 'review');
    assert.deepEqual(preview.body.counts, { pending: 0, ready: 1, review: 2, invalid: 1, skipped: 0, imported: 0 });
    assert.equal(preview.body.rows[0].matches[0].name, 'Ada');
    assert.equal(preview.body.rows[3].fileMatches[0].row, 2);
    assert.equal((await act(h, id, 'confirm', { confirm: true })).status, 409);
    await act(h, id, 'decide', { rowNumber: 1, decision: 'create' });
    await act(h, id, 'decide', { rowNumber: 4, decision: 'skip' });
    assert.equal((await act(h, id, 'confirm', { confirm: true })).body.job.state, 'importing');
    const result = await act(h, id, 'advance');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.job.state, 'complete');
    assert.deepEqual(result.body.counts, { pending: 0, ready: 0, review: 0, invalid: 1, skipped: 1, imported: 2 });
    assert.equal((await h.call('contacts')).body.pagination.total, 3);
    assert.equal((await h.db.prepare("SELECT last_contacted FROM contacts WHERE email = 'ada@example.com'").first())?.last_contacted, '2026-01-01');
    assert.equal(new TextDecoder().decode(new Uint8Array((await h.call(`import/jobs/${id}/source`)).body)), source);
  } finally { await h.close(); }
});

test('cloud import cancellation, restore and erasure cannot resume old work', async () => {
  const h = await createCloudHarness();
  try {
    const backup = (await h.call('settings/backups', { method: 'POST' })).body.backup;
    const id = (await h.call('import/csv', { method: 'POST', form: file('Name\nAda') })).body.job.id;
    await act(h, id, 'prepare');
    await act(h, id, 'confirm', { confirm: true });
    const restored = await h.call('settings/restore', { method: 'POST', body: { filename: backup.filename, confirmation: 'RESTORE' } });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal((await act(h, id, 'advance')).body.job.state, 'cancelled');
    assert.equal((await act(h, id, 'confirm', { confirm: true })).status, 409);
    assert.equal((await h.call('contacts')).body.pagination.total, 0);
    const second = (await h.call('import/csv', { method: 'POST', form: file('Name\nGrace') })).body.job.id;
    await act(h, second, 'cancel');
    assert.equal((await act(h, second, 'prepare')).body.job.state, 'cancelled');
    const foreign = (await h.call('import/csv', { method: 'POST', workspace: 'other', form: file('Name\nPrivate') })).body.job.id;
    const erased = await h.call('settings/erase', { method: 'POST', body: { confirmation: 'ERASE ALL DATA' } });
    assert.equal(erased.status, 200, JSON.stringify(erased.body));
    for (const table of ['contact_import_jobs', 'contact_import_rows', 'contact_import_sources']) {
      assert.equal((await h.db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE workspace_id = 'test'`).first())?.count, 0);
    }
    assert.equal((await h.call(`import/jobs/${foreign}`, { workspace: 'other' })).status, 200);
    assert.equal((await act(h, id, 'advance')).status, 404);
  } finally { await h.close(); }
});

test('cloud imports segment original files, paginate reports and enforce limits before saving', async () => {
  const h = await createCloudHarness();
  try {
    const source = 'Name,Notes\n' + Array.from({ length: 26 }, (_, i) => `Person ${i},${'a'.repeat(45_000)}`).join('\n');
    const uploaded = await h.call('import/csv', { method: 'POST', form: file(source) });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const id = uploaded.body.job.id;
    assert.equal(uploaded.body.rows.length, 25);
    assert.equal((await h.call(`import/jobs/${id}?page=2`)).body.rows.length, 1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) count FROM contact_import_sources').first())?.count, 2);
    assert.equal(new TextDecoder().decode(new Uint8Array((await h.call(`import/jobs/${id}/source`)).body)), source);
    const big = await h.call('import/csv', { method: 'POST', form: file('x'.repeat(10 * 1024 * 1024 + 1)) });
    assert.equal(big.status, 413);
    const many = await h.call('import/csv', { method: 'POST', form: file('Name\n' + Array.from({ length: 5001 }, (_, i) => `Person ${i}`).join('\n')) });
    assert.equal(many.status, 400);
    assert.equal((await h.call('import/jobs')).body.jobs.length, 1);
  } finally { await h.close(); }
});

test('cloud vCard preview preserves portable fields and reports invalid rows individually', async () => {
  const h = await createCloudHarness();
  try {
    const source = 'BEGIN:VCARD\nVERSION:3.0\nFN:Ada\nNICKNAME:Addie\nEMAIL:ada@example.com\nBDAY:19900304\nNOTE:Remember the garden\nEND:VCARD\nBEGIN:VCARD\nVERSION:3.0\nFN:Invalid\nEMAIL:not-an-email\nEND:VCARD';
    const response = await h.call('import/vcard', { method: 'POST', form: file(source, 'people.vcf') });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.counts.invalid, 1);
    const id = response.body.job.id;
    await act(h, id, 'prepare');
    await act(h, id, 'confirm', { confirm: true });
    await act(h, id, 'advance');
    const directoryAda = (await h.call('contacts')).body.contacts[0];
    const ada = (await h.call(`contacts/${directoryAda.id}`)).body.contact;
    assert.equal(ada.nickname, 'Addie');
    assert.equal(ada.birthday, '1990-03-04');
    assert.match(ada.notes, /Remember the garden/);
  } finally { await h.close(); }
});

test('cloud import retries and concurrent advancement never insert a row twice', async () => {
  const h = await createCloudHarness();
  try {
    const source = 'Name\n' + Array.from({ length: 23 }, (_, i) => `Person ${i}`).join('\n');
    const key = crypto.randomUUID();
    const upload = await h.call('import/csv', { method: 'POST', form: file(source), key });
    const id = upload.body.job.id;
    assert.equal((await h.call('import/csv', { method: 'POST', form: file(source), key })).body.job.id, id);
    assert.equal((await h.call('import/csv', { method: 'POST', form: file('Name\nDifferent'), key })).status, 409);
    assert.equal((await h.call(`import/jobs/${id}`, { workspace: 'other' })).status, 404);
    assert.equal((await h.call(`import/jobs/${id}/source`, { workspace: 'other' })).status, 404);
    await act(h, id, 'prepare');
    await act(h, id, 'confirm', { confirm: true });
    const first = await act(h, id, 'advance');
    assert.equal(first.body.counts.imported, 10);
    await Promise.all([act(h, id, 'advance'), act(h, id, 'advance')]);
    await act(h, id, 'advance');
    const repeat = await act(h, id, 'advance');
    assert.equal(repeat.body.counts.imported, 23);
    assert.equal((await h.call('contacts')).body.pagination.total, 23);
    await h.call(`import/jobs/${id}`, { method: 'DELETE' });
    assert.equal((await h.call(`import/jobs/${id}`)).status, 404);
    assert.equal((await h.db.prepare('SELECT COUNT(*) count FROM contact_import_sources').first())?.count, 0);
    assert.equal((await h.call('contacts')).body.pagination.total, 23, 'Removing a report preserves contacts');
  } finally { await h.close(); }
});

test('cloud imports surface new matches and keep storage errors retryable', async () => {
  const h = await createCloudHarness();
  try {
    const id = (await h.call('import/csv', { method: 'POST', form: file('Name\nAda\nGrace') })).body.job.id;
    await act(h, id, 'prepare');
    await act(h, id, 'confirm', { confirm: true });
    await h.call('contacts', { method: 'POST', body: { name: 'Ada' } });
    await h.db.prepare("CREATE TRIGGER import_test_failure BEFORE INSERT ON contacts WHEN NEW.name = 'Grace' BEGIN SELECT RAISE(ABORT, 'Simulated storage failure'); END").run();
    assert.equal((await act(h, id, 'advance')).status, 503);
    assert.equal((await h.call(`import/jobs/${id}`)).body.counts.ready, 2, 'The complete batch rolls back');
    await h.db.prepare('DROP TRIGGER import_test_failure').run();
    const result = await act(h, id, 'advance');
    assert.equal(result.body.counts.imported, 1);
    assert.equal(result.body.counts.review, 1);
    assert.equal(result.body.counts.invalid, 0);
    assert.equal(result.body.job.state, 'review');
    await act(h, id, 'skip-matches');
    await act(h, id, 'confirm', { confirm: true });
    assert.equal((await act(h, id, 'advance')).body.job.state, 'complete');
  } finally { await h.close(); }
});
