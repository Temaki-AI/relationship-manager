import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTACT_CSV_HEADERS,
  createTextExportStream,
  serializeContactToCSVRow,
} from '../lib/contact-export.ts';
import type { Contact } from '../lib/db.ts';
import { parseImportPreview } from '../lib/import-preview.ts';
import {
  serializeContactsToVCard,
  serializeContactToVCard,
} from '../lib/vcard.ts';

function makeContact(id: number, name: string): Contact {
  return {
    id,
    name,
    nickname: null,
    email: `${name.toLowerCase().replace(/\s/g, '.')}@example.test`,
    phone: null,
    photo_url: null,
    birthday: null,
    birthday_reminder_days: 7,
    how_we_met: null,
    tags: '["friend"]',
    notes: null,
    gift_ideas: null,
    custom_fields: null,
    last_contacted: null,
    contact_frequency: 14,
    created_at: '2026-07-11T10:00:00.000Z',
    updated_at: '2026-07-11T10:00:00.000Z',
  };
}

test('streamed contact exports preserve CSV and vCard wire formats', async () => {
  const contacts = [makeContact(1, 'Ada Lovelace'), makeContact(2, 'Grace Hopper')];
  const csvStream = createTextExportStream(contacts.values(), {
    prefix: CONTACT_CSV_HEADERS.join(','),
    separator: '\n',
    serialize: serializeContactToCSVRow,
  });
  const vcardStream = createTextExportStream(contacts.values(), {
    separator: '\r\n',
    suffix: '\r\n',
    serialize: serializeContactToVCard,
  });

  assert.equal(
    await new Response(csvStream).text(),
    [CONTACT_CSV_HEADERS.join(','), ...contacts.map(serializeContactToCSVRow)].join('\n')
  );
  assert.equal(
    await new Response(vcardStream).text(),
    serializeContactsToVCard(contacts)
  );
});

test('contact export streams apply backpressure and release canceled iterators', async () => {
  let nextCalls = 0;
  let returnCalls = 0;
  const values: Iterator<number> = {
    next() {
      nextCalls += 1;
      return { done: false, value: nextCalls };
    },
    return() {
      returnCalls += 1;
      return { done: true, value: undefined };
    },
  };
  const reader = createTextExportStream(values, {
    prefix: 'header',
    separator: '\n',
    serialize: String,
  }).getReader();

  const firstChunk = await reader.read();
  assert.equal(new TextDecoder().decode(firstChunk.value), 'header');
  assert.ok(nextCalls <= 1, `expected at most one prefetched row, received ${nextCalls}`);

  await reader.cancel();
  assert.equal(returnCalls, 1);
});

test('streamed CSV rows retain spreadsheet formula protection', async () => {
  const contact = makeContact(1, '=HYPERLINK("https://attacker.test")');
  const stream = createTextExportStream([contact].values(), {
    prefix: CONTACT_CSV_HEADERS.join(','),
    separator: '\n',
    serialize: serializeContactToCSVRow,
  });

  const csv = await new Response(stream).text();
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/attacker\.test""\)"/);
});

test('portable CSV round-trips photo and custom fields', () => {
  const contact = {
    ...makeContact(1, 'Ada Lovelace'),
    photo_url: 'https://images.example.test/ada.jpg',
    custom_fields: JSON.stringify({ company: 'Analytical Engines', social: { website: 'https://example.test/' } }),
  };
  const csv = `${CONTACT_CSV_HEADERS.join(',')}\n${serializeContactToCSVRow(contact)}`;
  const [row] = parseImportPreview(csv, 'csv', '2026-10-01T00:00:00.000Z');
  assert.equal(row.state, 'pending', row.message || '');
  const payload = JSON.parse(row.payload || '{}');
  assert.equal(payload.photo_url, contact.photo_url);
  assert.deepEqual(JSON.parse(payload.custom_fields), JSON.parse(contact.custom_fields));
  const invalid = parseImportPreview(`${CONTACT_CSV_HEADERS.join(',')}\n${serializeContactToCSVRow({ ...contact, custom_fields: 'not-json' })}`, 'csv', '2026-10-01T00:00:00.000Z');
  assert.equal(invalid[0].state, 'invalid');
  assert.match(invalid[0].message || '', /custom fields/i);
});
