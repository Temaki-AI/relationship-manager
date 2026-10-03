import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_TAGS_PER_CONTACT,
  normalizeTag,
  normalizeTagList,
  parseStoredTags,
  serializeTagList,
  TagValidationError,
} from '../lib/tag-validation.ts';

test('tag normalization is case-insensitively unique and canonicalizes whitespace', () => {
  assert.deepEqual(
    normalizeTagList([' Friend ', 'friend', 'best   friend', 'Work']),
    ['Friend', 'best friend', 'Work']
  );
  assert.equal(serializeTagList([]), null);
  assert.equal(serializeTagList(['Friend']), '["Friend"]');
});

test('tag validation rejects values the comma-separated UI cannot represent safely', () => {
  for (const invalid of ['', 'work,friend', 'line\nbreak', 'a'.repeat(101), 42]) {
    assert.throws(() => normalizeTag(invalid), TagValidationError);
  }
  assert.throws(
    () => normalizeTagList(Array.from({ length: MAX_TAGS_PER_CONTACT + 1 }, () => 'friend')),
    TagValidationError
  );
});

test('stored tag parsing tolerates and cleans malformed legacy values', () => {
  assert.deepEqual(
    parseStoredTags(JSON.stringify([' Friend ', 'friend', 'bad,tag', null, 'Work'])),
    ['Friend', 'Work']
  );
  assert.deepEqual(parseStoredTags('not-json'), []);
});
