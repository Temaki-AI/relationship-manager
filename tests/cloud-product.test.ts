import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import { dateInTimeZone } from '../lib/civil-date.ts';
import { TINY_PNG_DATA_URL } from './fixtures.ts';

test('linked child profiles are tenant-scoped, editable, and appear once in the calendar', async () => {
  const h = await createCloudHarness();
  try {
    const parent = (await h.call('contacts', { method: 'POST', body: { name: 'Parent' } })).body.contact;
    const childProfile = (await h.call('contacts', { method: 'POST', body: { name: 'Child profile', birthday: '2020-07-16' } })).body.contact;
    const foreign = (await h.call('contacts', { workspace: 'other', method: 'POST', body: { name: 'Foreign child' } })).body.contact;
    assert.equal((await h.call(`contacts/${parent.id}/children`, { method: 'POST', body: {
      name: 'Wrong', linked_contact_id: foreign.id,
    } })).status, 404);
    assert.equal((await h.call(`contacts/${parent.id}/children`, { method: 'POST', body: {
      name: 'Self', linked_contact_id: parent.id,
    } })).status, 400);
    assert.equal((await h.call(`contacts/${parent.id}/children`, { method: 'POST', body: {
      name: 'Mismatch', birthday: '2020-07-17', linked_contact_id: childProfile.id,
    } })).status, 400);
    const added = await h.call(`contacts/${parent.id}/children`, { method: 'POST', body: {
      name: 'Old alias', birthday: '2020-07-16', linked_contact_id: childProfile.id,
    } });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const child = added.body.child;
    const listed = await h.call(`contacts/${parent.id}/children`);
    assert.equal(listed.body.children[0].linked_name, 'Child profile');
    assert.equal(listed.body.children[0].linked_birthday, '2020-07-16');
    assert.equal((await h.call(`contacts/${parent.id}/children`, { method: 'POST', body: {
      name: 'Duplicate', linked_contact_id: childProfile.id,
    } })).status, 409);
    const stale = await h.call(`contacts/${parent.id}/children/${child.id}`, { method: 'PATCH', body: {
      name: 'Edited', birthday: null, linked_contact_id: childProfile.id, expected_updated_at: 'stale',
    } });
    assert.equal(stale.status, 409);
    const edited = await h.call(`contacts/${parent.id}/children/${child.id}`, { method: 'PATCH', body: {
      name: 'Edited', birthday: null, linked_contact_id: childProfile.id, expected_updated_at: child.updated_at,
    } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const events = (await h.call('calendar?start=2026-07-16&end=2026-07-16&timeZone=UTC')).body.events;
    assert.deepEqual(events.filter((event: { kind: string }) => event.kind === 'birthday').map((event: { subtype: string; title: string }) => [event.subtype, event.title]), [
      ['contact', "Child profile's birthday"],
    ]);
    await assert.rejects(h.db.prepare('UPDATE contact_children SET linked_contact_id = ? WHERE id = ?')
      .bind(foreign.id, child.id).run(), /CLOUD_CHILD_LINK_INVALID/);
    await h.call(`contacts/${childProfile.id}`, { method: 'DELETE' });
    const remaining = (await h.call(`contacts/${parent.id}/children`)).body.children[0];
    assert.equal(remaining.linked_contact_id, null);
  } finally { await h.close(); }
});

test('cloud stats report real tenant-scoped check-ins and time-zone-aware birthdays', async () => {
  const h = await createCloudHarness();
  try {
    const today = dateInTimeZone(new Date(), 'Pacific/Kiritimati')!;
    const eightDaysAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 8 * 86_400_000).toISOString().slice(0, 10);
    const contact = (await h.call('contacts', { method: 'POST', body: {
      name: 'Ada', birthday: `2000-${today.slice(5)}`, contact_frequency: 7,
    } })).body.contact;
    await h.call('interactions', { method: 'POST', body: {
      contact_id: contact.id, date: eightDaysAgo, type: 'call', summary: 'A conversation',
    } });
    await h.call('contacts', { workspace: 'other', method: 'POST', body: {
      name: 'Private', birthday: `2000-${today.slice(5)}`,
    } });
    const response = await h.call('stats?timeZone=Pacific%2FKiritimati');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.stats.totalContacts, 1);
    assert.equal(response.body.stats.readyToReconnectCount, 1);
    assert.deepEqual(response.body.actionItems, [contact.id]);
    assert.equal(response.body.stats.upcomingBirthdaysCount, 1);
    assert.equal(response.body.upcomingBirthdays[0].daysUntil, 0);
    assert.equal(response.body.stats.conversationsThisWeek, 0);
    const other = (await h.call('stats?timeZone=Pacific%2FKiritimati', { workspace: 'other' })).body;
    assert.equal(other.stats.totalContacts, 1);
    assert.equal(other.stats.readyToReconnectCount, 0);
    assert.equal(other.stats.upcomingBirthdaysCount, 1);
  } finally { await h.close(); }
});

