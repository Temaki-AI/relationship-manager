import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRelationshipBrief, buildSmartLists, buildTimeline } from '../lib/intelligence.ts';

const contacts = [
  {
    id: 1,
    name: 'Sarah Friend',
    email: 'sarah@example.com',
    phone: null,
    photo_url: null,
    birthday: '1991-04-10',
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
    email: null,
    phone: null,
    photo_url: null,
    birthday: null,
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

test('buildRelationshipBrief produces actionable outreach guidance', () => {
  const brief = buildRelationshipBrief(contacts[0], interactions, reminders, facts);

  assert.match(brief.headline, /needs attention|momentum/i);
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
