import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('relationship completion transitions are write-once', () => {
  const mutations = readFileSync('lib/relationship-mutations.ts', 'utf8');
  assert.match(mutations, /completeReminderRecord/);
  assert.match(mutations, /WHERE id = \? AND completed_at IS NULL/);
  assert.match(mutations, /'already-completed'/);

  const reminderRoute = readFileSync('app/api/reminders/[id]/route.ts', 'utf8');
  assert.match(reminderRoute, /completeReminderRecord\(db, reminderId\)/);
  assert.match(reminderRoute, /completionChanged: completion\.status === 'completed'/);

  const planRoute = readFileSync('app/api/plans/[id]/route.ts', 'utf8');
  assert.match(planRoute, /interactionCreated: completion\.status === 'completed'/);
});

test('valid repeated relationship deletes report the achieved final state', () => {
  for (const filename of [
    'app/api/interactions/[id]/route.ts',
    'app/api/reminders/[id]/route.ts',
    'app/api/plans/[id]/route.ts',
  ]) {
    const source = readFileSync(filename, 'utf8');
    assert.match(source, /alreadyDeleted:/, filename);
    const deleteHandler = source.slice(source.indexOf('export async function DELETE'));
    assert.match(deleteHandler, /if \(!\w+Id\).*status: 404/, filename);
  }

  const contactRoute = readFileSync('app/api/contacts/[id]/route.ts', 'utf8');
  const deleteHandler = contactRoute.slice(contactRoute.indexOf('export async function DELETE'));
  assert.match(deleteHandler, /alreadyDeleted: false/);
  assert.match(deleteHandler, /success: true, affected: 0, alreadyDeleted: true/);
});

test('consumer messages distinguish fresh transitions from replayed state', () => {
  const detail = readFileSync('app/contacts/[id]/page.tsx', 'utf8');
  assert.match(detail, /Contact was already deleted/);
  assert.match(detail, /Interaction was already deleted/);
  assert.match(detail, /Plan was already completed/);
  assert.match(detail, /Plan was already deleted/);

  const reminders = readFileSync('app/reminders/page.tsx', 'utf8');
  assert.match(reminders, /Reminder was already completed/);
  assert.match(reminders, /Reminder was already deleted/);
});