test('cloud Today includes the exact check-in day and excludes another workspace', async () => {
  const h = await createCloudHarness();
  try {
    const today = dateInTimeZone(new Date(), 'Pacific/Kiritimati')!;
    const sevenDaysAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
    const person = (await h.call('contacts', { method: 'POST', body: {
      name: 'Ada', contact_frequency: 7, tags: ['friend'],
    } })).body.contact;
    await h.call('interactions', { method: 'POST', body: {
      contact_id: person.id, date: sevenDaysAgo, type: 'call', summary: 'A good conversation',
    } });
    await h.call('contacts', { workspace: 'other', method: 'POST', body: { name: 'Private' } });
    const overview = (await h.call('intelligence/overview?timeZone=Pacific%2FKiritimati')).body;
    assert.equal(overview.stats.checkInsDueCount, 1);
    assert.equal(overview.stats.overdueCount, 0);
    assert.equal(overview.feed[0]?.contactId, person.id);
    assert.match(overview.feed[0]?.detail || '', /Check-in day/);
    assert.ok(!JSON.stringify(overview).includes('Private'));
    const other = (await h.call('intelligence/overview?timeZone=Pacific%2FKiritimati', { workspace: 'other' })).body;
    assert.equal(other.stats.checkInsDueCount, 0);
  } finally { await h.close(); }
});

test('cloud overview and smart lists use actual workspace history and manual context', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada', tags: ['Friends'], contact_frequency: 7, custom_fields: { company: 'Manual Company', location: 'Lisbon' } } })).body.contact;
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    await h.call('interactions', { method: 'POST', body: { contact_id: contact.id, date: old, type: 'call', summary: 'Her new garden' } });
    await h.call('contacts', { workspace: 'other', method: 'POST', body: { name: 'Private Person', tags: ['Close circle'] } });
    const overview = await h.call('intelligence/overview?timeZone=Europe%2FLisbon');
    assert.equal(overview.status, 200);
    assert.equal(overview.body.stats.totalContacts, 1);
    assert.equal(overview.body.stats.overdueCount, 1);
    assert.equal(overview.body.feed[0].contactId, contact.id);
    assert.match(overview.body.feed[0].detail, /Manual Company/);
    assert.equal(overview.body.firstSteps.circleCount, 0);
    assert.equal(overview.body.firstSteps.hasLoggedMoment, true);
    const lists = (await h.call('smart-lists')).body.smartLists;
    assert.deepEqual(lists.find((list: { id: string }) => list.id === 'overdue-friends').entries.map((entry: { id: number }) => entry.id), [contact.id]);
    assert.ok(!JSON.stringify(overview.body).includes('Private Person'));
    const otherOverview = (await h.call('intelligence/overview', { workspace: 'other' })).body;
    assert.equal(otherOverview.stats.overdueCount, 0);
    assert.equal(otherOverview.firstSteps.circleCount, 1);
    assert.equal(otherOverview.firstSteps.hasLoggedMoment, false);
  } finally { await h.close(); }
});

