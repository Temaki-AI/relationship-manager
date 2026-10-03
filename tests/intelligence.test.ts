import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDailyFeed,
  buildIntelligenceOverview,
  buildRelationshipBrief,
  buildRelationshipBriefFromActivity,
  buildSmartLists,
  buildTimeline,
} from '../lib/intelligence.ts';

const contacts = [
  {
    id: 1,
    name: 'Sarah Friend',
    nickname: null,
    email: 'sarah@example.com',
    phone: null,
    photo_url: null,
    birthday: '1991-04-10',
    birthday_reminder_days: 7,
    how_we_met: 'Running club',
    tags: '["friend","running"]',
    notes: 'Prefers voice notes.',
    gift_ideas: '["Trail snacks"]',
    custom_fields: JSON.stringify({
      linkedin: {
        company: 'Nike',
        location: 'Portland',
        imported_at: '2026-04-01T09:00:00.000Z',
      },
    }),
    last_contacted: '2026-03-01',
    contact_frequency: 14,
    created_at: '2026-01-01T10:00:00.000Z',
    updated_at: '2026-04-01T09:00:00.000Z',
  },
  {
    id: 2,
    name: 'Pat Operator',
    nickname: null,
    email: null,
    phone: null,
    photo_url: null,
    birthday: null,
    birthday_reminder_days: 7,
    how_we_met: 'Conference',
    tags: '["work","linkedin"]',
    notes: null,
    gift_ideas: null,
    custom_fields: JSON.stringify({
      linkedin: {
        company: 'Linear',
        location: 'New York',
        imported_at: '2026-04-02T09:00:00.000Z',
      },
    }),
    last_contacted: '2026-04-01',
    contact_frequency: 21,
    created_at: '2026-02-01T10:00:00.000Z',
    updated_at: '2026-04-02T09:00:00.000Z',
  },
];

const interactions = [
  {
    id: 101,
    contact_id: 1,
    date: '2026-03-01',
    type: 'call',
    summary: 'Caught up on race plans',
    notes: 'Half marathon training is going well.',
    created_at: '2026-03-01T12:00:00.000Z',
  },
  {
    id: 102,
    contact_id: 1,
    date: '2026-02-10',
    type: 'message',
    summary: 'Sent playlist',
    notes: null,
    created_at: '2026-02-10T12:00:00.000Z',
  },
  {
    id: 201,
    contact_id: 2,
    date: '2026-04-01',
    type: 'email',
    summary: 'Followed up after product launch',
    notes: null,
    created_at: '2026-04-01T12:00:00.000Z',
  },
];

const reminders = [
  {
    id: 301,
    contact_id: 1,
    title: 'Wish Sarah happy birthday',
    notes: 'Send a quick voice note.',
    remind_at: '2026-04-09T09:00:00.000Z',
    completed_at: null,
    created_at: '2026-04-01T09:00:00.000Z',
  },
];

const facts = [
  {
    id: 401,
    contact_id: 1,
    category: 'personal',
    label: 'Training goal',
    value: 'Half marathon in May',
    source: 'manual',
    confidence: 1,
    last_verified_at: '2026-03-20T18:00:00.000Z',
    created_at: '2026-03-20T18:00:00.000Z',
  },
];

test('buildSmartLists returns relationship views with matching contacts', () => {
  const smartLists = buildSmartLists(contacts, interactions, reminders, new Date('2026-04-05T12:00:00.000Z'));

  const overdueFriends = smartLists.find((list) => list.id === 'overdue-friends');
  const warmProfessional = smartLists.find((list) => list.id === 'warm-professional-leads');
  const birthdaysSoon = smartLists.find((list) => list.id === 'birthdays-soon');

  assert.ok(overdueFriends);
  assert.equal(overdueFriends?.entries[0]?.name, 'Sarah Friend');
  assert.ok(warmProfessional?.entries.some((entry) => entry.name === 'Pat Operator'));
  assert.equal(birthdaysSoon?.entries[0]?.name, 'Sarah Friend');
});

