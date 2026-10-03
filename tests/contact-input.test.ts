import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeContactCreateInput,
  normalizeContactPatchInput,
  normalizeWebUrl,
} from '../lib/contact-input.ts';
import { TINY_PNG_DATA_URL } from './fixtures.ts';

test('contact creation normalizes structured fields for SQLite storage', () => {
  const input = normalizeContactCreateInput({
    name: '  Ada Lovelace  ',
    nickname: '  Addie  ',
    email: 'ada@example.test',
    tags: ['Friend', 'friend', '  applied   math  '],
    gift_ideas: ['Book'],
    contact_frequency: 30,
    custom_fields: {
      company: 'Analytical Engines',
      social: { website: 'example.test/ada' },
    },
  });

  assert.equal(input.name, 'Ada Lovelace');
  assert.equal(input.nickname, 'Addie');
  assert.equal(input.birthday_reminder_days, 7);
  assert.equal(input.tags, '["Friend","applied math"]');
  assert.equal(input.gift_ideas, '["Book"]');
  assert.match(String(input.custom_fields), /https:\/\/example\.test\/ada/);
});

test('contact updates reject unsafe links, invalid dates, and empty names', () => {
  assert.throws(
    () => normalizeContactPatchInput({ custom_fields: { social: { website: 'javascript:alert(1)' } } }),
    /valid HTTP or HTTPS URL/i
  );
  assert.throws(() => normalizeContactPatchInput({ birthday: '2026-02-30' }), /valid date/i);
  assert.throws(() => normalizeContactPatchInput({ name: '   ' }), /name is required/i);
  assert.throws(() => normalizeContactPatchInput({ nickname: 'n'.repeat(201) }), /nickname.*200/i);
  assert.throws(() => normalizeContactPatchInput({ birthday_reminder_days: 366 }), /birthday alert.*365/i);
  assert.equal(normalizeContactPatchInput({ birthday_reminder_days: 0 }).birthday_reminder_days, 0);
  assert.equal(normalizeContactPatchInput({ nickname: '   ' }).nickname, null);
  assert.equal(normalizeWebUrl('data:text/html,unsafe'), null);
});

test('contact updates serialize custom fields instead of passing objects to SQLite', () => {
  const updates = normalizeContactPatchInput({
    custom_fields: { company: 'Babbage Labs', location: 'London' },
  });
  assert.equal(typeof updates.custom_fields, 'string');
  assert.deepEqual(JSON.parse(String(updates.custom_fields)), {
    company: 'Babbage Labs',
    location: 'London',
  });
});

test('contact photos accept validated local images and retain remote URLs only as data', () => {
  assert.equal(
    normalizeContactCreateInput({ name: 'Local Photo', photo_url: TINY_PNG_DATA_URL }).photo_url,
    TINY_PNG_DATA_URL
  );
  assert.equal(
    normalizeContactCreateInput({ name: 'Remote Reference', photo_url: 'https://images.example.test/photo.jpg' }).photo_url,
    'https://images.example.test/photo.jpg'
  );
  assert.throws(
    () => normalizeContactCreateInput({ name: 'Spoofed Photo', photo_url: 'data:image/png;base64,PGh0bWw+PC9odG1sPg==' }),
    /valid JPEG, PNG, or WebP/i
  );
});
