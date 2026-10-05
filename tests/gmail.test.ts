import assert from 'node:assert/strict';
import test from 'node:test';
import { gmailAddress, gmailHeaderAddresses, gmailMessageFacts, readGmailChoices, type GmailMetadata } from '../packages/domain/src/gmail.ts';
const choices = { label_ids: ['INBOX', 'SENT'], own_addresses: ['owner@example.test', 'alias@example.test'], mode: 'existing_people', past_days: 90, scan_limit: 1000, retain_subject: false };
function message(extra: Partial<GmailMetadata> = {}): GmailMetadata { return { id: 'abc', threadId: 'thread1', historyId: '9007199254740993', receivedAt: 500,
  labelIds: ['INBOX'], headers: { from: ['"Doe, Jane" <jane@example.test>'], to: ['owner@example.test'], subject: ['Subject must be absent'] }, ...extra }; }
test('Gmail choices are bounded and explicit, normalize only address identity, and always remove the primary mailbox address', () => {
  const value = readGmailChoices({ ...choices, own_addresses: ['Alias@EXAMPLE.test'] }, 'OWNER@example.test');
  assert.deepEqual(value.own_addresses, ['alias@example.test', 'owner@example.test']); assert.equal(value.retain_subject, false);
  assert.equal(gmailAddress(' User+tag@Gmail.com '), 'user+tag@gmail.com');
  for (const invalid of ['a..b@example.test', '.a@example.test', 'a.@example.test', 'a@[127.0.0.1]', 'a@-example.test',
    'a@example-.test', 'a@example..test', 'a@example.test.', 'a@exam_ple.test', 'a'.repeat(65) + '@example.test',
    'é'.repeat(33) + '@example.test', 'a@' + 'b'.repeat(64) + '.test']) assert.throws(() => gmailAddress(invalid));
  for (const invalid of [{ label_ids: [] }, { label_ids: ['SPAM'] }, { label_ids: ['INBOX', 'INBOX'] }, { past_days: 91 }, { past_days: 1.5 }, { scan_limit: 10001 }, { retain_subject: 'yes' }, { mode: 'automatic_import' }, { mode: ['existing_people'] }, { own_addresses: ['a@example.test', 'A@example.test'] }]) assert.throws(() => readGmailChoices({ ...choices, ...invalid }, 'owner@example.test'));
});
test('bounded address parsing handles quoted commas, comments, groups and international addresses without guessing unsupported syntax', () => {
  assert.deepEqual(gmailHeaderAddresses(['"Doe, Jane" <JANE@example.test>, (friend) João <joão@example.test>', 'Team: a@example.test, b@example.test;']),
    { addresses: ['a@example.test', 'b@example.test', 'jane@example.test', 'joão@example.test'], incomplete: false });
  for (const raw of ['"unfinished <wrong@example.test>', 'Group: victim@example.test', 'Name <a@example.test><b@example.test>', '<a@example.test> trailing', 'name@example.test\u0000', 'a:b@example.test']) {
    const result = gmailHeaderAddresses([raw]); assert.equal(result.incomplete, true); assert.deepEqual(result.addresses, []);
  }
  assert.deepEqual(gmailHeaderAddresses(['"quoted local"@example.test']), { addresses: [], incomplete: true });
});
test('one message retains distinct participant roles and direction, excludes own aliases and never stores raw headers or default-off subjects', () => {
  const policy = readGmailChoices(choices, 'owner@example.test');
  const facts = gmailMessageFacts(message({ headers: { from: ['Jane <jane@example.test>'], to: ['owner@example.test, alias@example.test, jane@example.test'], cc: ['friend@example.test'], subject: ['secret'], 'message-id': ['<message@host>'] } }), policy, 0, 1000)!;
  assert.equal(facts.direction, 'incoming'); assert.equal(facts.subject, null);
  assert.deepEqual(facts.participants, [{ email: 'friend@example.test', roles: ['cc'] }, { email: 'jane@example.test', roles: ['from', 'to'] }]);
  assert.equal(JSON.stringify(facts).includes('owner@example.test'), false); assert.equal(JSON.stringify(facts).includes('secret'), false);
  assert.equal(gmailMessageFacts(message({ labelIds: ['SENT'], headers: { from: ['alias@example.test'], to: ['jane@example.test'] } }), policy, 0, 1000)!.direction, 'outgoing');
  assert.equal(gmailMessageFacts(message({ headers: { from: ['owner@example.test'], to: ['jane@example.test'] } }), policy, 0, 1000)!.direction, 'unknown');
  assert.equal(gmailMessageFacts(message({ headers: { from: ['A: jane@example.test'], to: ['owner@example.test'] } }), policy, 0, 1000)!.participants_incomplete, true);
  assert.equal(gmailMessageFacts(message(), { ...policy, retain_subject: true }, 0, 1000)!.subject, 'Subject must be absent');
});
test('bulk, automation, spam, trash, drafts, unselected labels and out-of-window messages are excluded without inventing interactions', () => {
  const policy = readGmailChoices(choices, 'owner@example.test');
  for (const extra of [{ headers: { 'list-id': ['<newsletter.example.test>'] } }, { headers: { precedence: ['bulk'] } }, { headers: { 'auto-submitted': ['auto-generated'] } },
    { labelIds: ['INBOX', 'SPAM'] }, { labelIds: ['INBOX', 'TRASH'] }, { labelIds: ['INBOX', 'DRAFT'] }, { labelIds: ['Label_1'] }, { receivedAt: 1001 }, { receivedAt: -1 }]) assert.equal(gmailMessageFacts(message(extra), policy, 0, 1000), null);
  assert.ok(gmailMessageFacts(message({ headers: { from: ['friend@example.test'], to: ['owner@example.test'], 'auto-submitted': ['no'] } }), policy, 0, 1000));
});