test('cloud Today snoozes are tenant-scoped and preserve other reasons for a person', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada', email: 'ada@example.test', tags: ['friend'], contact_frequency: 7 } })).body.contact;
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    await h.call('interactions', { method: 'POST', body: { contact_id: contact.id, date: old, type: 'call', summary: 'The garden' } });
    const reminder = (await h.call('reminders', { method: 'POST', body: { contact_id: contact.id, title: 'Ask about seedlings', remind_at: new Date(Date.now() - 86_400_000).toISOString() } })).body.reminder;
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const reminderId = `reminder-${reminder.id}`;
    const before = (await h.call('intelligence/overview?timeZone=UTC')).body;
    assert.equal(before.feed[0].reminderId, reminder.id);
    assert.equal(before.feed[0].lastInteraction.summary, 'The garden');
    assert.equal(before.feed[0].contactEmail, 'ada@example.test');
    assert.equal((await h.call('today/snooze', { workspace: 'other', method: 'PUT', body: { id: reminderId, until, timeZone: 'UTC' } })).status, 404);
    assert.equal((await h.call('today/snooze', { method: 'PUT', body: { id: reminderId, until: '2000-01-01', timeZone: 'UTC' } })).status, 400);
    const saved = await h.call('today/snooze', { method: 'PUT', body: { id: reminderId, until, timeZone: 'UTC' } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await h.call('today/snooze', { method: 'PUT', body: { id: reminderId, until, timeZone: 'UTC' } })).status, 200);
    const after = (await h.call('intelligence/overview?timeZone=UTC')).body;
    assert.equal(after.feed[0].type, 'relationship');
    assert.equal(after.snoozes[0].id, reminderId);
    assert.equal(after.stats.openReminderCount, 1);
    assert.equal((await h.call('today/snooze', { method: 'PUT', body: { id: `overdue-${contact.id}`, until, timeZone: 'UTC' } })).status, 200);
    const quiet = (await h.call('intelligence/overview?timeZone=UTC')).body;
    assert.equal(quiet.feed.length, 0);
    assert.equal(quiet.stats.overdueCount, 0);
    assert.deepEqual((await h.call('smart-lists?timeZone=UTC')).body.smartLists.find((list: { id: string }) => list.id === 'overdue-friends').entries, []);
    await h.call('today/snooze', { method: 'DELETE', body: { id: reminderId } });
    assert.equal((await h.call('intelligence/overview?timeZone=UTC')).body.feed[0].reminderId, reminder.id);
    assert.equal((await h.call('intelligence/overview?timeZone=UTC', { workspace: 'other' })).body.snoozes.length, 0);
  } finally { await h.close(); }
});

test('cloud Today gives distinct people reminder slots and reveals the next task after completion', async () => {
  const h = await createCloudHarness();
  try {
    const ada = (await h.call('contacts', { method: 'POST', body: { name: 'Ada', birthday: dateInTimeZone(new Date(), 'UTC'), birthday_reminder_days: 0 } })).body.contact;
    const grace = (await h.call('contacts', { method: 'POST', body: { name: 'Grace' } })).body.contact;
    const due = new Date(Date.now() - 86_400_000).toISOString();
    const reminders = [];
    for (let index = 0; index < 5; index += 1) {
      reminders.push((await h.call('reminders', { method: 'POST', body: { contact_id: ada.id, title: `Ada task ${index + 1}`, remind_at: due } })).body.reminder);
    }
    const graceReminder = (await h.call('reminders', { method: 'POST', body: { contact_id: grace.id, title: 'Grace task', remind_at: due } })).body.reminder;
    const before = (await h.call('intelligence/overview?timeZone=UTC')).body;
    assert.deepEqual(before.feed.map((item: { contactId: number }) => item.contactId).sort(), [ada.id, grace.id].sort());
    assert.equal(before.feed.find((item: { contactId: number }) => item.contactId === ada.id).reminderId, reminders[0].id);
    assert.equal(before.feed.find((item: { contactId: number }) => item.contactId === grace.id).reminderId, graceReminder.id);
    assert.equal(before.stats.openReminderCount, 6);
    assert.equal((await h.call(`reminders/${reminders[0].id}`, { method: 'PATCH', body: { completed: true } })).status, 200);
    const after = (await h.call('intelligence/overview?timeZone=UTC')).body;
    assert.equal(after.feed.find((item: { contactId: number }) => item.contactId === ada.id).reminderId, reminders[1].id);
    assert.equal(after.stats.openReminderCount, 5);
    for (const reminder of reminders.slice(1)) {
      assert.equal((await h.call(`reminders/${reminder.id}`, { method: 'PATCH', body: { completed: true } })).status, 200);
    }
    const occasion = (await h.call('intelligence/overview?timeZone=UTC')).body;
    assert.equal(occasion.feed.find((item: { contactId: number }) => item.contactId === ada.id).type, 'birthday');
    assert.equal(occasion.stats.openReminderCount, 1);
    const history = await h.db.prepare('SELECT COUNT(*) AS count FROM interactions WHERE workspace_id = ?').bind('test').first<{ count: number }>();
    assert.equal(history?.count, 0, 'completion must not invent an interaction');
  } finally { await h.close(); }
});

