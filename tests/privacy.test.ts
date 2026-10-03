import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLocalEnrichment } from '../lib/enrichment.ts';
import { getContactAvatar, getSocialLinks } from '../lib/utils.ts';
import { TINY_PNG_DATA_URL } from './fixtures.ts';

test('email enrichment derives company data without an external request', () => {
  const originalFetch = globalThis.fetch;
  let externalRequestMade = false;
  globalThis.fetch = async () => {
    externalRequestMade = true;
    throw new Error('Unexpected external request');
  };

  try {
    const result = buildLocalEnrichment('ada@analytical-engines.com');

    assert.equal(externalRequestMade, false);
    assert.equal(result?.data.company, 'Analytical Engines');
    assert.equal(result?.data.companyDomain, 'analytical-engines.com');
    assert.equal(result?.data.suggestedNotes, 'Company: Analytical Engines');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('contacts with email addresses use local initials unless a photo is explicit', () => {
  const avatar = getContactAvatar({
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    photo_url: null,
  });

  assert.deepEqual(avatar, {
    type: 'initials',
    initials: 'AL',
    color: 'from-violet-700 to-purple-800',
  });
});

test('legacy unsafe media and social URL schemes are ignored', () => {
  assert.equal(
    getContactAvatar({
      name: 'Unsafe Contact',
      email: null,
      photo_url: 'javascript:alert(1)',
    }).type,
    'initials'
  );
  assert.deepEqual(
    getSocialLinks(JSON.stringify({
      social: {
        website: 'javascript:alert(1)',
        linkedin: 'https://www.linkedin.com/in/safe-contact',
      },
    })),
    { linkedin: 'https://www.linkedin.com/in/safe-contact' }
  );
});

test('avatars render embedded local photos but never request remote photo URLs', () => {
  assert.deepEqual(
    getContactAvatar({
      name: 'Local Photo',
      email: null,
      photo_url: TINY_PNG_DATA_URL,
    }),
    { type: 'image', url: TINY_PNG_DATA_URL }
  );
  assert.equal(
    getContactAvatar({
      name: 'Remote Photo',
      email: null,
      photo_url: 'https://tracking.example.test/contact.jpg',
    }).type,
    'initials'
  );
  assert.deepEqual(getContactAvatar({
    name: 'Stored Photo', email: null, photo_url: '/api/contacts/42/photo',
  }), { type: 'image', url: '/api/contacts/42/photo' });
  assert.equal(getContactAvatar({
    name: 'Unsafe Local Path', email: null, photo_url: '//tracking.example.test/photo',
  }).type, 'initials');
});
