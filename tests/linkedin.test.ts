import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeLinkedInImport } from '../lib/linkedin.ts';

test('normalizeLinkedInImport maps a typical LinkedIn payload into a CRM contact', () => {
  const normalized = normalizeLinkedInImport({
    fullName: 'Ada Lovelace',
    headline: 'Staff Engineer at Analytical Engines',
    company: 'Analytical Engines',
    location: 'London',
    linkedinUrl: 'https://www.linkedin.com/in/ada-lovelace/',
    photoUrl: 'https://example.com/ada.jpg',
    tags: ['engineering', 'history'],
    notes: 'Met through a mutual friend.',
  });

  assert.equal(normalized.name, 'Ada Lovelace');
  assert.equal(normalized.photo_url, 'https://example.com/ada.jpg');
  assert.equal(normalized.profile_url, 'https://www.linkedin.com/in/ada-lovelace/');
  assert.deepEqual(normalized.tags, ['linkedin', 'engineering', 'history']);
  assert.equal(normalized.how_we_met, null);
  assert.equal(normalized.notes, 'Met through a mutual friend.');
  assert.match(normalized.custom_fields, /"social":\{"linkedin":"https:\/\/www\.linkedin\.com\/in\/ada-lovelace\/"\}/);
  assert.match(normalized.custom_fields, /"headline":"Staff Engineer at Analytical Engines"/);
});

test('normalizeLinkedInImport requires a name', () => {
  assert.throws(() => normalizeLinkedInImport({ headline: 'No name here' }), /requires a name/i);
});
