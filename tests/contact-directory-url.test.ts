import assert from 'node:assert/strict';
import test from 'node:test';
import { readDirectoryUrl, updateDirectoryUrl } from '../lib/contact-directory-url.ts';

test('directory URLs preserve capture intent and unrelated parameters while filters change', () => {
  const first = updateDirectoryUrl('https://everclosecrm.com/contacts?intent=log&source=nav', {
    search: '  Ana Maria  ', tag: 'Família & friends', page: 3, view: 'list',
  });
  assert.equal(first, '/contacts?intent=log&source=nav&search=Ana+Maria&tag=Fam%C3%ADlia+%26+friends&page=3&view=list');
  assert.deepEqual(readDirectoryUrl(new URL(first, 'https://everclosecrm.com').searchParams), {
    search: 'Ana Maria', tag: 'Família & friends', page: 3, view: 'list', captureMoment: true,
  });

  const cleared = updateDirectoryUrl(`https://everclosecrm.com${first}`, { search: '', tag: null, page: 1, view: 'grid' });
  assert.equal(cleared, '/contacts?intent=log&source=nav&view=grid');
});

test('directory URLs reject invalid page and view values without losing the search', () => {
  const state = readDirectoryUrl(new URLSearchParams('search=Grace&page=999999999999999999999&view=unknown'));
  assert.deepEqual(state, { search: 'Grace', tag: null, page: 1, view: null, captureMoment: false });
  assert.equal(readDirectoryUrl(new URLSearchParams('page=-2')).page, 1);
  assert.equal(readDirectoryUrl(new URLSearchParams('page=2.5')).page, 1);
});