test('cloud profiles expose grounded briefs and complete paginated timelines, excluding completed tasks from open panels', async () => {
  const h = await createCloudHarness();
  try {
    const contact = (await h.call('contacts', { method: 'POST', body: { name: 'Ada', custom_fields: { company: 'Her Company' } } })).body.contact;
    await h.db.prepare(`INSERT INTO interactions(workspace_id, contact_id, date, type, summary)
      SELECT 'test', ?, '2026-08-01', 'call', 'Conversation ' || value FROM json_each(?)`).bind(contact.id, JSON.stringify(Array.from({ length: 35 }, (_, index) => index))).run();
    const reminder = (await h.call('reminders', { method: 'POST', body: { contact_id: contact.id, title: 'Completed task', remind_at: '2026-08-02T10:00:00Z' } })).body.reminder;
    await h.call(`reminders/${reminder.id}`, { method: 'PATCH', body: { completed: true } });
    await h.call('reminders', { method: 'POST', body: { contact_id: contact.id, title: 'Ask about seedlings', remind_at: '2026-10-01T10:00:00Z' } });
    const response = await h.call(`contacts/${contact.id}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.history.interactions.total, 35);
    assert.equal(response.body.interactions.length, 30);
    assert.match(response.body.brief.summary, /Her Company.*Conversation 34.*Ask about seedlings/);
    assert.equal(response.body.reminders.length, 1);
    assert.equal(response.body.reminders[0].title, 'Ask about seedlings');
    const first = await h.call(`contacts/${contact.id}?view=timeline&pageSize=10`);
    const pages = [];
    for (let page = 1; page <= first.body.pagination.totalPages; page++) {
      const next = await h.call(`contacts/${contact.id}?view=timeline&pageSize=10&page=${page}`);
      pages.push(...next.body.timeline);
    }
    assert.equal(pages.length, first.body.pagination.total);
    assert.equal(new Set(pages.map((item: { id: string }) => item.id)).size, pages.length);
    assert.equal(pages.filter((item: { kind: string }) => item.kind === 'interaction').length, 35);
    assert.ok(pages.some((item: { summary: string }) => item.summary === 'Reminder completed'));
    const conversations = await h.call(`contacts/${contact.id}?view=timeline&kind=interaction&pageSize=10`);
    assert.equal(conversations.body.pagination.total, 35);
    assert.equal(conversations.body.timeline.length, 10);
    assert(conversations.body.timeline.every((item: { kind: string }) => item.kind === 'interaction'));
    const nextConversations = await h.call(`contacts/${contact.id}?view=timeline&kind=interaction&pageSize=10&page=2`);
    assert.equal(nextConversations.body.pagination.total, 35);
    assert.equal(new Set([...conversations.body.timeline, ...nextConversations.body.timeline]
      .map((item: { id: string }) => item.id)).size, 20);
    assert.equal((await h.call(`contacts/${contact.id}?view=timeline&kind=other`)).status, 400);
    const firstInteractionId = Number(conversations.body.timeline[0].id.replace('interaction-', ''));
    const interactionDetail = await h.call(`interactions/${firstInteractionId}`);
    assert.equal(interactionDetail.status, 200);
    assert.equal(interactionDetail.body.interaction.contact_id, contact.id);
    assert.match(interactionDetail.body.interaction.edit_revision, /^[a-f0-9]{64}$/);
    assert.equal((await h.call(`interactions/${firstInteractionId}`, { workspace: 'other' })).status, 404);
    assert.equal((await h.call(`contacts/${contact.id}?view=timeline`, { workspace: 'other' })).status, 404);
  } finally { await h.close(); }
});

test('cloud directory filters tags exactly and searches notes, imported context, and long literal strings', async () => {
  const h = await createCloudHarness();
  try {
    const marker = 'A literal 100%_\\ note ' + 'x'.repeat(75);
    const ada = (await h.call('contacts', { method: 'POST', body: { name: 'Ada', tags: ['Friends'], notes: marker, custom_fields: { linkedin: { location: 'Lisbon' } } } })).body.contact;
    await h.call('contacts', { method: 'POST', body: { name: 'Grace', tags: ['friends-of-friends'], notes: 'Other' } });
    await h.call('contacts', { workspace: 'other', method: 'POST', body: { name: 'Other Ada', tags: ['friends'], notes: marker } });
    for (const query of ['tag=FRIENDS', 'search=Lisbon', `search=${encodeURIComponent(marker)}`, 'tag=friends&search=Ada']) {
      const result = await h.call(`contacts?${query}`);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.contacts.map((contact: { id: number }) => contact.id), [ada.id]);
      assert.equal(result.body.pagination.total, 1);
    }
    assert.equal((await h.call('contacts?tag=friends&search=Grace')).body.pagination.total, 0);
    assert.equal((await h.call('contacts?search=linkedin')).body.pagination.total, 0, 'JSON keys are not searchable facts');
  } finally { await h.close(); }
});

test('cloud directory projects private fields and serves embedded photos only within the workspace', async () => {
  const h = await createCloudHarness();
  try {
    const created = await h.call('contacts', { method: 'POST', body: {
      name: 'Photo Person', photo_url: TINY_PNG_DATA_URL, notes: 'Private memory',
      custom_fields: { company: 'Manual Company', linkedin: { company: 'Imported Company', location: 'Lisbon' } },
    } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.contact.id as number;
    const listed = await h.call('contacts');
    const contact = listed.body.contacts[0];
    assert.equal(contact.photo_url, `/api/contacts/${id}/photo`);
    assert.equal(contact.company, 'Manual Company');
    assert.equal(contact.location, 'Lisbon');
    assert.equal('notes' in contact, false);
    assert.equal('custom_fields' in contact, false);
    assert.equal((await h.call(`contacts/${id}`)).body.contact.notes, 'Private memory');
    const image = await h.call(`contacts/${id}/photo`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('Content-Type'), 'image/png');
    assert.equal(image.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(image.body, Array.from(Buffer.from(TINY_PNG_DATA_URL.split(',')[1], 'base64')));
    assert.equal((await h.call(`contacts/${id}/photo`, { workspace: 'other' })).status, 404);
  } finally { await h.close(); }
});

test('cloud bulk tags preserve concurrent changes and accept 500 IDs without partial foreign-workspace changes', async () => {
  const h = await createCloudHarness();
  try {
    await h.db.prepare(`INSERT INTO contacts(workspace_id, name) SELECT 'test', 'Person ' || value FROM json_each(?)`)
      .bind(JSON.stringify(Array.from({ length: 500 }, (_, i) => i))).run();
    const rows = (await h.db.prepare("SELECT id FROM contacts WHERE workspace_id = 'test'").all()).results;
    const ids = rows.map((row: { id: number }) => row.id);
    const change = (tag: string, operation = 'add_tag', contactIds = ids) => h.call('contacts/bulk', { method: 'POST', body: { contactIds, operation, tag } });
    const concurrent = await Promise.all(['friends', 'work'].map((tag) => change(tag)));
    assert.deepEqual(concurrent.map((result) => result.status), [200, 200]);
    assert.ok((await h.db.prepare('SELECT tags FROM contacts').all()).results.every((row: { tags: string }) => {
      const tags = JSON.parse(row.tags); return tags.length === 2 && tags.includes('friends') && tags.includes('work');
    }));
    assert.equal((await change('FRIENDS')).body.affected, 0);
    assert.equal((await change('friends', 'remove_tag')).body.affected, 500);
    assert.equal((await change('friends', 'remove_tag')).body.affected, 0);
    const foreign = (await h.call('contacts', { workspace: 'other', method: 'POST', body: { name: 'Other' } })).body.contact;
    assert.equal((await change('private', 'add_tag', [ids[0], foreign.id])).status, 404);
    assert.equal((await h.call(`contacts/${ids[0]}`)).body.contact.tags, '["work"]');
    const fullTags = Array.from({ length: 100 }, (_, i) => `tag-${i}`);
    await h.db.prepare('UPDATE contacts SET tags = ? WHERE id = ?').bind(JSON.stringify(fullTags), ids[0]).run();
    assert.equal((await change('overflow')).status, 400);
    assert.equal((await h.call(`contacts/${ids[1]}`)).body.contact.tags, '["work"]', 'tag capacity failure must not partly change the selection');
    assert.equal((await change('bad,tag')).status, 400);
  } finally { await h.close(); }
});

test('cloud calendar uses local days, handles leap birthdays, and isolates workspaces', async () => {
  const h = await createCloudHarness();
  try {
    const ada = (await h.call('contacts', { method: 'POST', body: { name: 'Ada', birthday: '2000-02-29' } })).body.contact;
    await h.call(`contacts/${ada.id}/children`, { method: 'POST', body: { name: 'Lin', birthday: '2020-02-29' } });
    await h.call('reminders', { method: 'POST', body: { contact_id: ada.id, title: 'Local midnight', remind_at: '2026-09-04T23:30:00Z' } });
    const foreign = (await h.call('contacts', { workspace: 'other', method: 'POST', body: { name: 'Other' } })).body.contact;
    await h.call('reminders', { workspace: 'other', method: 'POST', body: { contact_id: foreign.id, title: 'Private reminder', remind_at: '2026-09-05T09:00:00Z' } });
    const day = await h.call('calendar?start=2026-09-05&end=2026-09-05&timeZone=Europe%2FLisbon');
    assert.equal(day.status, 200);
    assert.equal(day.body.events.length, 1);
    assert.equal(day.body.events[0].date, '2026-09-05');
    assert.equal(day.body.events[0].completed, false);
    assert.equal((await h.call('calendar?start=2026-09-04&end=2026-09-04&timeZone=Europe%2FLisbon')).body.events.length, 0);
    for (const [start, end, expected] of [['2027-02-28', '2027-03-01', '2027-03-01'], ['2028-02-28', '2028-03-01', '2028-02-29']]) {
      const birthdays = await h.call(`calendar?start=${start}&end=${end}`);
      assert.equal(birthdays.status, 200);
      assert.deepEqual(birthdays.body.events.map((event: { date: string }) => event.date), [expected, expected]);
    }
    assert.equal((await h.call('calendar?start=2026-01-01&end=2026-12-31')).status, 400);
  } finally { await h.close(); }
});

test('cloud calendar bounds event responses and reports truncation honestly', async () => {
  const h = await createCloudHarness();
  try {
    const ada = (await h.call('contacts', { method: 'POST', body: { name: 'Ada' } })).body.contact;
    await h.db.prepare(`INSERT INTO reminders(workspace_id, contact_id, title, remind_at)
      SELECT 'test', ?, 'Reminder ' || value, '2026-09-05T10:00:00Z' FROM json_each(?)`)
      .bind(ada.id, JSON.stringify(Array.from({ length: 5001 }, (_, i) => i))).run();
    const result = await h.call('calendar?start=2026-09-05&end=2026-09-05');
    assert.equal(result.status, 200);
    assert.equal(result.body.events.length, 5000);
    assert.equal(result.body.truncated, true);
  } finally { await h.close(); }
});

test('cloud birthday notifications honor lead time and the requested local date', async () => {
  const h = await createCloudHarness();
  try {
    const zone = 'Pacific/Kiritimati';
    const today = dateInTimeZone(new Date(), zone)!;
    const later = new Date(Date.parse(`${today}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
    const create = (name: string, birthday: string, lead: number, workspace = 'test') => h.call('contacts', { workspace, method: 'POST', body: { name, birthday, birthday_reminder_days: lead } });
    const now = (await create('Today', today, 0)).body.contact;
    const soon = (await create('Soon', later, 4)).body.contact;
    await create('Not yet', later, 2);
    await create('Private birthday', today, 0, 'other');
    const result = await h.call(`reminders?view=notifications&timeZone=${encodeURIComponent(zone)}`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.birthdays, [{ id: now.id, occurrence: today }, { id: soon.id, occurrence: later }]);
  } finally { await h.close(); }
});
