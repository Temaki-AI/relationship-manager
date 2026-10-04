import assert from 'node:assert/strict';
import { createCloudHarness } from './cloud-harness.ts';
import { googleActor as actor, googleEnvironment } from './google-contact-fixture.ts';
export { actor };
export const publicationEnvironment = { ...googleEnvironment, GOOGLE_CALENDAR_PUBLISH_CLIENT_ID: 'publisher', GOOGLE_CALENDAR_PUBLISH_CLIENT_SECRET: 'publisher-secret' };
export async function publicationFixture() {
  const h = await createCloudHarness(), env = publicationEnvironment;
  try {
    Object.assign(h.emailEnv, env);
    await h.db.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@test.invalid', 1, 1, 1)").run();
    await h.db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner')").run();
    const epoch = (await h.db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'test'").first<{ epoch: string }>())!.epoch;
    const begin = await h.providers.beginGoogleConnection(h.db, actor, env, { purpose: 'calendar-publish', expected_epoch: epoch }, env.BETTER_AUTH_URL);
    const connection = await h.providers.completeGoogleConnection(h.db, actor, env, new URLSearchParams({ code: 'code', state: new URL(begin.authorization_url).searchParams.get('state')! }), async (url) => url.endsWith('/userinfo')
      ? Response.json({ sub: 'google-owner', email: 'owner@example.test', email_verified: true })
      : Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'openid email profile https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.app.created' }));
    const setup = await h.ownedCalendar.startOwnedCalendar(h.db, actor, env, connection.id, { operation_id: crypto.randomUUID(), expected_epoch: epoch, expected_authorization_revision: connection.authorization_revision, time_zone: 'Europe/Lisbon' });
    let calendar: Record<string, unknown> = {};
    await h.ownedCalendar.advanceOwnedCalendar(h.db, actor, env, connection.id, { operation_id: setup.operation_id, expected_revision: setup.revision, expected_epoch: epoch, expected_authorization_revision: connection.authorization_revision }, async (_url, request) => {
      calendar = { ...JSON.parse(request.body as string), id: 'owned@example.test', accessRole: 'owner', primary: false, hidden: true };
      return Response.json(calendar);
    });
    const person = (await h.call('contacts', { method: 'POST', body: { name: 'Ana', notes: 'PRIVATE PERSON NOTE' } })).body.contact;
    const result = await h.call('plans', { method: 'POST', body: { contact_id: person.id, type: 'meetup', planned_date: '2026-10-20', summary: 'PRIVATE PLAN SUMMARY', notes: 'PRIVATE PLAN NOTE' } });
    assert.equal(result.status, 201); const plan = result.body.plan;
    const calls: Array<{ url: URL; method: string; body: Record<string, unknown> | null; headers: Headers }> = [];
    let event: Record<string, unknown> | null = null, loseReply = false, fail = 0;
    const fetcher = async (address: string, request: RequestInit) => {
      const url = new URL(address), method = request.method ?? 'GET';
      if (url.pathname.includes('/calendarList/')) return Response.json(calendar);
      assert.ok(url.pathname.includes('/events')); const body = request.body ? JSON.parse(request.body as string) as Record<string, unknown> : null;
      calls.push({ url, method, body, headers: new Headers(request.headers) });
      if (fail) { const status = fail; fail = 0; return Response.json({ error: {} }, { status }); }
      if (method === 'GET') return event ? Response.json(event) : new Response(null, { status: 404 });
      if (method === 'POST' && event) return new Response(null, { status: 409 });
      if (method === 'PATCH' && new Headers(request.headers).get('if-match') !== event?.etag) return new Response(null, { status: 412 });
      event = { ...event, ...body, etag: '"version-' + calls.length + '"', status: 'confirmed', updated: '2026-10-04T10:00:00Z' };
      if (loseReply) { loseReply = false; throw new Error('Lost response after committing'); }
      return Response.json(event);
    };
    const review = () => h.planPublications.reviewPlanPublication(h.db, actor, env, connection.id, plan.public_id, fetcher);
    const draft = (overrides = {}) => ({ summary: 'Coffee with Ana', location: 'Lisbon', visibility: 'private' as const,
      start: { date: '2026-10-21', date_time: null, time_zone: null }, end: { date: '2026-10-22', date_time: null, time_zone: null }, attendee_emails: [], follow_plan_date: false, ...overrides });
    const prepare = async (fields = draft()) => { const r = await review(); return h.planPublications.preparePlanPublication(h.db, actor, env, connection.id, plan.public_id, { operation_id: crypto.randomUUID(), expected_preview_fingerprint: r.preview_fingerprint, draft: fields }, fetcher); };
    const advance = async (mode: 'send' | 'verify' = 'send', db = h.db) => {
      const r = await review(); return h.planPublications.advancePlanPublication(db, actor, env, connection.id, plan.public_id, { operation_id: r.write!.id, expected_revision: r.write!.revision,
        expected_epoch: r.epoch, expected_authorization_revision: r.authorization_revision, expected_plan_fingerprint: r.plan_fingerprint, mode }, fetcher);
    };
    return { h, env, connection, person, plan, calls, fetcher, review, prepare, advance, draft, get event() { return event; }, set event(value) { event = value; },
      set loseReply(value: boolean) { loseReply = value; }, set fail(value: number) { fail = value; }, get calendar() { return calendar; }, set calendar(value) { calendar = value; } };
  } catch (error) { await h.close(); throw error; }
}