test('Today includes check-ins on their due date and honors a snooze', () => {
  const now = new Date('2026-04-08T12:00:00.000Z');
  const person = { ...contacts[0], birthday: null, last_contacted: '2026-04-01', contact_frequency: 7 };
  const due = buildIntelligenceOverview([person], [], [], now);
  assert.equal(due.stats.checkInsDueCount, 1);
  assert.equal(due.stats.overdueCount, 0, 'the compatibility field still counts only days past the preference');
  assert.equal(due.stats.strongRelationships, 0, 'a due-today check-in is not also counted as recently in touch');
  assert.equal(due.feed[0]?.type, 'relationship');
  assert.match(due.feed[0]?.detail || '', /Check-in day/);
  assert.match(due.smartLists.find((list) => list.id === 'overdue-friends')?.entries[0]?.reason || '', /Check-in day/);
  assert.equal(buildRelationshipBriefFromActivity(person,
    { contactId: person.id, interactionsCount: 0, latestInteraction: null, openReminders: [] }, [], now).headline,
  'Ready to reconnect');
  const snoozed = buildIntelligenceOverview([person], [], [], now, 'UTC', [
    { id: `overdue-${person.id}`, contact_id: person.id, reminder_id: null, until_date: '2026-04-10' },
  ]);
  assert.equal(snoozed.stats.checkInsDueCount, 0);
  assert.deepEqual(snoozed.feed, []);
});

test('buildRelationshipBrief produces actionable outreach guidance', () => {
  const brief = buildRelationshipBrief(contacts[0], interactions, reminders, facts);

  assert.match(brief.headline, /Ready to reconnect|On your rhythm|Recently in touch/);
  assert.match(brief.summary, /Nike|birthday|race plans/i);
  assert.match(brief.nextStep, /reminder|reach out/i);
  assert.ok(brief.talkingPoints.some((point) => point.includes('Training goal')));
  assert.ok(brief.suggestedOutreach.length > 0);
});

test('buildTimeline merges interactions, reminders, facts, and imported signals', () => {
  const timeline = buildTimeline(contacts[0], interactions, reminders, facts);

  assert.ok(timeline.some((item) => item.kind === 'interaction' && item.title.includes('Caught up on race plans')));
  assert.ok(timeline.some((item) => item.kind === 'reminder' && item.title.includes('Wish Sarah happy birthday')));
  assert.ok(timeline.some((item) => item.kind === 'fact' && item.title === 'Training goal'));
  assert.ok(timeline.some((item) => item.kind === 'signal' && item.title === 'LinkedIn profile captured'));
});

test('buildDailyFeed honors birthday lead times and prioritizes the nearest alerts', () => {
  const now = new Date('2026-04-12T12:00:00.000Z');
  const birthdayContacts = [
    { ...contacts[0], id: 11, name: 'Three Days', birthday: '1990-04-15' },
    { ...contacts[0], id: 12, name: 'One Day', birthday: '1985-04-13', birthday_reminder_days: 0 },
    { ...contacts[0], id: 13, name: 'Two Days', birthday: '2000-04-14' },
    { ...contacts[0], id: 14, name: 'Four Days', birthday: '1995-04-16' },
  ];

  const birthdayItems = buildDailyFeed(birthdayContacts, [], [], now)
    .filter((item) => item.type === 'birthday');

  assert.deepEqual(
    birthdayItems.map((item) => item.title),
    ["Two Days's birthday", "Three Days's birthday", "Four Days's birthday"]
  );
});

test('intelligence overview indexes each interaction once for large address books', () => {
  const largeContacts = Array.from({ length: 250 }, (_, index) => ({
    ...contacts[index % contacts.length],
    id: index + 1,
    name: `Scale Contact ${index + 1}`,
  }));
  let contactIdReads = 0;
  const largeInteractions = Array.from({ length: 5_000 }, (_, index) => {
    const contactId = (index % largeContacts.length) + 1;
    return {
      id: index + 1,
      get contact_id() {
        contactIdReads += 1;
        return contactId;
      },
      date: `2026-03-${String((index % 28) + 1).padStart(2, '0')}`,
      type: 'message',
      summary: `Interaction ${index + 1}`,
      notes: null,
      created_at: '2026-03-01T12:00:00.000Z',
    };
  });

  const overview = buildIntelligenceOverview(
    largeContacts,
    largeInteractions,
    [],
    new Date('2026-04-05T12:00:00.000Z')
  );

  assert.equal(overview.stats.totalContacts, 250);
  assert.equal(contactIdReads, largeInteractions.length);
  assert.ok(
    overview.smartLists
      .find((list) => list.id === 'dormant-strong-ties')
      ?.entries.some((entry) => entry.reason.includes('20 past interactions'))
  );
});

