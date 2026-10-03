import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeLinkedInImport, normalizeLinkedInUrl } from '../lib/linkedin.ts';

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
  assert.equal(normalized.photo_url, null);
  assert.equal(normalized.profile_url, 'https://www.linkedin.com/in/ada-lovelace');
  assert.deepEqual(normalized.tags, ['linkedin', 'engineering', 'history']);
  assert.equal(normalized.how_we_met, null);
  assert.equal(normalized.notes, 'Met through a mutual friend.');
  assert.match(normalized.custom_fields, /"social":\{"linkedin":"https:\/\/www\.linkedin\.com\/in\/ada-lovelace"\}/);
  assert.match(normalized.custom_fields, /"headline":"Staff Engineer at Analytical Engines"/);
});

test('normalizeLinkedInImport requires a name', () => {
  assert.throws(() => normalizeLinkedInImport({ headline: 'No name here' }), /requires a name/i);
});

test('normalizeLinkedInUrl canonicalizes common profile URL variants', () => {
  const expected = 'https://www.linkedin.com/in/ada-lovelace';

  assert.equal(normalizeLinkedInUrl('linkedin.com/in/ada-lovelace/'), expected);
  assert.equal(normalizeLinkedInUrl('https://linkedin.com/in/ada-lovelace?trk=profile#about'), expected);
  assert.equal(normalizeLinkedInUrl('http://www.linkedin.com/in/ada-lovelace///'), expected);
  assert.throws(() => normalizeLinkedInUrl('https://attacker.test/in/ada-lovelace'), /linkedin\.com/i);
  assert.throws(() => normalizeLinkedInUrl('javascript:alert(1)'), /linkedin\.com/i);
});

test('normalizeLinkedInImport ignores unsafe photo schemes and bounds tags', () => {
  const normalized = normalizeLinkedInImport({
    fullName: 'Safe Contact',
    photoUrl: 'javascript:alert(1)',
    tags: Array.from({ length: 99 }, (_, index) => `tag-${index}`),
  });
  assert.equal(normalized.photo_url, null);
  assert.equal(normalized.tags.length, 100);
  assert.throws(
    () => normalizeLinkedInImport({
      fullName: 'Too Many Tags',
      tags: Array.from({ length: 100 }, (_, index) => `tag-${index}`),
    }),
    /at most 100 tags including the linkedin tag/i
  );
});
