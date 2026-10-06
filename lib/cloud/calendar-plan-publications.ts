import { publicationDraft, type PublicationDraft } from '@/packages/domain/src/calendar-publication';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { fingerprintIdempotencyInput as hash } from '@/lib/idempotency';
import { dateInTimeZone } from '@/lib/civil-date';
import { googleCalendarResponseJson } from './google-calendars';
import { normalizeGoogleEvent } from './google-calendar-events';
import { publishingCalendarAccess, publishingOwnerCondition, publishingOwnerValues } from './google-owned-calendar';
import { requireProviderOwner, providerWriteGuard, requireGoogleReconnection, type ConnectionActor } from './provider-connections';
import { maintenanceGuard, removeGuard } from './recovery-storage';
import { ProviderConnectionError } from './provider-vault';
import type { ProviderEnvironment, ProviderFetch } from './google-provider';

type DB = CloudflareEnv['DB'];
type Plan = { id: number; public_id: string; contact_id: number; contact_public_id: string; contact_name: string; type: string; planned_date: string; summary: string | null; notes: string | null; completed_at: string | null };
type Publication = { id: string; workspace_id: string; user_id: string; connection_id: string; plan_public_id: string; calendar_id: string; event_id: string; creator_client_id: string;
  follow_date: number; last_plan_date: string | null; last_etag: string | null; status: string; issue: string | null; revision: number; confirmed_at: string | null; lease_token: string | null; lease_until: number | null };
type Write = { id: string; publication_id: string; fingerprint: string; request_json: string; plan_fingerprint: string; dataset_epoch: string; authorization_revision: number;
  publication_revision: number; kind: 'create' | 'update'; base_etag: string | null; attempts: number; status: string; issue: string | null; revision: number; retry_at: number };
