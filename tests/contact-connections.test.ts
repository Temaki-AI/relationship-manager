import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import {
  ContactConnectionInputError,
  listContactChildrenPage,
  listContactRelationshipsPage,
  normalizeChildInput,
  normalizeRelationshipLabels,
  validateChildLink,
} from '../lib/contact-connections.ts';
import { initializeDatabase } from '../lib/database-initialization.ts';

function createDatabase() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  return db;
}

function insertContact(db: Database.Database, name: string): number {
  return Number(db.prepare('INSERT INTO contacts (name) VALUES (?)').run(name).lastInsertRowid);
}

test('contact relationships expose the correct label from both profiles and remain unique', () => {
  const db = createDatabase();
  try {
    const adaId = insertContact(db, 'Ada Lovelace');
    const graceId = insertContact(db, 'Grace Hopper');
    const labels = normalizeRelationshipLabels({
      relationship_label: ' Wife ',
      reciprocal_label: 'Husband',
    });
    assert.deepEqual(labels, { relationshipLabel: 'Wife', reciprocalLabel: 'Husband' });

    db.prepare(`
      INSERT INTO contact_relationships (
        contact_id, related_contact_id, relationship_label, reciprocal_label
      ) VALUES (?, ?, ?, ?)
    `).run(adaId, graceId, labels.relationshipLabel, labels.reciprocalLabel);

    const adaRelationship = listContactRelationshipsPage(db, adaId).relationships[0];
    assert.match(adaRelationship.created_at, /^\d{4}-\d{2}-\d{2}/);
    assert.deepEqual({ ...adaRelationship, created_at: undefined }, {
      id: 1,
      related_contact_id: graceId,
      related_name: 'Grace Hopper',
      related_nickname: null,
      relationship_label: 'Wife',
      reciprocal_label: 'Husband',
      created_at: undefined,
    });
    const graceRelationship = listContactRelationshipsPage(db, graceId).relationships[0];
    assert.match(graceRelationship.created_at, /^\d{4}-\d{2}-\d{2}/);
    assert.deepEqual({ ...graceRelationship, created_at: undefined }, {
      id: 1,
      related_contact_id: adaId,
      related_name: 'Ada Lovelace',
      related_nickname: null,
      relationship_label: 'Husband',
      reciprocal_label: 'Wife',
      created_at: undefined,
    });
    assert.throws(
      () => db.prepare(`
        INSERT INTO contact_relationships (
          contact_id, related_contact_id, relationship_label, reciprocal_label
        ) VALUES (?, ?, ?, ?)
      `).run(graceId, adaId, 'Husband', 'Wife'),
      /unique/i
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO contact_relationships (
          contact_id, related_contact_id, relationship_label, reciprocal_label
        ) VALUES (?, ?, ?, ?)
      `).run(adaId, adaId, 'Self', 'Self'),
      /check constraint/i
    );
    assert.throws(
      () => normalizeRelationshipLabels({ relationship_label: 'Friend\u0000', reciprocal_label: 'Friend' }),
      ContactConnectionInputError
    );
  } finally {
    db.close();
  }
});

test('children are validated, paginated, and removed with their parent contact', () => {
  const db = createDatabase();
  try {
    const parentId = insertContact(db, 'Parent Contact');
    const insertChild = db.prepare(
      'INSERT INTO contact_children (contact_id, name, birthday) VALUES (?, ?, ?)'
    );
    insertChild.run(parentId, 'Zoe', '2020-05-12');
    insertChild.run(parentId, 'Amy', null);
    insertChild.run(parentId, 'Max', '2018-03-04');

    assert.deepEqual(normalizeChildInput({ name: '  Alex  ', birthday: '2019-07-11' }), {
      name: 'Alex',
      birthday: '2019-07-11',
      linked_contact_id: null,
    });
    assert.deepEqual(normalizeChildInput({ name: 'Robin', birthday: '' }), {
      name: 'Robin',
      birthday: null,
      linked_contact_id: null,
    });
    assert.throws(() => normalizeChildInput({ name: '', birthday: '2020-01-01' }), /name is required/i);
    assert.throws(() => normalizeChildInput({ name: 'Alex', birthday: '2020-02-30' }), /valid date/i);

    const firstPage = listContactChildrenPage(db, parentId, { page: 1, pageSize: 2 });
    assert.deepEqual(firstPage.pagination, { page: 1, pageSize: 2, total: 3, totalPages: 2 });
    assert.deepEqual(firstPage.children.map((child) => child.name), ['Amy', 'Max']);
    const secondPage = listContactChildrenPage(db, parentId, { page: 2, pageSize: 2 });
    assert.deepEqual(secondPage.children.map((child) => child.name), ['Zoe']);

    db.prepare('DELETE FROM contacts WHERE id = ?').run(parentId);
    assert.equal(db.prepare('SELECT COUNT(*) FROM contact_children').pluck().get(), 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('linked children use the contact profile and cannot link themselves or a duplicate', () => {
  const db = createDatabase();
  try {
    const parentId = insertContact(db, 'Parent');
    const childId = insertContact(db, 'Child profile');
    db.prepare("UPDATE contacts SET birthday = '2020-05-12' WHERE id = ?").run(childId);
    const normalized = normalizeChildInput({ name: 'Child', birthday: '', linked_contact_id: childId });
    assert.deepEqual(normalized, { name: 'Child', birthday: null, linked_contact_id: childId });
    assert.doesNotThrow(() => validateChildLink(parentId, normalized.birthday, childId, '2020-05-12'));
    assert.throws(() => validateChildLink(parentId, null, parentId, '2020-05-12'), /their own child/i);
    assert.throws(() => validateChildLink(parentId, '2020-05-12', childId, '2020-05-13'), /birthday/i);
    assert.throws(() => normalizeChildInput({ name: 'Child', linked_contact_id: 'nope' }), /profile/i);
    db.prepare('INSERT INTO contact_children (contact_id, linked_contact_id, name) VALUES (?, ?, ?)')
      .run(parentId, childId, 'Old alias');
    const child = listContactChildrenPage(db, parentId).children[0];
    assert.equal(child.linked_name, 'Child profile');
    assert.equal(child.linked_birthday, '2020-05-12');
    assert.throws(() => db.prepare('INSERT INTO contact_children (contact_id, linked_contact_id, name) VALUES (?, ?, ?)')
      .run(parentId, childId, 'Duplicate'), /unique/i);
    assert.throws(() => db.prepare('INSERT INTO contact_children (contact_id, linked_contact_id, name) VALUES (?, ?, ?)')
      .run(parentId, parentId, 'Self'), /check constraint/i);
    db.prepare('DELETE FROM contacts WHERE id = ?').run(childId);
    assert.equal(listContactChildrenPage(db, parentId).children[0].linked_contact_id, null);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});
