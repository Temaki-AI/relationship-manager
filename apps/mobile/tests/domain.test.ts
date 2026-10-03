import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContactValidationError,
  getInitials,
  getRelationshipState,
  normalizeContactDraft,
  type ContactRecord,
} from '../src/domain/contact.ts';
import {
  getReminderPresetDate,
  normalizeReminderDraft,
  ReminderValidationError,
} from '../src/domain/reminder.ts';

function contact(lastContacted: string | null, frequency = 14): ContactRecord {
  return {
    id: 'contact-id',
    remote_id: null,
    device_contact_id: null,
    name: 'Ada Lovelace',
    email: null,
    phone: null,
    birthday: null,
    how_we_met: null,
    notes: null,
    last_contacted: lastContacted,
    contact_frequency: frequency,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    deleted_at: null,
    sync_state: 'local',
  };
}

test('mobile contacts preserve the validated web field limits and defaults', () => {
  assert.deepEqual(normalizeContactDraft({
    name: '  Ada Lovelace  ',
    email: ' ada@example.test ',
    phone: ' +44 20 0000 0000 ',
    notes: ' First programmer. ',
  }), {
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    phone: '+44 20 0000 0000',
    notes: 'First programmer.',
    contactFrequency: 14,
    deviceContactId: null,
  });
  assert.equal(getInitials('Ada Byron Lovelace'), 'ABL'.slice(0, 2));
  assert.throws(
    () => normalizeContactDraft({ name: 'Ada', email: 'not-an-email' }),
    ContactValidationError
  );
  assert.throws(
    () => normalizeContactDraft({ name: 'Ada', contactFrequency: 0 }),
    /between 1 and 3,650 days/
  );
});

test('relationship cadence distinguishes new, steady, due, and overdue contacts', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');
  assert.equal(getRelationshipState(contact(null), now), 'new');
  assert.equal(getRelationshipState(contact('2026-07-10T12:00:00.000Z'), now), 'steady');
  assert.equal(getRelationshipState(contact('2026-07-01T12:00:00.000Z'), now), 'due');
  assert.equal(getRelationshipState(contact('2026-06-20T12:00:00.000Z'), now), 'overdue');
});

test('reminder presets use local morning time and validation rejects stale reminders', () => {
  const now = new Date('2026-07-11T16:30:00.000Z');
  const tomorrow = getReminderPresetDate('tomorrow', now);
  assert.equal(tomorrow.getDate(), new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getDate());
  assert.equal(tomorrow.getHours(), 9);
  assert.equal(tomorrow.getMinutes(), 0);

  const normalized = normalizeReminderDraft({
    contactId: ' contact-id ',
    title: ' Ask about the new role ',
    remindAt: tomorrow,
  }, now);
  assert.equal(normalized.contactId, 'contact-id');
  assert.equal(normalized.title, 'Ask about the new role');
  assert.equal(normalized.remindAt, tomorrow.toISOString());
  assert.throws(
    () => normalizeReminderDraft({ contactId: 'contact-id', title: 'Late', remindAt: now }, now),
    ReminderValidationError
  );
});
