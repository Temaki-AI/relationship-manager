import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import {
  loadDuplicateReview,
  MAX_DUPLICATE_BATCH_CONTACTS,
} from '../lib/duplicate-directory.ts';
import { initializeDatabase } from '../lib/database-initialization.ts';
import { mergeContacts, validateContactMergeSelection } from '../lib/contact-merge.ts';

function insertContact(
  db: Database.Database,
  input: { name: string; email?: string; notes?: string; customFields?: string }
): number {
  return Number(db.prepare(`
    INSERT INTO contacts (name, email, notes, custom_fields)
    VALUES (?, ?, ?, ?)
  `).run(
    input.name,
    input.email || null,
    input.notes || null,
    input.customFields || null
  ).lastInsertRowid);
}

test('duplicate review scans minimal identities and pages hydrated merge batches', () => {
  const db = new Database(':memory:');
  initializeDatabase(db);
  try {
    const oversizedIds: number[] = [];
    for (let index = 1; index <= 25; index += 1) {
      oversizedIds.push(insertContact(db, {
        name: `Oversized ${index}`,
        email: 'oversized@example.test',
        notes: `Visible duplicate note ${index}`,
      }));
    }
    db.prepare(`
      INSERT INTO interactions (contact_id, date, type, summary)
      VALUES (?, '2026-07-11', 'message', 'Recommended by activity')
    `).run(oversizedIds.at(-1));

    for (let group = 1; group <= 30; group += 1) {
      const email = `group-${group}@example.test`;
      insertContact(db, { name: `Group ${group} A`, email });
      insertContact(db, { name: `Group ${group} B`, email: email.toUpperCase() });
    }
    insertContact(db, {
      name: 'Secondary Address Match',
      customFields: JSON.stringify({
        vcard: { additional_emails: ['group-30@example.test'] },
        unrelated_private_blob: 'private'.repeat(1_000),
      }),
    });

    for (let index = 1; index <= 500; index += 1) {
      insertContact(db, {
        name: `Unique ${index}`,
        email: `unique-${index}@example.test`,
        notes: `Private unique note ${index} `.repeat(100),
      });
    }

    const first = loadDuplicateReview(db);
    assert.equal(first.groupCount, 31);
    assert.equal(first.contactCount, 86);
    assert.equal(first.groups.length, 10);
    assert.deepEqual(first.pagination, {
      page: 1,
      pageSize: 10,
      total: 31,
      totalPages: 4,
    });
    assert.equal(first.truncatedGroupCount, 1);

    const oversized = first.groups[0];
    assert.equal(oversized.totalContacts, 25);
    assert.equal(oversized.hasMoreContacts, true);
    assert.equal(oversized.contacts.length, MAX_DUPLICATE_BATCH_CONTACTS);
    assert.equal(oversized.recommendedPrimaryId, oversizedIds.at(-1));
    assert(oversized.contacts.some((contact) => contact.id === oversized.recommendedPrimaryId));
    assert(oversized.id.length < 60);
    assert(oversized.contacts.every((contact) => contact.notes?.startsWith('Visible duplicate note')));
    assert.equal(JSON.stringify(first).includes('Private unique note'), false);

    const last = loadDuplicateReview(db, { page: 99 });
    assert.equal(last.pagination.page, 4);
    assert.equal(last.groups.length, 1);
    assert.equal(last.groups[0].contacts.length, 3);
    assert(last.groups[0].reasons.some((reason) => reason.kind === 'email'));

    const clamped = loadDuplicateReview(db, { pageSize: 500 });
    assert.equal(clamped.pagination.pageSize, 25);
    assert.equal(clamped.groups.length, 25);
  } finally {
    db.close();
  }
});

test('an oversized transitive match offers only a connected merge batch', () => {
  const db = new Database(':memory:');
  initializeDatabase(db);
  try {
    const ids: number[] = [];
    for (let index = 1; index <= 25; index += 1) {
      ids.push(insertContact(db, {
        name: `Chain ${index}`,
        email: `chain-${index}@example.test`,
        customFields: index < 25 ? JSON.stringify({
          vcard: { additional_emails: [`chain-${index + 1}@example.test`] },
        }) : undefined,
      }));
    }
    db.prepare(`INSERT INTO interactions (contact_id, date, type)
      VALUES (?, '2026-07-11', 'message')`).run(ids.at(-1));
    const review = loadDuplicateReview(db);
    assert.equal(review.groupCount, 1);
    const group = review.groups[0];
    assert.equal(group.contacts.length, MAX_DUPLICATE_BATCH_CONTACTS);
    assert.equal(group.recommendedPrimaryId, ids.at(-1));
    assert(!group.contacts.some((contact) => contact.id === ids[0]));
    const chosen = group.contacts.map((contact) => contact.id);
    assert.doesNotThrow(() => validateContactMergeSelection(group.recommendedPrimaryId,
      chosen.filter((id) => id !== group.recommendedPrimaryId), group.contacts));
    mergeContacts(db, group.recommendedPrimaryId,
      chosen.filter((id) => id !== group.recommendedPrimaryId));
    const remaining = loadDuplicateReview(db);
    assert.equal(remaining.groupCount, 1);
    assert.equal(remaining.groups[0].contacts.length, 5);
    const remainingIds = remaining.groups[0].contacts.map((contact) => contact.id);
    mergeContacts(db, group.recommendedPrimaryId,
      remainingIds.filter((id) => id !== group.recommendedPrimaryId));
    assert.equal(loadDuplicateReview(db).groupCount, 0);
  } finally { db.close(); }
});
