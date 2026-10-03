import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isEmbeddedContactPhoto,
  MAX_EMBEDDED_CONTACT_PHOTO_CHARACTERS,
  parseEmbeddedContactPhoto,
} from '../lib/contact-photo.ts';
import { TINY_PNG_DATA_URL } from './fixtures.ts';

test('embedded contact photos require an allowed MIME type and matching binary signature', () => {
  assert.equal(isEmbeddedContactPhoto(TINY_PNG_DATA_URL), true);
  assert.deepEqual(parseEmbeddedContactPhoto(TINY_PNG_DATA_URL), {
    mimeType: 'image/png',
    base64: TINY_PNG_DATA_URL.split(',', 2)[1],
  });
  assert.equal(isEmbeddedContactPhoto('data:image/png;base64,PGh0bWw+PC9odG1sPg=='), false);
  assert.equal(isEmbeddedContactPhoto('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), false);
  assert.equal(isEmbeddedContactPhoto('https://images.example.test/contact.png'), false);
});

test('embedded contact photos are bounded before decoding', () => {
  const oversized = `data:image/png;base64,${'A'.repeat(MAX_EMBEDDED_CONTACT_PHOTO_CHARACTERS)}`;
  assert.equal(isEmbeddedContactPhoto(oversized), false);
});
