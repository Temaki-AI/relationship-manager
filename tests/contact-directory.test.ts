import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import {
  addTagToContacts,
  ContactDirectoryError,
  listContactPage,
  listMentionOptions,
  listTagContacts,
  listTagSummaries,
  updateTagMembership,
} from '../lib/contact-directory.ts';
import { MAX_TAGS_PER_CONTACT } from '../lib/tag-validation.ts';
import { embeddedContactPhotoResponse } from '../lib/contact-photo-response.ts';
import { TINY_PNG_DATA_URL } from './fixtures.ts';
import { initializeDatabase } from '../lib/database-initialization.ts';

function createDirectory() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const insert = db.prepare(`
    INSERT INTO contacts (name, email, tags, notes, custom_fields)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (let index = 1; index <= 135; index++) {
    insert.run(
      `Person ${String(index).padStart(3, '0')}`,
      `person-${index}@example.test`,
      JSON.stringify(index % 2 === 0 ? ['friend'] : ['work']),
      index === 7 ? 'Literal 100% memory' : null,
      index === 8 ? JSON.stringify({ company: 'Scale Works' }) : null
    );
  }
  db.prepare('UPDATE contacts SET nickname = ? WHERE name = ?').run('Ace', 'Person 009');
  insert.run('Best friend label', null, JSON.stringify(['best friend']), null, null);
  db.prepare('INSERT INTO contacts (name, tags) VALUES (?, ?)').run('Legacy invalid tags', 'not-json');
  return db;
}

test('contact browsing is bounded, stable, and clamps stale pages', () => {
  const db = createDirectory();
  try {
    const first = listContactPage(db);
    assert.equal(first.contacts.length, 50);
    assert.deepEqual(first.pagination, {
      page: 1,
      pageSize: 50,
      total: 137,
      totalPages: 3,
    });

    const maximum = listContactPage(db, { page: 999, pageSize: 1000 });
    assert.equal(maximum.pagination.pageSize, 100);
    assert.equal(maximum.pagination.page, 2);
    assert.equal(maximum.contacts.length, 37);
    assert.deepEqual(
      first.contacts.slice(0, 3).map((contact) => contact.name),
      ['Best friend label', 'Legacy invalid tags', 'Person 001']
    );
  } finally {
    db.close();
  }
});

test('contact search is literal and exact tag filtering tolerates legacy data', () => {
  const db = createDirectory();
  try {
    const percent = listContactPage(db, { search: '%' });
    assert.equal(percent.pagination.total, 1);
    assert.equal(percent.contacts[0].name, 'Person 007');

    const importedContext = listContactPage(db, { search: 'scale works' });
    assert.equal(importedContext.pagination.total, 1);
    assert.equal(importedContext.contacts[0].name, 'Person 008');

    const nickname = listContactPage(db, { search: 'ace' });
    assert.equal(nickname.pagination.total, 1);
    assert.equal(nickname.contacts[0].name, 'Person 009');

    const friends = listContactPage(db, { tag: 'friend', pageSize: 100 });
    assert.equal(friends.pagination.total, 67);
    assert.equal(friends.contacts.some((contact) => contact.name === 'Best friend label'), false);
  } finally {
    db.close();
  }
});

test('directory pages omit private long fields and serve embedded photos separately', async () => {
  const db = createDirectory();
  try {
    const photo = TINY_PNG_DATA_URL;
    db.prepare('UPDATE contacts SET photo_url = ?, notes = ?, custom_fields = ? WHERE name = ?')
      .run(photo, 'A private note', JSON.stringify({ company: 'Manual', linkedin: { company: 'Imported', location: 'Lisbon' } }), 'Person 008');
    const contact = listContactPage(db, { search: 'Person 008' }).contacts[0];
    assert.equal(contact.photo_url, `/api/contacts/${contact.id}/photo`);
    assert.equal(contact.company, 'Manual');
    assert.equal(contact.location, 'Lisbon');
    assert.equal('notes' in contact, false);
    assert.equal('custom_fields' in contact, false);
    const response = embeddedContactPhotoResponse(photo);
    assert.equal(response?.headers.get('Content-Type'), 'image/png');
    assert.equal(response?.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(Array.from(new Uint8Array(await response!.arrayBuffer())),
      Array.from(Buffer.from(photo.split(',')[1], 'base64')));
    assert.equal(embeddedContactPhotoResponse('https://example.test/photo.png'), null);
  } finally { db.close(); }
});

test('tag summaries and mention options expose bounded minimal projections', () => {
  const db = createDirectory();
  try {
    const summaries = listTagSummaries(db);
    assert.deepEqual(summaries.tags, [
      { tag: 'friend', contactCount: 67 },
      { tag: 'work', contactCount: 68 },
      { tag: 'best friend', contactCount: 1 },
    ].sort((left, right) => right.contactCount - left.contactCount || left.tag.localeCompare(right.tag)));

    const mentions = listMentionOptions(db, { search: 'person 01', limit: 200 });
    assert.equal(mentions.length, 10);
    assert.deepEqual(Object.keys(mentions[0]).sort(), ['email', 'id', 'name', 'photo_url']);
    assert.equal(mentions[0].photo_url, null);
    assert.equal(JSON.stringify(mentions).includes('Literal 100% memory'), false);
  } finally {
    db.close();
  }
});

test('tag membership is paged and bulk additions are transactional and bounded', () => {
  const db = createDirectory();
  try {
    const members = listTagContacts(db, { tag: 'friend', pageSize: 30 });
    assert.equal(members.contacts.length, 30);
    assert.equal(members.pagination.total, 67);
    const available = listTagContacts(db, {
      tag: 'friend',
      membership: 'available',
      search: 'person 00',
    });
    assert(available.contacts.length > 0);

    const selected = available.contacts.slice(0, 3).map((contact) => contact.id);
    assert.equal(addTagToContacts(db, 'friend', selected), 3);
    assert.equal(addTagToContacts(db, 'FRIEND', selected), 0);
    assert.equal(listTagContacts(db, { tag: 'friend' }).pagination.total, 70);
    assert.throws(
      () => addTagToContacts(db, 'friend', Array.from({ length: 101 }, (_, index) => index + 1)),
      ContactDirectoryError
    );
  } finally {
    db.close();
  }
});

test('tag membership mutations fail closed and enforce canonical capacity', () => {
  const db = new Database(':memory:');
  initializeDatabase(db);
  try {
    const firstId = Number(db.prepare('INSERT INTO contacts (name, tags) VALUES (?, ?)')
      .run('First', JSON.stringify(['Friend', 'friend', 'bad,tag'])).lastInsertRowid);
    const fullId = Number(db.prepare('INSERT INTO contacts (name, tags) VALUES (?, ?)')
      .run(
        'Full',
        JSON.stringify(Array.from({ length: MAX_TAGS_PER_CONTACT }, (_, index) => `tag-${index}`))
      ).lastInsertRowid);

    assert.throws(
      () => updateTagMembership(db, 'new', [firstId, 999_999], 'add'),
      /no longer exist/i
    );
    assert.equal(
      (db.prepare('SELECT tags FROM contacts WHERE id = ?').get(firstId) as { tags: string }).tags,
      JSON.stringify(['Friend', 'friend', 'bad,tag'])
    );

    assert.throws(
      () => updateTagMembership(db, 'new', [firstId, fullId], 'add'),
      /maximum of 100 tags/i
    );
    assert.equal(listTagContacts(db, { tag: 'new' }).pagination.total, 0);

    assert.equal(updateTagMembership(db, 'FRIEND', [firstId], 'remove'), 1);
    assert.equal(
      (db.prepare('SELECT tags FROM contacts WHERE id = ?').get(firstId) as { tags: string | null }).tags,
      null
    );
    assert.throws(() => updateTagMembership(db, 'bad,tag', [firstId], 'add'), /commas/i);
  } finally {
    db.close();
  }
});
