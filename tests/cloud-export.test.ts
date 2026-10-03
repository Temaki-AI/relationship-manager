import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCSV } from '../lib/csv.ts';
import { CONTACT_CSV_HEADERS } from '../lib/contact-export.ts';
import { parseImportPreview } from '../lib/import-preview.ts';
import { normalizeVCardContact, parseVCards } from '../lib/vcard.ts';
import { createCloudHarness } from './helpers/cloud-harness.ts';

function decode(body: number[]): string {
  return new TextDecoder().decode(new Uint8Array(body));
}

async function download(h: Awaited<ReturnType<typeof createCloudHarness>>, format: 'csv' | 'vcard') {
  const created = await h.call('export/jobs', { method: 'POST', body: { format } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.job.id;
  let state = 'running';
  for (let attempt = 0; attempt < 8 && state !== 'complete'; attempt++) {
    const step = await h.call(`export/jobs/${id}`, { method: 'POST' });
    assert.equal(step.status, 200, JSON.stringify(step.body));
    state = step.body.job.state;
  }
  assert.equal(state, 'complete');
  return h.call(`export/jobs/${id}/download`);
}

test('cloud exports preserve portable fields and isolate workspaces', async () => {
  const h = await createCloudHarness();
  try {
    const contact = {
      name: 'Ada Lovelace', nickname: 'Addie', email: 'ada@example.test',
      photo_url: 'https://images.example.test/ada.jpg', birthday: '1815-12-10',
      birthday_reminder_days: 14, tags: ['friend'], gift_ideas: ['Rare book'],
      custom_fields: { company: 'Analytical Engines', source_note: 'Met in London' },
    };
    const created = await h.call('contacts', { method: 'POST', body: contact });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await h.call('contacts', { method: 'POST', workspace: 'other', body: { name: 'Private Person' } });

    const csv = await download(h, 'csv');
    assert.equal(csv.status, 200);
    const csvText = decode(csv.body as number[]);
    const rows = parseCSV(csvText);
    assert.deepEqual(rows[0], [...CONTACT_CSV_HEADERS]);
    assert.equal(rows.length, 2);
    assert.equal(rows[1][0], contact.name);
    assert.doesNotMatch(csvText, /Private Person/);
    const preview = parseImportPreview(csvText, 'csv', '2026-10-01T00:00:00.000Z');
    assert.equal(preview[0].state, 'pending', preview[0].message || '');
    const imported = JSON.parse(preview[0].payload || '{}');
    assert.equal(imported.photo_url, contact.photo_url);
    assert.deepEqual(JSON.parse(imported.custom_fields), contact.custom_fields);

    const vcard = await download(h, 'vcard');
    assert.equal(vcard.status, 200);
    const cards = parseVCards(decode(vcard.body as number[]));
    assert.equal(cards.length, 1);
    const normalized = normalizeVCardContact(cards[0]);
    assert.equal(normalized.photo_url, contact.photo_url);
    assert.deepEqual(JSON.parse(normalized.custom_fields || '{}'), contact.custom_fields);
  } finally { await h.close(); }
});

test('legacy direct cloud export URLs refuse unsafe downloads at any workspace size', async () => {
  const h = await createCloudHarness();
  try {
    for (const format of ['csv', 'vcard']) {
      const exportResult = await h.call(`export/${format}`);
      assert.equal(exportResult.status, 409);
      assert.match(exportResult.body.error, /no partial file/i);
      assert.equal(exportResult.headers.get('Content-Disposition'), null);
    }
    const other = await h.call('export/csv', { workspace: 'other' });
    assert.equal(other.status, 409);
  } finally { await h.close(); }
});