test('daily suggestions combine a person without hiding explicit reminder or birthday context', () => {
  const now = new Date('2026-04-12T12:00:00Z');
  const person = { ...contacts[0], birthday: '1990-04-14' };
  const feed = buildDailyFeed([person], [], [
    { id: 501, contact_id: person.id, title: 'Ask about the garden', remind_at: '2026-04-11T12:00:00Z', completed_at: null },
    { id: 502, contact_id: person.id, title: 'Not due yet', remind_at: '2026-04-18T12:00:00Z', completed_at: null },
  ], now);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].title, 'Ask about the garden');
  assert.equal(feed[0].reminderId, 501);
  assert.ok(feed[0].reasons?.some((reason) => reason.type === 'birthday' && reason.date === '2026-04-14' && reason.title.includes('birthday')));
  assert.ok(feed[0].reasons?.some((reason) => reason.type === 'relationship'));
  assert.ok(!JSON.stringify(feed).includes('Not due yet'));
});

test('snoozing one reason reveals another without inventing a new interaction', () => {
  const now = new Date('2026-04-12T12:00:00Z');
  const person = { ...contacts[0], birthday: '1990-04-14' };
  const due = { id: 501, contact_id: person.id, title: 'Ask about the garden', remind_at: '2026-04-11T12:00:00Z', completed_at: null };
  const snooze = (id: string) => ({ id, contact_id: person.id, reminder_id: id.startsWith('reminder-') ? 501 : null, until_date: '2026-04-19' });
  const reminderHidden = buildDailyFeed([person], interactions, [due], now, 'UTC', [snooze('reminder-501')]);
  assert.equal(reminderHidden[0].type, 'birthday');
  assert.ok(reminderHidden[0].reasons?.some((reason) => reason.type === 'relationship'));
  assert.equal(reminderHidden[0].contactEmail, 'sarah@example.com');
  assert.equal(reminderHidden[0].lastInteraction?.summary, 'Caught up on race plans');

  const allHidden = [snooze('reminder-501'), snooze('birthday-1'), snooze('overdue-1')];
  assert.deepEqual(buildDailyFeed([person], interactions, [due], now, 'UTC', allHidden), []);
  const overview = buildIntelligenceOverview([person], interactions, [due], now, 'UTC', allHidden);
  assert.equal(overview.stats.overdueCount, 0);
  assert.deepEqual(overview.smartLists.find((list) => list.id === 'overdue-friends')?.entries, []);
  assert.equal(overview.stats.openReminderCount, 1, 'snoozing does not complete the reminder');
  assert.equal(buildDailyFeed([person], interactions, [due], new Date('2026-04-19T12:00:00Z'), 'UTC', allHidden).length > 0, true);
});

test('snoozed candidates do not consume Today slots', () => {
  const now = new Date('2026-04-12T12:00:00Z');
  const people = Array.from({ length: 5 }, (_, index) => ({
    ...contacts[0], id: index + 11, name: `Person ${index + 1}`,
    birthday: `1990-04-${String(index + 12).padStart(2, '0')}`,
  }));
  const due = people.map((person, index) => ({
    id: index + 601, contact_id: person.id, title: `Follow up ${index + 1}`,
    remind_at: `2026-04-${String(index + 7).padStart(2, '0')}T09:00:00Z`, completed_at: null,
  }));
  const snoozes = [
    ...due.slice(0, 4).map((reminder) => ({ id: `reminder-${reminder.id}`, contact_id: reminder.contact_id, reminder_id: reminder.id, until_date: '2026-04-19' })),
    ...people.slice(0, 3).map((person) => ({ id: `birthday-${person.id}`, contact_id: person.id, reminder_id: null, until_date: '2026-04-19' })),
  ];
  const feed = buildDailyFeed(people, [], due, now, 'UTC', snoozes);
  assert.ok(feed.some((item) => item.reminderId === due[4].id));
  assert.ok(feed.some((item) => item.type === 'birthday' && item.contactId === people[3].id));
});

test('several reminders for one person leave room for a second person', () => {
  const now = new Date('2026-04-12T12:00:00Z');
  const first = { ...contacts[0], birthday: null };
  const second = { ...contacts[1], birthday: null };
  const due = [
    ...Array.from({ length: 5 }, (_, index) => ({ id: index + 701, contact_id: first.id, title: `Ada task ${index + 1}`, remind_at: `2026-04-${String(index + 1).padStart(2, '0')}T09:00:00Z`, completed_at: null })),
    { id: 706, contact_id: second.id, title: 'Pat task', remind_at: '2026-04-10T09:00:00Z', completed_at: null },
  ];
  const feed = buildDailyFeed([first, second], [], due, now);
  assert.deepEqual(feed.map((item) => item.contactId).sort(), [first.id, second.id].sort());
  assert.equal(feed.find((item) => item.contactId === first.id)?.reminderId, 701);
  assert.equal(feed.find((item) => item.contactId === second.id)?.reminderId, 706);
  assert.match(feed.find((item) => item.contactId === first.id)?.detail || '', /Overdue since Apr 1, 2026/);
});
