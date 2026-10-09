import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createCloudHarness } from './cloud-harness.ts';
import { createMobileHarness } from './mobile-harness.ts';
import { DEVICE_TOKEN_PREFIX, parseDeviceCallback, readNativeAccount } from '../../packages/domain/src/devices.ts';
import type { AppleCalendarAdapter } from '../../apps/mobile/src/data/apple-calendar.ts';
import type { AppleCalendarFacts } from '../../packages/domain/src/apple-calendar.ts';

export async function mobileCalendarPublicationFixture(legacy = true) {
  const cloud = await createCloudHarness(), previous = process.env.AUTH_MODE; process.env.AUTH_MODE = 'google';
  await cloud.db.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Fixture owner', 'owner@test.invalid', 1, 1, 1)").run();
  await cloud.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner')").run();
  async function approve() {
    const verifier = randomBytes(32).toString('hex'), state = randomBytes(32).toString('hex');
    const response = await cloud.authorizeDevice({ challenge: createHash('sha256').update(verifier).digest('base64url'), state, deviceName: 'Calendar verification fixture' });
    assert.equal(response.status, 200);
    const code = parseDeviceCallback((await response.json()).callback, state), token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const exchanged = await cloud.exchangeDevice({ code, state, verifier, token }); assert.equal(exchanged.status, 200);
    return readNativeAccount({ ...(await exchanged.json()).identity, token, origin: 'https://everclosecrm.com' });
  }
  let account = await approve();
  const folder = mkdtempSync(path.join(tmpdir(), 'everclose-calendar-reviews-')), filename = path.join(folder, 'phone.sqlite');
  let phone = await createMobileHarness(account, new Database(filename));
  const requests: { path: string; body: string | null }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push({ path: url.pathname, body: typeof init?.body === 'string' ? init.body : null });
    return cloud.routedRequest(new Request(String(input), { method: init?.method ?? 'GET', headers: init?.headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}) }));
  };
  const run = (fetcher = transport) => phone.sync.syncWorkspace(phone.db, account, { fetcher });
  await run();
  const person = await phone.contacts.createContact(phone.db, { name: 'Synthetic friend', email: 'friend@example.test', phone: '', notes: 'PRIVATE PERSON', contactFrequency: 14 });
  const planId = await phone.context.createContext(phone.db, 'plan', person.id, { type: 'meetup', planned_date: '2026-10-20', summary: 'PRIVATE SUMMARY', notes: 'PRIVATE PLAN' });
  await run();
  const facts = new Map<string, AppleCalendarFacts>(); let creates = 0, gets = 0;
  const adapter: AppleCalendarAdapter = {
    async prepareEditor() {}, async permission() { return true; }, async calendars() { return []; }, async find() { return [...facts.values()]; },
    async get(id) { gets++; return facts.get(id) ?? null; }, async edit(id) { return { action: 'saved', id }; },
    async create(event) {
      creates++; const id = 'private-apple-event';
      facts.set(id, { id, calendar_id: 'private-apple-calendar', title: event.title, start: event.startDate, end: event.endDate,
        all_day: event.allDay, time_zone: event.timeZone, url: event.url, recurring: false, cancelled: false });
      return { action: 'saved', id };
    },
  };
  const review = () => phone.appleCalendar.appleCalendarReview(phone.db, planId);
  const initial = await review(), draft = { title: 'Coffee', location: 'Cafe', start: { date: '2026-10-20', date_time: null, time_zone: null }, end: { date: '2026-10-21', date_time: null, time_zone: null } };
  const receipt = await phone.appleCalendar.prepareAppleCalendar(phone.db, account, planId, { operationId: crypto.randomUUID(), epoch: initial.epoch, planFingerprint: initial.planFingerprint, draft });
  if (legacy) {
    // Model the schema-16 receipt written by build 10's original editor, with no
    // shared reservation. All subsequent verification uses current production code.
    await phone.db.runAsync("UPDATE apple_calendar_receipts SET attempted = 1, status = 'unknown', revision = revision + 1 WHERE id = ?", receipt.id);
    const saved = await adapter.create({ title: 'Coffee', location: 'Cafe', startDate: '2026-10-20T00:00:00.000Z', endDate: '2026-10-21T00:00:00.000Z', allDay: true, timeZone: 'UTC', url: JSON.parse(receipt.request_json).url });
    await phone.db.runAsync("UPDATE apple_calendar_receipts SET event_id = ?, status = 'saved', revision = revision + 1 WHERE id = ?", saved.id, receipt.id);
  } else await phone.appleCalendar.openAppleCalendarEditor(phone.db, account, receipt.id, receipt.revision, adapter, () => true, transport);
  async function verify() {
    const r = await review(); return phone.appleCalendar.verifyAppleCalendar(phone.db, account, receipt.id,
      { revision: r.receipt!.revision, epoch: r.epoch, planFingerprint: r.planFingerprint, reads: false, follow: false }, adapter);
  }
  async function queue(fetcher = transport) {
    const saved = await verify(); return phone.calendarPublicationReviews.queueVerifiedCalendarPublication(phone.db, account, receipt.id, saved.revision, { fetcher });
  }
  const sync = (fetcher = transport, isCurrent = () => true) => phone.calendarPublicationReviews.syncCalendarPublicationReviews(phone.db, account, { fetcher, isCurrent });
  return { cloud, person, planId, receipt, adapter, facts, requests, transport, review, verify, queue, sync, run,
    get phone() { return phone; }, get account() { return account; }, get creates() { return creates; }, get gets() { return gets; },
    signInAgain: async () => { account = await approve(); return account; },
    restart: async () => { phone.close(); phone = await createMobileHarness(account, new Database(filename)); },
    close: async () => { phone.close(); await cloud.close(); rmSync(folder, { recursive: true, force: true }); if (previous === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = previous; },
  };
}
