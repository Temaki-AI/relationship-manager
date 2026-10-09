import assert from 'node:assert/strict';
import type { createCloudHarness } from './cloud-harness.ts';
import { googleActor as actor, googleEnvironment } from './google-contact-fixture.ts';
type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
export const calendarEnvironment = { ...googleEnvironment, GOOGLE_CALENDAR_CLIENT_ID: 'calendar-client', GOOGLE_CALENDAR_CLIENT_SECRET: 'calendar-test-secret' };
export const calendarId = 'personal@example.test';
export async function selectedCalendar(h: Harness, chosenId = calendarId) {
  await h.db.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@test.invalid', 1, 1, 1)").run();
  await h.db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner')").run();
  Object.assign(h.emailEnv, calendarEnvironment);
  const epoch = (await h.db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'test'").first<{ epoch: string }>())!.epoch;
  const start = await h.providers.beginGoogleConnection(h.db, actor, calendarEnvironment, { purpose: 'calendar', expected_epoch: epoch }, calendarEnvironment.BETTER_AUTH_URL);
  const connection = await h.providers.completeGoogleConnection(h.db, actor, calendarEnvironment, new URLSearchParams({ state: new URL(start.authorization_url).searchParams.get('state')!, code: 'calendar-code' }), async (url) => url.endsWith('/userinfo')
    ? Response.json({ sub: 'google-owner', email: 'owner@example.test', email_verified: true, name: 'Owner' })
    : Response.json({ access_token: 'calendar-access', refresh_token: 'calendar-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid email profile https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly' }));
  const run = await h.googleCalendarResources.startCalendarDiscovery(h.db, actor, calendarEnvironment, connection.id, { operation_id: crypto.randomUUID(), expected_epoch: epoch, expected_authorization_revision: connection.authorization_revision });
  await h.googleCalendarResources.advanceCalendarDiscovery(h.db, actor, calendarEnvironment, connection.id, run.id, async () => Response.json({ items: [{ id: chosenId, summary: 'Personal', timeZone: 'Europe/Lisbon', accessRole: 'owner', primary: true }] }));
  const review = await h.googleCalendarResources.reviewCalendars(h.db, actor, connection.id);
  await h.googleCalendarResources.selectCalendars(h.db, actor, connection.id, { operation_id: crypto.randomUUID(), expected_epoch: epoch, expected_authorization_revision: review.authorization_revision,
    expected_generation: review.generation, expected_selection_revision: review.selection_revision, selected_ids: [chosenId] });
  const fresh = await h.googleCalendarResources.reviewCalendars(h.db, actor, connection.id);
  assert.deepEqual(fresh.selected_ids, [chosenId]);
  const body = { operation_id: crypto.randomUUID(), calendar_id: chosenId, expected_epoch: epoch, expected_authorization_revision: connection.authorization_revision, expected_selection_revision: fresh.selection_revision, past_days: 90, future_days: 180 };
  return { connection, epoch, body };
}
export const calendarEvent = (id = 'meeting1') => ({ id, summary: 'Lunch with Ana', status: 'confirmed', start: { dateTime: '2026-10-04T12:00:00+01:00', timeZone: 'Europe/Lisbon' }, end: { dateTime: '2026-10-04T13:00:00+01:00', timeZone: 'Europe/Lisbon' },
  attendees: [{ email: 'ana@example.test', displayName: 'Ana', responseStatus: 'accepted' }], organizer: { email: 'owner@example.test', self: true }, htmlLink: 'https://calendar.google.com/calendar/event?eid=meeting1',
  description: 'Private CRM descriptions must not be downloaded', attachments: [{ fileUrl: 'https://private.test/secret' }], conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij', accessCode: 'do-not-save' }] } });