type Context = Awaited<ReturnType<typeof local>>;
type Access = Awaited<ReturnType<typeof publishingCalendarAccess>>;
type Frozen = { draft: PublicationDraft; google: ReturnType<typeof publicationDraft>['google']; calendar_fingerprint: string };
type Saved = { id: number; public_id: string; revision: number; facts: string };
const pubFor = (db: DB, actor: ConnectionActor, planId: string) => db.prepare('SELECT * FROM calendar_plan_publications WHERE workspace_id = ? AND plan_public_id = ?').bind(actor.workspaceId, planId).first<Publication>();
const writeFor = (db: DB, id: string) => db.prepare('SELECT * FROM calendar_plan_writes WHERE id = ?').bind(id).first<Write>();
const latest = (db: DB, id: string) => db.prepare('SELECT * FROM calendar_plan_writes WHERE publication_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').bind(id).first<Write>();
const frozen = (w: Write) => JSON.parse(w.request_json) as Frozen;
const planHash = (p: Plan | null) => p ? hash({ public_id: p.public_id, contact_public_id: p.contact_public_id, type: p.type, planned_date: p.planned_date, summary: p.summary, notes: p.notes, completed_at: p.completed_at }) : null;
function exact(body: Record<string, unknown>, keys: string[]) { if (Object.keys(body).length !== keys.length || Object.keys(body).some((key) => !keys.includes(key))) throw new ProviderConnectionError('Refresh this publication review.', 400); }
async function local(db: DB, actor: ConnectionActor, connectionId: string, planId: string) {
  await requireProviderOwner(db, actor);
  if (!isSyncUuid(connectionId) || !isSyncUuid(planId)) throw new ProviderConnectionError('Choose an existing plan and publishing connection.', 404);
  const connection = await db.prepare("SELECT c.*, s.epoch FROM provider_connections c JOIN workspace_sync_state s ON s.workspace_id = c.workspace_id JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ? AND c.workspace_id = ? AND c.user_id = ? AND c.purpose = 'calendar-publish' AND s.paused = 0 AND w.lifecycle = 'active'")
    .bind(connectionId, actor.workspaceId, actor.userId).first<{ email: string; authorization_revision: number; epoch: string; dataset_epoch: string; status: string }>();
  if (!connection) throw new ProviderConnectionError('Publishing connection not found or recovery is active.', 404);
  const plan = await db.prepare('SELECT p.*, c.public_id AS contact_public_id, c.name AS contact_name FROM plans p JOIN contacts c ON c.workspace_id = p.workspace_id AND c.id = p.contact_id WHERE p.workspace_id = ? AND p.public_id = ?').bind(actor.workspaceId, planId).first<Plan>();
  const pub = await pubFor(db, actor, planId);
  const reserved = await db.prepare("SELECT id, provider FROM calendar_publication_reservations WHERE workspace_id = ? AND plan_public_id = ? AND status != 'cancelled'")
    .bind(actor.workspaceId, planId).first<{ id: string; provider: string }>();
  if (reserved && (reserved.provider !== 'google-calendar' || reserved.id !== pub?.id)) throw new ProviderConnectionError('This plan already has a Calendar publication. Review its original receipt instead of creating another event.');
  if (pub && (pub.connection_id !== connectionId || pub.user_id !== actor.userId)) throw new ProviderConnectionError('This plan has a publication in another connection. Review that account instead.');
  if (!pub && !plan) throw new ProviderConnectionError('Plan not found.', 404);
  const write = pub ? await latest(db, pub.id) : null;
  const saved = pub ? await db.prepare("SELECT * FROM calendar_events WHERE workspace_id = ? AND provider = 'google-calendar' AND account_key = (SELECT account_id FROM provider_connections WHERE id = ?) AND calendar_key = ? AND external_id = ?")
    .bind(actor.workspaceId, connectionId, pub.calendar_id, pub.event_id).first<Saved>() : null;
  const link = plan ? await db.prepare('SELECT event_id FROM calendar_event_plans WHERE workspace_id = ? AND plan_id = ?').bind(actor.workspaceId, plan.id).first<{ event_id: number }>() : null;
  return { connection, plan, pub, write, saved, link };
}
function publicView(c: Context) {
  return { epoch: c.connection.epoch, authorization_revision: c.connection.authorization_revision, email: c.connection.email, plan_fingerprint: planHash(c.plan),
    plan: c.plan ? { public_id: c.plan.public_id, contact_id: c.plan.contact_id, contact_name: c.plan.contact_name, type: c.plan.type, planned_date: c.plan.planned_date, summary: c.plan.summary, completed: Boolean(c.plan.completed_at) } : null,
    publication: c.pub ? { id: c.pub.id, revision: c.pub.revision, status: c.pub.status, issue: c.pub.issue, follow_plan_date: Boolean(c.pub.follow_date), last_plan_date: c.pub.last_plan_date, confirmed_at: c.pub.confirmed_at } : null,
    saved_event_id: c.saved?.public_id ?? null,
    write: c.write ? { id: c.write.id, revision: c.write.revision, kind: c.write.kind, status: c.write.status, attempts: c.write.attempts, issue: c.write.issue, retry_at: c.write.retry_at, can_send: Boolean(c.plan && !c.plan.completed_at && c.pub && c.write.dataset_epoch === c.connection.epoch && c.write.authorization_revision === c.connection.authorization_revision && c.write.publication_revision === c.pub.revision && c.write.plan_fingerprint === planHash(c.plan) && ['pending', 'unknown'].includes(c.write.status)), draft: frozen(c.write).draft } : null };
}
class PublicationError extends ProviderConnectionError {
  constructor(readonly reason: 'retry' | 'permission' | 'conflict' | 'invalid' | 'identity' | 'missing') { super('Google publication is unconfirmed. Review the retained event before continuing.', reason === 'retry' ? 503 : 409); }
}
const eventUrl = (pub: Publication, item = true) => new URL('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(pub.calendar_id) + '/events' + (item ? '/' + encodeURIComponent(pub.event_id) : ''));
async function requestGoogle(grant: Access['grant'], pub: Publication, fetcher: ProviderFetch, options?: { body: Record<string, unknown>; etag?: string; invitations: boolean }) {
  const url = eventUrl(pub, !options || Boolean(options.etag));
  url.searchParams.set('fields', 'id,etag,status,summary,location,visibility,start,end,attendees,attendeesOmitted,recurrence,recurringEventId,extendedProperties,updated,iCalUID,htmlLink,eventType');
  if (options?.invitations) url.searchParams.set('sendUpdates', 'all');
  let response: Response;
  try { response = await fetcher(url.href, { method: !options ? 'GET' : options.etag ? 'PATCH' : 'POST', headers: { Authorization: 'Bearer ' + grant.accessToken,
    ...(options ? { 'Content-Type': 'application/json' } : {}), ...(options?.etag ? { 'If-Match': options.etag } : {}) },
    ...(options ? { body: JSON.stringify(options.body) } : {}), redirect: 'error', signal: AbortSignal.timeout(10_000) }); } catch { throw new PublicationError('retry'); }
  if (!options && response.status === 404) return null;
  if (response.status === 403) {
    let reasons: string[] = [];
    try { const failure = await googleCalendarResponseJson(response); reasons = ((failure.error as { errors?: Array<{ reason?: string }> })?.errors ?? []).map((p) => p.reason ?? ''); } catch { /* No provider response is retained. */ }
    throw new PublicationError(reasons.some((reason) => ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'].includes(reason)) ? 'retry' : 'permission');
  }
  if (response.status === 401) throw new PublicationError('permission');
  if (response.status === 409 || response.status === 412) throw new PublicationError('conflict');
  if (response.status === 429 || response.status >= 500) throw new PublicationError('retry');
  if (!response.ok) throw new PublicationError('invalid');
  try { return await googleCalendarResponseJson(response); } catch { throw new PublicationError('invalid'); }
}
function rawMoment(raw: unknown, zone: string) {
  const p = raw as { date?: string; dateTime?: string; timeZone?: string };
  if (p?.date) return { date: p.date, date_time: null, time_zone: null };
  const instant = Date.parse(p?.dateTime ?? ''), timeZone = p?.timeZone ?? zone;
  if (!Number.isFinite(instant)) throw new PublicationError('invalid');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant).map((p) => [p.type, p.value]));
  const wall = [parts.year, parts.month, parts.day].join('-') + 'T' + [parts.hour, parts.minute, parts.second].join(':');
  const offset = Math.round((Date.parse(wall + 'Z') - instant) / 60_000), sign = offset < 0 ? '-' : '+', abs = Math.abs(offset);
  return { date: null, date_time: wall + sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0'), time_zone: timeZone };
}
function remote(value: Record<string, unknown>, pub: Publication, zone: string) {
  const props = (value.extendedProperties as { private?: Record<string, unknown> } | undefined)?.private;
  if (value.id !== pub.event_id || (props?.everclosePublication !== pub.id && !(pub.confirmed_at && value.status === 'cancelled')) || typeof value.etag !== 'string' || !value.etag || value.etag.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value.etag)) throw new PublicationError('identity');
  const facts = normalizeGoogleEvent(value, zone);
  // Guest details are used only for this owner's editing preview. Canonical facts retain their privacy redaction.
  const editableFacts = facts.status === 'cancelled' ? facts : normalizeGoogleEvent({ ...value, visibility: 'default' }, zone);
  const editable = facts.status !== 'cancelled' && !value.recurrence && !value.recurringEventId && value.attendeesOmitted !== true && editableFacts.attendees.length <= 20;
  let draft: PublicationDraft | null = null;
  if (editable) {
    const candidate = { summary: value.summary ?? 'Untitled event', location: value.location ?? '', visibility: value.visibility ?? 'default', start: rawMoment(value.start, zone), end: rawMoment(value.end, zone),
      attendee_emails: editableFacts.attendees.map((p) => p.email).filter((email): email is string => Boolean(email)), follow_plan_date: Boolean(pub.follow_date) };
    try { draft = publicationDraft(candidate).draft; } catch { throw new PublicationError('invalid'); }
  }
  return { value, facts, draft, editable, etag: value.etag, operation: props?.evercloseOperation };
}
function reviewHash(c: Context, access: Access, r: ReturnType<typeof remote> | null) {
  return hash({ owner: access.connection.user_id, epoch: access.connection.dataset_epoch, authorization: access.connection.authorization_revision, calendar: access.calendar,
    plan: planHash(c.plan), publication: c.pub ? [c.pub.id, c.pub.revision] : null, write: c.write ? [c.write.id, c.write.revision, c.write.status] : null,
    saved: c.saved ? [c.saved.public_id, c.saved.revision] : null, link: c.link?.event_id ?? null, etag: r?.etag ?? null });
}
async function inspect(db: DB, actor: ConnectionActor, env: ProviderEnvironment, connectionId: string, planId: string, fetcher: ProviderFetch) {
  const c = await local(db, actor, connectionId, planId), access = await publishingCalendarAccess(db, actor, env, connectionId, fetcher);
  let value: Record<string, unknown> | null = null;
  try { value = c.pub ? await requestGoogle(access.grant, c.pub, fetcher) : null; }
  catch (error) { if (error instanceof PublicationError && error.reason === 'permission') await requireGoogleReconnection(db, access.grant); throw error; }
  const r = value && c.pub ? remote(value, c.pub, access.calendar.time_zone) : null;
  if (c.link && c.link.event_id !== c.saved?.id) throw new ProviderConnectionError('This plan already links to another saved event. Review that link before publishing.');
  return { c, access, r, fingerprint: reviewHash(c, access, r) };
}
export async function reviewPlanPublication(db: DB, actor: ConnectionActor, env: ProviderEnvironment, connectionId: string, planId: string, fetcher: ProviderFetch = fetch) {
  await local(db, actor, connectionId, planId);
  try {
    const { c, access, r, fingerprint } = await inspect(db, actor, env, connectionId, planId, fetcher);
    return { ...publicView(c), calendar: access.calendar, remote_draft: r?.draft ?? null, remote_facts: r?.facts ?? null, preview_fingerprint: fingerprint,
      can_prepare: Boolean(c.plan && !c.plan.completed_at && (!c.pub?.confirmed_at || r?.editable)), problem: c.pub?.confirmed_at && !r ? 'missing' : r && !r.editable ? 'event_not_editable' : null };
  } catch (error) {
    if (!(error instanceof ProviderConnectionError)) throw error;
    return { ...publicView(await local(db, actor, connectionId, planId)), calendar: null, remote_draft: null, remote_facts: null, preview_fingerprint: null, can_prepare: false, problem: error.message };
  }
}
function planCondition(p: Plan | null, workspace: string, planId: string) {
  return p ? { sql: 'EXISTS (SELECT 1 FROM plans p JOIN contacts c ON c.id = p.contact_id AND c.workspace_id = p.workspace_id WHERE p.workspace_id = ? AND p.public_id = ? AND p.contact_id = ? AND c.public_id = ? AND p.type = ? AND p.planned_date = ? AND p.summary IS ? AND p.notes IS ? AND p.completed_at IS ?)',
    values: [workspace, planId, p.contact_id, p.contact_public_id, p.type, p.planned_date, p.summary, p.notes, p.completed_at] }
    : { sql: 'NOT EXISTS (SELECT 1 FROM plans WHERE workspace_id = ? AND public_id = ?)', values: [workspace, planId] };
}
export async function preparePlanPublication(db: DB, actor: ConnectionActor, env: ProviderEnvironment, connectionId: string, planId: string, body: Record<string, unknown>, fetcher: ProviderFetch = fetch) {
  await local(db, actor, connectionId, planId); exact(body, ['operation_id', 'expected_preview_fingerprint', 'draft']);
  if (!isSyncUuid(body.operation_id)) throw new ProviderConnectionError('Choose a new publication review.', 400);
  const fingerprint = hash({ connectionId, planId, body }), replay = await writeFor(db, body.operation_id);
  if (replay) {
    const own = await pubFor(db, actor, planId);
    if (!own || own.id !== replay.publication_id || own.connection_id !== connectionId || replay.fingerprint !== fingerprint) throw new ProviderConnectionError('This publication request belongs to a different review.');
    return { write: publicView({ ...(await local(db, actor, connectionId, planId)), write: replay }).write };
  }
  let validated: ReturnType<typeof publicationDraft>;
  try { validated = publicationDraft(body.draft); } catch (error) { throw new ProviderConnectionError((error as Error).message, 400); }
  const { c, access, r, fingerprint: freshFingerprint } = await inspect(db, actor, env, connectionId, planId, fetcher);
  if (freshFingerprint !== body.expected_preview_fingerprint || !c.plan || c.plan.completed_at) throw new ProviderConnectionError('The plan, calendar or event changed. Refresh while keeping your draft.');
  if (c.pub?.confirmed_at && !r || r && !r.editable) throw new ProviderConnectionError('This published event is missing, cancelled, recurring or too large to edit here. It will not be recreated.');
  if (c.write && ['pending', 'unknown'].includes(c.write.status)) throw new ProviderConnectionError('Resolve or discard the retained review before starting another.');
  if (c.pub?.lease_token && c.pub.lease_until! >= Date.now()) throw new ProviderConnectionError('This publication is still being processed.', 503);
  if (validated.google.attendees.some((p) => p.email === access.connection.email.toLowerCase())) throw new ProviderConnectionError('The publishing account owns this event. Do not add it as its own invitee.', 400);
  const pubId = c.pub?.id ?? crypto.randomUUID(), eventId = c.pub?.event_id ?? pubId.replaceAll('-', ''), now = new Date().toISOString(), guard = crypto.randomUUID(), condition = planCondition(c.plan, actor.workspaceId, planId);
  const request = JSON.stringify({ draft: validated.draft, google: validated.google, calendar_fingerprint: hash(access.calendar) } satisfies Frozen);
  await db.batch([
    providerWriteGuard(db, access.grant, guard),
    maintenanceGuard(db, guard + '-review', publishingOwnerCondition + ' AND ' + condition.sql + (c.pub ? ' AND EXISTS (SELECT 1 FROM calendar_plan_publications WHERE id = ? AND revision = ? AND (lease_token IS NULL OR lease_until < ?))' : ' AND NOT EXISTS (SELECT 1 FROM calendar_plan_publications WHERE workspace_id = ? AND plan_public_id = ?)'),
      [...publishingOwnerValues(access.connection), ...condition.values, ...(c.pub ? [pubId, c.pub.revision, Date.now()] : [actor.workspaceId, planId])]),
    ...(!c.pub ? [db.prepare('INSERT INTO calendar_plan_publications (id, workspace_id, user_id, connection_id, plan_public_id, calendar_id, event_id, creator_client_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(pubId, actor.workspaceId, actor.userId, connectionId, planId, access.calendar.id, eventId, access.clientId, now, now)] : []),
    ...(c.write && ['held', 'conflict'].includes(c.write.status) ? [db.prepare("UPDATE calendar_plan_writes SET status = 'superseded', revision = revision + 1 WHERE id = ? AND revision = ?").bind(c.write.id, c.write.revision)] : []),
    db.prepare('INSERT INTO calendar_plan_writes (id, publication_id, fingerprint, request_json, plan_fingerprint, dataset_epoch, authorization_revision, publication_revision, kind, base_etag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(body.operation_id, pubId, fingerprint, request, planHash(c.plan), access.connection.dataset_epoch, access.connection.authorization_revision, c.pub?.revision ?? 1, r ? 'update' : 'create', r?.etag ?? null, now, now),
    removeGuard(db, guard), removeGuard(db, guard + '-review'),
  ]).catch((error: unknown) => {
    if (String(error).includes('calendar_publication_reservations')) throw new ProviderConnectionError('This plan acquired another Calendar publication. Review its original receipt before continuing.');
    throw error;
  });
  return { write: publicView(await local(db, actor, connectionId, planId)).write };
}
function guests(value: Record<string, unknown>, selected: Array<{ email: string }>) {
  const original = Array.isArray(value.attendees) ? value.attendees as Record<string, unknown>[] : [];
  return selected.map(({ email }) => {
    const existing = original.find((p) => typeof p.email === 'string' && p.email.toLowerCase() === email), next: Record<string, unknown> = { email };
    if (existing) for (const key of ['displayName', 'responseStatus', 'comment', 'optional', 'resource', 'additionalGuests']) if (existing[key] !== undefined) {
      const v = existing[key];
      if (['displayName', 'comment'].includes(key) && (typeof v !== 'string' || v.length > (key === 'comment' ? 4096 : 200))
        || ['optional', 'resource'].includes(key) && typeof v !== 'boolean' || key === 'additionalGuests' && (!Number.isSafeInteger(v) || Number(v) < 0 || Number(v) > 100)
        || key === 'responseStatus' && !['needsAction', 'accepted', 'tentative', 'declined'].includes(String(v))) throw new PublicationError('invalid');
      next[key] = v;
    }
    return next;
  });
}
async function finish(db: DB, actor: ConnectionActor, c: Context, access: Access, write: Write, lease: string, r: ReturnType<typeof remote>) {
  const pub = c.pub!, data = frozen(write), unchanged = planHash(c.plan) === write.plan_fingerprint && write.dataset_epoch === access.connection.dataset_epoch && write.authorization_revision === access.connection.authorization_revision && pub.revision === write.publication_revision;
  let follow = unchanged ? data.draft.follow_plan_date : Boolean(pub.follow_date), issue: string | null = null;
  const eventDay = r.facts.start?.date ?? (r.facts.start?.instant ? dateInTimeZone(r.facts.start.instant, r.facts.start.time_zone ?? access.calendar.time_zone) : null);
  if (!c.plan || c.plan.completed_at || r.facts.status === 'cancelled') follow = false;
  const canFollow = c.plan && (unchanged && write.status !== 'confirmed' || c.plan.planned_date === pub.last_plan_date);
  if (follow && !canFollow) { follow = false; issue = 'plan_date_changed'; }
  const nextDate = follow && eventDay ? eventDay : c.plan?.planned_date ?? null, now = new Date().toISOString(), guard = crypto.randomUUID(), condition = planCondition(c.plan, actor.workspaceId, pub.plan_public_id);
  const save = Boolean(c.saved || c.plan && unchanged && write.status !== 'confirmed');
  const sourceId = c.saved?.public_id ?? crypto.randomUUID();
  const attach = Boolean(c.plan && (unchanged && write.status !== 'confirmed' || c.saved && c.link?.event_id === c.saved.id));
  const sourceCondition = c.saved ? 'EXISTS (SELECT 1 FROM calendar_events WHERE id = ? AND workspace_id = ? AND revision = ?)' : "NOT EXISTS (SELECT 1 FROM calendar_events WHERE workspace_id = ? AND provider = 'google-calendar' AND account_key = ? AND calendar_key = ? AND external_id = ?)";
  await db.batch([
    providerWriteGuard(db, access.grant, guard),
    maintenanceGuard(db, guard + '-finish', publishingOwnerCondition + ' AND ' + condition.sql + ' AND ' + sourceCondition
      + ' AND EXISTS (SELECT 1 FROM calendar_plan_publications WHERE id = ? AND revision = ? AND lease_token = ? AND lease_until >= ?)'
      + ' AND EXISTS (SELECT 1 FROM calendar_plan_writes WHERE id = ? AND revision = ? AND status NOT IN (\'discarded\', \'superseded\') AND id = (SELECT id FROM calendar_plan_writes WHERE publication_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1))'
      + (c.plan ? ' AND NOT EXISTS (SELECT 1 FROM calendar_event_plans WHERE workspace_id = ? AND plan_id = ? AND event_id IS NOT ?)' : ''),
      [...publishingOwnerValues(access.connection), ...condition.values, ...(c.saved ? [c.saved.id, actor.workspaceId, c.saved.revision] : [actor.workspaceId, access.connection.account_id, pub.calendar_id, pub.event_id]),
        pub.id, pub.revision, lease, Date.now(), write.id, write.revision, pub.id, ...(c.plan ? [actor.workspaceId, c.plan.id, c.saved?.id ?? null] : [])]),
    ...(save ? [db.prepare("INSERT INTO calendar_events (public_id, workspace_id, provider, account_key, account_email, calendar_key, calendar_label, calendar_time_zone, external_id, facts, availability, observed_at, created_at, updated_at) VALUES (?, ?, 'google-calendar', ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?) ON CONFLICT(workspace_id, provider, account_key, calendar_key, external_id) DO UPDATE SET facts = excluded.facts, availability = 'available', calendar_label = excluded.calendar_label, calendar_time_zone = excluded.calendar_time_zone, observed_at = excluded.observed_at, updated_at = excluded.updated_at, revision = calendar_events.revision + 1")
      .bind(sourceId, actor.workspaceId, access.connection.account_id, access.connection.email, pub.calendar_id, access.calendar.summary, access.calendar.time_zone, pub.event_id, JSON.stringify(r.facts), now, now, now)] : []),
    ...(save && attach && c.plan ? [db.prepare('INSERT OR IGNORE INTO calendar_event_plans (workspace_id, event_id, plan_id, created_at) SELECT ?, id, ?, ? FROM calendar_events WHERE workspace_id = ? AND public_id = ?').bind(actor.workspaceId, c.plan.id, now, actor.workspaceId, sourceId)] : []),
    ...(follow && nextDate && c.plan ? [db.prepare('UPDATE plans SET planned_date = ? WHERE workspace_id = ? AND public_id = ? AND completed_at IS NULL').bind(nextDate, actor.workspaceId, pub.plan_public_id)] : []),
    db.prepare("UPDATE calendar_plan_publications SET status = 'published', issue = ?, follow_date = ?, last_plan_date = ?, last_etag = ?, confirmed_at = COALESCE(confirmed_at, ?), revision = revision + 1, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?")
      .bind(issue, Number(follow), nextDate, r.etag, now, now, pub.id),
    db.prepare("UPDATE calendar_plan_writes SET status = 'confirmed', issue = NULL, retry_at = 0, revision = revision + 1, updated_at = ? WHERE id = ?").bind(now, write.id),
    removeGuard(db, guard), removeGuard(db, guard + '-finish'),
  ]);
}
export async function advancePlanPublication(db: DB, actor: ConnectionActor, env: ProviderEnvironment, connectionId: string, planId: string, body: Record<string, unknown>, fetcher: ProviderFetch = fetch) {
  exact(body, ['operation_id', 'expected_revision', 'expected_epoch', 'expected_authorization_revision', 'expected_plan_fingerprint', 'mode']);
  const c = await local(db, actor, connectionId, planId), write = c.write, pub = c.pub;
  if (!write || !pub || write.id !== body.operation_id || write.revision !== body.expected_revision || body.expected_epoch !== c.connection.epoch || body.expected_authorization_revision !== c.connection.authorization_revision || body.expected_plan_fingerprint !== planHash(c.plan)
    || !['send', 'verify'].includes(String(body.mode))) throw new ProviderConnectionError('Refresh the plan and retained publication before continuing.');
  if (['discarded', 'superseded'].includes(write.status)) return publicView(c);
  const sending = body.mode === 'send';
  if (sending && (write.status === 'confirmed' || write.dataset_epoch !== c.connection.epoch || write.authorization_revision !== c.connection.authorization_revision
    || write.publication_revision !== pub.revision || write.plan_fingerprint !== planHash(c.plan) || !c.plan || c.plan.completed_at)) throw new ProviderConnectionError('This review belongs to an earlier plan or consent. Verify it or prepare a fresh review.');
  const lease = crypto.randomUUID(), claimed = await db.prepare('UPDATE calendar_plan_publications SET lease_token = ?, lease_until = ? WHERE id = ? AND revision = ? AND (lease_token IS NULL OR lease_until < ?) RETURNING id')
    .bind(lease, Date.now() + 75_000, pub.id, pub.revision, Date.now()).first();
  if (!claimed) throw new ProviderConnectionError('This publication is still being processed. Refresh shortly.', 503);
  let access: Access | undefined, currentWrite = write;
  try {
    access = await publishingCalendarAccess(db, actor, env, connectionId, fetcher);
    if (access.calendar.id !== pub.calendar_id || access.clientId !== pub.creator_client_id) throw new PublicationError('identity');
    let value = await requestGoogle(access.grant, pub, fetcher), r = value ? remote(value, pub, access.calendar.time_zone) : null;
    const data = frozen(write), matched = r?.draft && hash(publicationDraft(r.draft).google) === hash(data.google);
    if (r && (r.operation === write.id || write.status === 'confirmed' && !sending || matched && (!write.base_etag || r.etag === write.base_etag))) {
      await finish(db, actor, c, access, write, lease, r); return publicView(await local(db, actor, connectionId, planId));
    }
    if (!sending) {
      if (!r && pub.confirmed_at) {
        const guard = crypto.randomUUID();
        await db.batch([providerWriteGuard(db, access.grant, guard),
          maintenanceGuard(db, guard + '-missing', publishingOwnerCondition + ' AND EXISTS (SELECT 1 FROM calendar_plan_publications WHERE id = ? AND revision = ? AND lease_token = ? AND lease_until >= ?)', [...publishingOwnerValues(access.connection), pub.id, pub.revision, lease, Date.now()]),
          db.prepare("UPDATE calendar_plan_publications SET status = 'missing', follow_date = 0, issue = 'missing', revision = revision + 1 WHERE id = ?").bind(pub.id),
          db.prepare("UPDATE calendar_events SET availability = 'unavailable', revision = revision + 1 WHERE workspace_id = ? AND provider = 'google-calendar' AND account_key = ? AND calendar_key = ? AND external_id = ? AND availability != 'unavailable'").bind(actor.workspaceId, access.connection.account_id, pub.calendar_id, pub.event_id),
          removeGuard(db, guard), removeGuard(db, guard + '-missing')]);
        return publicView(await local(db, actor, connectionId, planId));
      }
      throw new PublicationError(r ? 'conflict' : 'missing');
    }
    if (hash(access.calendar) !== data.calendar_fingerprint || write.kind === 'update' && (!r || !r.editable || r.etag !== write.base_etag) || write.kind === 'create' && r) throw new PublicationError('conflict');
    if (write.retry_at > Date.now()) throw new ProviderConnectionError('Wait briefly, then verify the original event before retrying.', 503);
    const guard = crypto.randomUUID(), condition = planCondition(c.plan, actor.workspaceId, planId);
    await db.batch([providerWriteGuard(db, access.grant, guard),
      maintenanceGuard(db, guard + '-send', publishingOwnerCondition + ' AND ' + condition.sql + ' AND EXISTS (SELECT 1 FROM calendar_plan_publications WHERE id = ? AND revision = ? AND lease_token = ? AND lease_until >= ?) AND EXISTS (SELECT 1 FROM calendar_plan_writes WHERE id = ? AND revision = ?)',
        [...publishingOwnerValues(access.connection), ...condition.values, pub.id, pub.revision, lease, Date.now(), write.id, write.revision]),
      db.prepare("UPDATE calendar_plan_writes SET attempts = attempts + 1, status = 'unknown', issue = NULL, retry_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?").bind(Date.now() + 30_000, new Date().toISOString(), write.id),
      removeGuard(db, guard), removeGuard(db, guard + '-send')]);
    currentWrite = { ...write, attempts: write.attempts + 1, revision: write.revision + 1, status: 'unknown' };
    const stillCurrent = await db.prepare('SELECT 1 WHERE ' + publishingOwnerCondition + ' AND ' + condition.sql + ' AND EXISTS (SELECT 1 FROM calendar_plan_publications WHERE id = ? AND revision = ? AND lease_token = ? AND lease_until >= ?)')
      .bind(...publishingOwnerValues(access.connection), ...condition.values, pub.id, pub.revision, lease, Date.now()).first();
    if (!stillCurrent) throw new ProviderConnectionError('Plan, authorization or recovery changed before sending.');
    const event: Record<string, unknown> = { ...data.google, extendedProperties: { private: { everclosePublication: pub.id, evercloseOperation: write.id } } };
    let invitations = data.google.attendees.length > 0;
    if (write.kind === 'create') { event.id = pub.event_id; if (!invitations) delete event.attendees; }
    else {
      const previousEmails = r!.draft!.attendee_emails.map((email) => email.toLowerCase()).sort();
      if (JSON.stringify(previousEmails) === JSON.stringify(data.google.attendees.map((p) => p.email))) delete event.attendees;
      else { event.attendees = guests(r!.value, data.google.attendees); invitations = Boolean(previousEmails.length || data.google.attendees.length); }
    }
    value = await requestGoogle(access.grant, pub, fetcher, { body: event, etag: write.kind === 'update' ? write.base_etag! : undefined, invitations });
    if (!value) throw new PublicationError('invalid');
    r = remote(value, pub, access.calendar.time_zone);
    if (r.operation !== write.id) throw new PublicationError('identity');
    await finish(db, actor, c, access, currentWrite, lease, r);
    return publicView(await local(db, actor, connectionId, planId));
  } catch (error) {
    if (error instanceof PublicationError) {
      if (error.reason === 'permission' && access) await requireGoogleReconnection(db, access.grant);
      else await db.prepare("UPDATE calendar_plan_writes SET status = ?, issue = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND EXISTS (SELECT 1 FROM calendar_plan_publications WHERE id = ? AND revision = ? AND lease_token = ? AND lease_until >= ?)")
        .bind(error.reason === 'conflict' ? 'conflict' : 'unknown', error.reason, write.id, currentWrite.revision, pub.id, pub.revision, lease, Date.now()).run();
      return publicView(await local(db, actor, connectionId, planId));
    }
    throw error;
  } finally { await db.prepare('UPDATE calendar_plan_publications SET lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ?').bind(pub.id, lease).run(); }
}
export async function discardPlanPublication(db: DB, actor: ConnectionActor, connectionId: string, planId: string, body: Record<string, unknown>) {
  exact(body, ['operation_id', 'expected_revision']);
  const c = await local(db, actor, connectionId, planId);
  if (!c.pub || !c.write || c.write.id !== body.operation_id || c.write.revision !== body.expected_revision) throw new ProviderConnectionError('Refresh the retained review before discarding.');
  const result = await db.prepare("UPDATE calendar_plan_writes SET status = 'discarded', revision = revision + 1 WHERE id = ? AND revision = ? AND attempts = 0 AND status IN ('pending', 'unknown', 'held', 'conflict') AND EXISTS (SELECT 1 FROM calendar_plan_publications WHERE id = ? AND (lease_token IS NULL OR lease_until < ?))")
    .bind(c.write.id, c.write.revision, c.pub.id, Date.now()).run();
  if (!result.meta.changes) throw new ProviderConnectionError('This review may have reached Google. Verify its original event instead of discarding.');
  return publicView(await local(db, actor, connectionId, planId));
}
