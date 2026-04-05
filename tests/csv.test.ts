import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCSV,
  normalizeImportedFrequency,
  parseImportedGiftIdeasValue,
  parseImportedTagsValue,
} from '../lib/csv.ts';

test('parseCSV preserves multiline quoted fields and later rows', () => {
  const csv = `Name,Notes,Gift Ideas
"Taylor","Met at the summit
Loves detailed follow-ups","Book club
Coffee beans"
"Jordan","Single line note","[""Board game"",""Tea sampler""]"`;

  const records = parseCSV(csv);

  assert.equal(records.length, 3);
  assert.deepEqual(records[0], ['Name', 'Notes', 'Gift Ideas']);
  assert.deepEqual(records[1], [
    'Taylor',
    'Met at the summit\nLoves detailed follow-ups',
    'Book club\nCoffee beans',
  ]);
  assert.deepEqual(records[2], [
    'Jordan',
    'Single line note',
    '["Board game","Tea sampler"]',
  ]);
});

test('import normalization keeps sane fallback values', () => {
  assert.equal(normalizeImportedFrequency(undefined), 14);
  assert.equal(normalizeImportedFrequency('0'), 14);
  assert.equal(normalizeImportedFrequency('-5'), 14);
  assert.equal(normalizeImportedFrequency('21'), 21);

  assert.equal(parseImportedTagsValue('friend, work'), '["friend","work"]');
  assert.equal(parseImportedGiftIdeasValue('Book\nCoffee'), '["Book","Coffee"]');
});
