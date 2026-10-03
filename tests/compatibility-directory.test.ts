import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import { initializeDatabase } from '../lib/database-initialization.ts';
import {
  listNumericGroupMemberPage,
  listNumericGroupPage,
} from '../lib/numeric-group-directory.ts';
import { listPlanPage } from '../lib/plan-directory.ts';

function createDatabase() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const contactIds: number[] = [];
  for (let id = 1; id <= 137; id += 1) {
    contactIds.push(Number(db.prepare(`
      INSERT INTO contacts (name, email, notes)
      VALUES (?, ?, ?)
    `).run(
      `Compatibility Contact ${String(id).padStart(3, '0')}`,
      `compatibility-${id}@example.test`,
      `Private compatibility note ${id}`
    ).lastInsertRowid));
  }
  return { db, contactIds };
}

test('plan directory preserves status semantics with bounded stable pages', () => {
  const { db, contactIds } = createDatabase();
  try {
    const insert = db.prepare(`
      INSERT INTO plans (contact_id, type, planned_date, summary, completed_at)
      VALUES (?, 'call', ?, ?, ?)
    `);
    for (let id = 1; id <= 137; id += 1) {
      insert.run(
        contactIds[0],
        new Date(Date.UTC(2026, 8, id)).toISOString().slice(0, 10),
        `Plan ${id}`,
        id > 100 ? '2026-07-01T10:00:00.000Z' : null
      );
    }
    insert.run(contactIds[1], '2030-01-01', 'Other contact plan', null);

    const open = listPlanPage(db, { status: 'open' });
    assert.equal(open.plans.length, 50);
    assert.equal(open.pagination.total, 101);
    assert.equal(open.pagination.totalPages, 3);

    const allForContact = listPlanPage(db, {
      contactId: contactIds[0],
      status: 'all',
      page: 3,
    });
    assert.equal(allForContact.pagination.total, 137);
    assert.equal(allForContact.plans.length, 37);

    const completed = listPlanPage(db, { status: 'completed' });
    assert.equal(completed.pagination.total, 37);
    assert(completed.plans.every((plan) => plan.completed_at !== null));

    const clamped = listPlanPage(db, { status: 'all', pageSize: 10_000 });
    assert.equal(clamped.pagination.pageSize, 100);
    assert.equal(clamped.plans.length, 100);
  } finally {
    db.close();
  }
});

test('numeric group summaries and full members remain reachable through bounded pages', () => {
  const { db, contactIds } = createDatabase();
  try {
    const groupIds: number[] = [];
    for (let id = 1; id <= 137; id += 1) {
      groupIds.push(Number(db.prepare(`
        INSERT INTO contact_groups (name, color) VALUES (?, '#e11d48')
      `).run(`Numeric Group ${String(id).padStart(3, '0')}`).lastInsertRowid));
    }
    const addMember = db.prepare(`
      INSERT INTO contact_group_members (contact_id, group_id) VALUES (?, ?)
    `);
    for (const contactId of contactIds) addMember.run(contactId, groupIds[0]);
    addMember.run(contactIds[0], groupIds[1]);

    const groups = listNumericGroupPage(db);
    assert.equal(groups.groups.length, 50);
    assert.deepEqual(groups.pagination, {
      page: 1,
      pageSize: 50,
      total: 137,
      totalPages: 3,
    });
    assert.equal(groups.groups[0].member_count, 137);

    const lastGroups = listNumericGroupPage(db, { page: 99 });
    assert.equal(lastGroups.pagination.page, 3);
    assert.equal(lastGroups.groups.length, 37);

    const members = listNumericGroupMemberPage(db, groupIds[0]);
    assert.equal(members.members.length, 50);
    assert.equal(members.pagination.total, 137);
    assert.equal(members.members[0].notes, 'Private compatibility note 1');

    const lastMembers = listNumericGroupMemberPage(db, groupIds[0], { page: 3 });
    assert.equal(lastMembers.members.length, 37);
    assert.notEqual(lastMembers.members[0].id, members.members[0].id);
  } finally {
    db.close();
  }
});
