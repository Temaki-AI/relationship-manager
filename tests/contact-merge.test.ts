import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import {
  ContactMergeError,
  buildMergedContact,
  findDuplicateContactGroups,
  mergeContacts,
  validateContactMergeSelection,
  type DuplicateContact,
} from '../lib/contact-merge.ts';
import { initializeDatabase } from '../lib/database-initialization.ts';
import type { Contact } from '../lib/db.ts';

function contact(overrides: Partial<DuplicateContact> & Pick<DuplicateContact, 'id' | 'name'>): DuplicateContact {
  return {
    id: overrides.id,
    name: overrides.name,
    nickname: null,
    email: null,
    phone: null,
    photo_url: null,
    birthday: null,
    birthday_reminder_days: 7,
    how_we_met: null,
    tags: null,
    notes: null,
    gift_ideas: null,
    custom_fields: null,
    last_contacted: null,
    contact_frequency: 14,
    created_at: `2026-01-0${overrides.id}T00:00:00.000Z`,
    updated_at: `2026-01-0${overrides.id}T00:00:00.000Z`,
    ...overrides,
  };
}

function createDatabase() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  return db;
}

function insertContact(db: Database.Database, value: Partial<Contact> & Pick<Contact, 'name'>): number {
  const result = db.prepare(`
    INSERT INTO contacts (
      name, nickname, email, phone, photo_url, birthday, how_we_met, tags, notes,
      gift_ideas, custom_fields, last_contacted, contact_frequency
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    value.name,
    value.nickname ?? null,
    value.email ?? null,
    value.phone ?? null,
    value.photo_url ?? null,
    value.birthday ?? null,
    value.how_we_met ?? null,
    value.tags ?? null,
    value.notes ?? null,
    value.gift_ideas ?? null,
    value.custom_fields ?? null,
    value.last_contacted ?? null,
    value.contact_frequency ?? 14
  );
  return Number(result.lastInsertRowid);
}

test('duplicate grouping supports transitive signals, secondary addresses, and strong birthday matches', () => {
  const groups = findDuplicateContactGroups([
    contact({ id: 1, name: 'Ada One', email: 'ada@example.test' }),
    contact({
      id: 2,
      name: 'Ada Two',
      email: 'ADA@example.test',
      phone: '+49 30 555 0101',
      interaction_count: 3,
    }),
    contact({ id: 3, name: 'Ada Three', phone: '+49 (30) 555-0101' }),
    contact({
      id: 4,
      name: 'Grace Hopper',
      email: 'other@example.test',
      custom_fields: JSON.stringify({ vcard: { additional_emails: ['ada@example.test'] } }),
    }),
    contact({ id: 5, name: 'Same Name' }),
    contact({ id: 6, name: 'Same Name' }),
    contact({ id: 7, name: 'Katherine Johnson', email: 'kj-one@example.test', birthday: '1918-08-26' }),
    contact({ id: 8, name: '  KATHERINE   JOHNSON ', email: 'kj-two@example.test', birthday: '1918-08-26' }),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].contacts.map((item) => item.id), [1, 2, 3, 4]);
  assert.equal(groups[0].recommendedPrimaryId, 2);
  assert.deepEqual(new Set(groups[0].reasons.map((reason) => reason.kind)), new Set(['email', 'phone']));
  assert.deepEqual(groups[1].contacts.map((item) => item.id), [7, 8]);
  assert.deepEqual(groups[1].reasons.map((reason) => reason.kind), ['name_birthday']);
});

test('shared merge selection and field preservation work without a SQLite connection', () => {
  const primary = contact({ id: 1, name: 'Ada', email: 'ada@example.test', notes: 'First memory' });
  const duplicate = contact({ id: 2, name: 'Ada L.', email: 'ADA@example.test', phone: '+351 912 345 678', notes: 'Second memory' });
  const selected = validateContactMergeSelection(1, [2], [primary, duplicate]);
  const merged = buildMergedContact(selected.primary, selected.duplicates, '2026-10-03T00:00:00.000Z');
  assert.match(merged.notes!, /First memory/);
  assert.match(merged.notes!, /Second memory/);
  assert.equal(merged.phone, '+351 912 345 678');
  assert.throws(() => validateContactMergeSelection(1, [2], [primary]),
    (error: unknown) => error instanceof ContactMergeError && error.code === 'not_found');
  assert.throws(() => validateContactMergeSelection(1, [3], [primary, contact({ id: 3, name: 'Other' })]),
    (error: unknown) => error instanceof ContactMergeError && error.code === 'not_duplicates');
});

test('merging contacts preserves linked-child references and collapses duplicate connections', () => {
  const db = createDatabase();
  try {
    const primaryId = insertContact(db, { name: 'Ada Primary', email: 'ada@example.test' });
    const duplicateId = insertContact(db, { name: 'Ada Duplicate', email: 'ADA@example.test' });
    const childId = insertContact(db, { name: 'Lia Child', birthday: '2020-06-01' });
    const relativeId = insertContact(db, { name: 'Relative' });
    const addChild = db.prepare('INSERT INTO contact_children (contact_id, linked_contact_id, name) VALUES (?, ?, ?)');
    addChild.run(primaryId, childId, 'Lia');
    addChild.run(duplicateId, childId, 'Lia again');
    addChild.run(relativeId, duplicateId, 'Ada');
    addChild.run(relativeId, primaryId, 'Ada again');
    addChild.run(duplicateId, null, 'Unlinked child');
    const addRelationship = db.prepare(`INSERT INTO contact_relationships
      (contact_id, related_contact_id, relationship_label, reciprocal_label) VALUES (?, ?, 'relative', 'relative')`);
    addRelationship.run(primaryId, relativeId);
    addRelationship.run(duplicateId, relativeId);

    const result = mergeContacts(db, primaryId, [duplicateId]);
    assert.equal(result.moved.children, 3);
    assert.equal(result.moved.relationships, 1);
    assert.deepEqual(db.prepare(`SELECT contact_id, linked_contact_id, name FROM contact_children ORDER BY contact_id, linked_contact_id, name`)
      .all(), [
      { contact_id: primaryId, linked_contact_id: null, name: 'Unlinked child' },
      { contact_id: primaryId, linked_contact_id: childId, name: 'Lia' },
      { contact_id: relativeId, linked_contact_id: primaryId, name: 'Ada again' },
    ]);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM contact_relationships').get() as { count: number }).count, 1);
  } finally { db.close(); }
});

test('a merge that would create a self-child link leaves every row unchanged', () => {
  const db = createDatabase();
  try {
    const primaryId = insertContact(db, { name: 'Ada Primary', email: 'ada@example.test' });
    const duplicateId = insertContact(db, { name: 'Ada Duplicate', email: 'ADA@example.test' });
    db.prepare('INSERT INTO contact_children (contact_id, linked_contact_id, name) VALUES (?, ?, ?)')
      .run(primaryId, duplicateId, 'Ada');
    assert.throws(() => mergeContacts(db, primaryId, [duplicateId]),
      (error: unknown) => error instanceof ContactMergeError && /own child/.test(error.message));
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM contacts').get() as { count: number }).count, 2);
    assert.deepEqual(db.prepare('SELECT contact_id, linked_contact_id FROM contact_children').all(),
      [{ contact_id: primaryId, linked_contact_id: duplicateId }]);
  } finally { db.close(); }
});

test('contact merge preserves fields and moves every relationship record atomically', () => {
  const db = createDatabase();
  try {
    const primaryId = insertContact(db, {
      name: 'Ada Primary',
      email: 'ada.primary@example.test',
      phone: '+49 30 555 0101',
      tags: JSON.stringify(['friend']),
      notes: 'Primary notes',
      gift_ideas: JSON.stringify(['Book']),
      custom_fields: JSON.stringify({ company: 'Primary Labs', nested: { primary: true } }),
      last_contacted: '2026-07-01',
      contact_frequency: 21,
    });
    const duplicateId = insertContact(db, {
      name: 'Ada Duplicate',
      nickname: 'Addie',
      email: 'ada.secondary@example.test',
      phone: '+49 (30) 555-0101',
      photo_url: 'https://example.test/ada.jpg',
      birthday: '1990-03-04',
      how_we_met: 'Conference',
      tags: JSON.stringify(['work', 'friend']),
      notes: 'Duplicate notes',
      gift_ideas: JSON.stringify(['Coffee', 'Book']),
      custom_fields: JSON.stringify({
        company: 'Secondary Labs',
        location: 'Berlin',
        nested: { secondary: true },
        vcard: { additional_emails: ['ada.other@example.test'] },
      }),
      last_contacted: '2026-07-09',
      contact_frequency: 7,
    });

    const groupOne = Number(db.prepare('INSERT INTO contact_groups (name) VALUES (?)').run('Friends').lastInsertRowid);
    const groupTwo = Number(db.prepare('INSERT INTO contact_groups (name) VALUES (?)').run('Work').lastInsertRowid);
    db.prepare('INSERT INTO contact_group_members (contact_id, group_id) VALUES (?, ?)').run(primaryId, groupOne);
    db.prepare('INSERT INTO contact_group_members (contact_id, group_id) VALUES (?, ?)').run(duplicateId, groupOne);
    db.prepare('INSERT INTO contact_group_members (contact_id, group_id) VALUES (?, ?)').run(duplicateId, groupTwo);
    db.prepare('INSERT INTO interactions (contact_id, date, type, summary) VALUES (?, ?, ?, ?)')
      .run(duplicateId, '2026-07-09', 'message', 'Hello');
    db.prepare('INSERT INTO reminders (contact_id, title, remind_at) VALUES (?, ?, ?)')
      .run(duplicateId, 'Follow up', '2026-08-01T09:00:00Z');
    db.prepare('INSERT INTO relationship_facts (contact_id, category, label, value) VALUES (?, ?, ?, ?)')
      .run(duplicateId, 'personal', 'City', 'Berlin');
    db.prepare('INSERT INTO plans (contact_id, type, planned_date, summary) VALUES (?, ?, ?, ?)')
      .run(duplicateId, 'meetup', '2026-08-10', 'Coffee');
    const spouseId = insertContact(db, { name: 'Grace Spouse' });
    db.prepare(`
      INSERT INTO contact_relationships (
        contact_id, related_contact_id, relationship_label, reciprocal_label
      ) VALUES (?, ?, ?, ?)
    `).run(duplicateId, spouseId, 'Wife', 'Wife');
    db.prepare('INSERT INTO contact_children (contact_id, name, birthday) VALUES (?, ?, ?)')
      .run(duplicateId, 'Lin', '2020-05-12');

    const result = mergeContacts(db, primaryId, [duplicateId], '2026-07-10T18:00:00.000Z');
    assert.deepEqual(result.moved, {
      interactions: 1,
      reminders: 1,
      facts: 1,
      plans: 1,
      groups: 2,
      relationships: 1,
      children: 1,
    });
    assert.deepEqual(result.mergedContactIds, [duplicateId]);
    assert.equal(result.contact.id, primaryId);
    assert.equal(result.contact.name, 'Ada Primary');
    assert.equal(result.contact.nickname, 'Addie');
    assert.equal(result.contact.email, 'ada.primary@example.test');
    assert.equal(result.contact.photo_url, 'https://example.test/ada.jpg');
    assert.equal(result.contact.birthday, '1990-03-04');
    assert.equal(result.contact.contact_frequency, 21);
    assert.equal(result.contact.last_contacted, '2026-07-09');
    assert.deepEqual(JSON.parse(result.contact.tags!), ['friend', 'work']);
    assert.deepEqual(JSON.parse(result.contact.gift_ideas!), ['Book', 'Coffee']);
    assert.match(result.contact.notes!, /Primary notes/);
    assert.match(result.contact.notes!, /Duplicate notes/);

    const customFields = JSON.parse(result.contact.custom_fields!);
    assert.equal(customFields.company, 'Primary Labs');
    assert.equal(customFields.location, 'Berlin');
    assert.deepEqual(customFields.nested, { primary: true, secondary: true });
    assert.deepEqual(
      customFields.vcard.additional_emails,
      ['ada.secondary@example.test', 'ada.other@example.test']
    );
    assert.equal(customFields._bonds.merge_history[0].source_contact_id, duplicateId);
    assert.deepEqual(customFields._bonds.merge_history[0].custom_field_conflicts, [
      { field: 'company', value: 'Secondary Labs' },
    ]);

    assert.equal((db.prepare('SELECT COUNT(*) count FROM contacts').get() as { count: number }).count, 2);
    for (const table of ['interactions', 'reminders', 'relationship_facts', 'plans']) {
      const row = db.prepare(`SELECT contact_id FROM ${table}`).get() as { contact_id: number };
      assert.equal(row.contact_id, primaryId, table);
    }
    assert.deepEqual(
      (db.prepare('SELECT group_id FROM contact_group_members WHERE contact_id = ? ORDER BY group_id').all(primaryId) as Array<{ group_id: number }>).map((row) => row.group_id),
      [groupOne, groupTwo]
    );
    assert.deepEqual(
      db.prepare(`
        SELECT contact_id, related_contact_id, relationship_label, reciprocal_label
        FROM contact_relationships
      `).get(),
      {
        contact_id: primaryId,
        related_contact_id: spouseId,
        relationship_label: 'Wife',
        reciprocal_label: 'Wife',
      }
    );
    assert.deepEqual(
      db.prepare('SELECT contact_id, name, birthday FROM contact_children').get(),
      { contact_id: primaryId, name: 'Lin', birthday: '2020-05-12' }
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('merge rejects unrelated contacts and rolls back every change on relational failure', () => {
  const db = createDatabase();
  try {
    const primaryId = insertContact(db, { name: 'Primary', email: 'shared@example.test', notes: 'Original' });
    const duplicateId = insertContact(db, { name: 'Duplicate', email: 'SHARED@example.test', notes: 'Duplicate' });
    const unrelatedId = insertContact(db, { name: 'Unrelated', email: 'elsewhere@example.test' });

    assert.throws(
      () => mergeContacts(db, primaryId, [unrelatedId]),
      (error) => error instanceof ContactMergeError && error.code === 'not_duplicates'
    );

    db.prepare('INSERT INTO interactions (contact_id, date, type) VALUES (?, ?, ?)')
      .run(duplicateId, '2026-07-10', 'call');
    db.exec(`
      CREATE TRIGGER reject_contact_merge BEFORE UPDATE OF contact_id ON interactions
      BEGIN SELECT RAISE(ABORT, 'relationship move rejected'); END;
    `);
    assert.throws(
      () => mergeContacts(db, primaryId, [duplicateId], '2026-07-10T18:00:00.000Z'),
      /relationship move rejected/i
    );

    assert.equal((db.prepare('SELECT COUNT(*) count FROM contacts').get() as { count: number }).count, 3);
    assert.equal((db.prepare('SELECT notes FROM contacts WHERE id = ?').get(primaryId) as { notes: string }).notes, 'Original');
    assert.equal(
      (db.prepare('SELECT contact_id FROM interactions').get() as { contact_id: number }).contact_id,
      duplicateId
    );
  } finally {
    db.close();
  }
});
