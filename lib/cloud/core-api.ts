import { AUTOMATIC_ACCOUNT_SYNC, DATA_CAPABILITIES } from '@/lib/data-capabilities';
import { parseGroupColor, parseGroupName } from '@/lib/group-input';
import { createCloudResource } from '@/lib/cloud/idempotency';
import { IdempotencyError } from '@/lib/idempotency';
import { RequestBodyError } from '@/lib/request-body';
import { readCloudObject } from '@/lib/cloud/request';
import { recoveryErrorResponse } from '@/lib/cloud/recovery-contract';
import type { Interaction } from '@/lib/db';
import { getExpectedInteractionRevision, getInteractionEditRevision, InteractionRevisionError, withInteractionEditRevision } from '@/lib/interaction-revision';
import {
  parseDateOnly,
  parseDateTime,
  parseOptionalText,
  parsePositiveInteger,
  parseRelationshipActivityType,
} from '@/lib/relationship-validation';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cloudIntelligenceOverview } from '@/lib/cloud/intelligence-directory';
import { cloudCalendarEvents } from '@/lib/cloud/calendar-directory';
import { CalendarRangeError } from '@/lib/calendar-directory';
import { dateInTimeZone, nextBirthdayOccurrence, normalizeTimeZone } from '@/lib/civil-date';
import { MAX_NOTIFICATION_CANDIDATES } from '@/lib/reminder-directory';
import { CalendarScheduleError, calendarScheduleState, calendarScheduleStatement, readCalendarScheduleInput, withCalendarScheduleRevision, type CalendarScheduleKind, type CalendarScheduleRecord } from '@/lib/calendar-schedule';
import { birthdayStatsSQL, checkInStatsSQL, statsResponse, statsToday } from '@/lib/stats-directory';

type DB = CloudflareEnv['DB'];

const json = (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, { status, headers });

function bounded(value: string | null, fallback: number, maximum = 100) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function page(url: URL, total: number, fallback = 50) {
  const pageSize = bounded(url.searchParams.get('pageSize'), fallback);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(bounded(url.searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER), totalPages);
  return { page: current, pageSize, total, totalPages, offset: (current - 1) * pageSize };
}

function publicPage(value: ReturnType<typeof page>) {
  return { page: value.page, pageSize: value.pageSize, total: value.total, totalPages: value.totalPages };
}

async function ownedContact(db: DB, workspaceId: string, contactId: number) {
  return Boolean(await db.prepare('SELECT 1 FROM contacts WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, contactId).first());
}

async function scheduleRecord(db: DB, workspaceId: string, kind: CalendarScheduleKind, id: number) {
  return db.prepare(`SELECT r.*, s.epoch AS schedule_epoch FROM ${kind === 'plan' ? 'plans' : 'reminders'} r
    JOIN workspace_sync_state s ON s.workspace_id = r.workspace_id JOIN workspaces w ON w.id = s.workspace_id
    WHERE r.workspace_id = ? AND r.id = ? AND s.paused = 0 AND w.lifecycle = 'active'`).bind(workspaceId, id).first<CalendarScheduleRecord>();
}
async function reschedule(requestBody: Record<string, unknown>, workspaceId: string, kind: CalendarScheduleKind, id: number) {
  const db = getCloudflareContext().env.DB;
  const input = readCalendarScheduleInput(kind, requestBody);
  const current = await scheduleRecord(db, workspaceId, kind, id);
  if (!current) throw new CalendarScheduleError('This event is no longer available.', 404);
  if (calendarScheduleState(kind, current, input) === 'confirmed') return json({ [kind]: withCalendarScheduleRevision(kind, current), dateChanged: false });
  const statement = calendarScheduleStatement(kind, current, input.at);
  const updated = await db.prepare(statement.sql).bind(...statement.values).first<CalendarScheduleRecord>();
  if (updated) return json({ [kind]: withCalendarScheduleRevision(kind, { ...updated, schedule_epoch: current.schedule_epoch }), dateChanged: true });
  const latest = await scheduleRecord(db, workspaceId, kind, id);
  if (latest && calendarScheduleState(kind, latest, input) === 'confirmed') return json({ [kind]: withCalendarScheduleRevision(kind, latest), dateChanged: false });
  throw new CalendarScheduleError('This event changed after you opened it. Review it again.', latest ? 409 : 404);
}

async function reminders(request: Request, workspaceId: string, id?: number) {
  const db = getCloudflareContext().env.DB;
  if (id && request.method === 'GET') {
    const reminder = await scheduleRecord(db, workspaceId, 'reminder', id);
    return reminder ? json({ reminder: withCalendarScheduleRevision('reminder', reminder) }, 200, { 'Cache-Control': 'no-store' }) : json({ error: 'Reminder not found' }, 404);
  }
  if (id && request.method === 'DELETE') {
    const result = await db.prepare('DELETE FROM reminders WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).run();
    return json({ success: true, alreadyDeleted: result.meta.changes === 0 });
  }
  if (id && request.method === 'PATCH') {
    const body = await readCloudObject(request);
    if (Object.hasOwn(body, 'calendar_schedule')) return await reschedule(body, workspaceId, 'reminder', id);
    if (body.completed === true) {
      const completedAt = new Date().toISOString();
      const result = await db.prepare('UPDATE reminders SET completed_at = ? WHERE workspace_id = ? AND id = ? AND completed_at IS NULL')
        .bind(completedAt, workspaceId, id).run();
      const reminder = await db.prepare('SELECT * FROM reminders WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).first();
      if (!reminder) return json({ error: 'Reminder not found' }, 404);
      return json({ reminder, completionChanged: result.meta.changes > 0 });
    }
    const title = parseOptionalText(body.title, 200);
    const notes = parseOptionalText(body.notes, 10_000);
    const remindAt = parseDateTime(body.remind_at);
    if (!title || notes === undefined || !remindAt) return json({ error: 'Valid title and remind_at are required' }, 400);
    await db.prepare('UPDATE reminders SET title = ?, notes = ?, remind_at = ? WHERE workspace_id = ? AND id = ?')
      .bind(title, notes, remindAt, workspaceId, id).run();
    const reminder = await db.prepare('SELECT * FROM reminders WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).first();
    return reminder ? json({ reminder }) : json({ error: 'Reminder not found' }, 404);
  }
  if (request.method === 'GET') {
    const url = new URL(request.url);
    if (url.searchParams.get('view') === 'notifications') {
      const today = dateInTimeZone(new Date(), normalizeTimeZone(url.searchParams.get('timeZone')))!;
      const [due, contacts] = await db.batch([
        db.prepare(`SELECT id, remind_at FROM reminders WHERE workspace_id = ? AND completed_at IS NULL AND julianday(remind_at) <= julianday('now')
          ORDER BY julianday(remind_at) DESC, id DESC LIMIT ?`).bind(workspaceId, MAX_NOTIFICATION_CANDIDATES),
        db.prepare('SELECT id, birthday, birthday_reminder_days FROM contacts WHERE workspace_id = ? AND birthday IS NOT NULL ORDER BY id').bind(workspaceId),
      ]);
      const birthdays = [];
      for (const contact of contacts.results as Array<{ id: number; birthday: string; birthday_reminder_days: number }>) {
        const next = nextBirthdayOccurrence(contact.birthday, today);
        if (next && next.daysUntil <= contact.birthday_reminder_days) birthdays.push({ id: contact.id, occurrence: next.occurrence });
        if (birthdays.length === MAX_NOTIFICATION_CANDIDATES) break;
      }
      return json({ reminders: due.results, birthdays });
    }
    const status = url.searchParams.get('status') || 'open';
    if (!['open', 'completed', 'all'].includes(status)) return json({ error: 'Unknown reminder status.' }, 400);
    const statusClause = status === 'open' ? 'AND reminders.completed_at IS NULL' : status === 'completed' ? 'AND reminders.completed_at IS NOT NULL' : '';
    const count = await db.prepare(`SELECT COUNT(*) AS total FROM reminders WHERE workspace_id = ? ${statusClause}`).bind(workspaceId).first<{ total: number }>();
    const paging = page(url, Number(count?.total || 0));
    const result = await db.prepare(`SELECT reminders.*, contacts.name AS contact_name FROM reminders
      JOIN contacts ON contacts.workspace_id = reminders.workspace_id AND contacts.id = reminders.contact_id
      WHERE reminders.workspace_id = ? ${statusClause} ORDER BY completed_at IS NOT NULL, datetime(remind_at), reminders.id LIMIT ? OFFSET ?`)
      .bind(workspaceId, paging.pageSize, paging.offset).all();
    return json({ reminders: result.results, pagination: publicPage(paging) });
  }
  const body = await readCloudObject(request);
  const contactId = parsePositiveInteger(body.contact_id);
  const title = parseOptionalText(body.title, 200);
  const notes = parseOptionalText(body.notes, 10_000);
  const remindAt = parseDateTime(body.remind_at);
  if (!contactId || !title || notes === undefined || !remindAt) return json({ error: 'Valid contact_id, title, and remind_at are required' }, 400);
  if (!await ownedContact(db, workspaceId, contactId)) return json({ error: 'Contact not found' }, 404);
  const result = await createCloudResource(db, request, workspaceId, 'reminders', { contact_id: contactId, title, notes, remind_at: remindAt });
  return json({ reminder: result.resource }, 201, { 'Idempotency-Replayed': String(result.replayed) });
}

async function interactions(request: Request, workspaceId: string, id?: number) {
  const db = getCloudflareContext().env.DB;
  if (id && request.method === 'GET') {
    const interaction = await db.prepare('SELECT * FROM interactions WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id).first<Interaction>();
    return interaction ? json({ interaction: withInteractionEditRevision(interaction) })
      : json({ error: 'Interaction not found' }, 404);
  }
  if (id && request.method === 'DELETE') {
    const result = await db.prepare('DELETE FROM interactions WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).run();
    return json({ success: true, alreadyDeleted: result.meta.changes === 0 });
  }
  const body = await readCloudObject(request);
  if (id && request.method === 'PATCH') {
    const date = parseDateOnly(body.date);
    const type = parseRelationshipActivityType(body.type);
    const summary = parseOptionalText(body.summary, 500);
    const notes = parseOptionalText(body.notes, 10_000);
    if (!date || !type || summary === undefined || notes === undefined) return json({ error: 'Valid date and type are required' }, 400);
    const expected = getExpectedInteractionRevision(body);
    const current = await db.prepare('SELECT * FROM interactions WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).first<Interaction>();
    if (!current) return json({ error: 'Interaction not found' }, 404);
    if (getInteractionEditRevision(current) !== expected) return json({ error: 'This interaction changed after you opened it.', current_edit_revision: getInteractionEditRevision(current) }, 409);
    const interaction = await db.prepare(`UPDATE interactions SET occurred_at = CASE WHEN date IS ? THEN occurred_at ELSE NULL END,
      date = ?, type = ?, summary = ?, notes = ?
      WHERE workspace_id = ? AND id = ? AND contact_id IS ? AND date IS ? AND type IS ? AND summary IS ? AND notes IS ? AND occurred_at IS ? RETURNING *`)
      .bind(date, date, type, summary, notes, workspaceId, id, current.contact_id, current.date, current.type, current.summary, current.notes, current.occurred_at ?? null).first<Interaction>();
    if (interaction) return json({ interaction: withInteractionEditRevision(interaction) });
    const latest = await db.prepare('SELECT * FROM interactions WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).first<Interaction>();
    return latest ? json({ error: 'This interaction changed after you opened it.', current_edit_revision: getInteractionEditRevision(latest) }, 409)
      : json({ error: 'Interaction not found' }, 404);
  }
  const contactId = parsePositiveInteger(body.contact_id);
  const date = parseDateOnly(body.date);
  const type = parseRelationshipActivityType(body.type);
  const summary = parseOptionalText(body.summary, 500);
  const notes = parseOptionalText(body.notes, 10_000);
  if (!contactId || !date || !type || summary === undefined || notes === undefined) return json({ error: 'Valid contact_id, date, and type are required' }, 400);
  if (!await ownedContact(db, workspaceId, contactId)) return json({ error: 'Contact not found' }, 404);
  const result = await createCloudResource<Interaction>(db, request, workspaceId, 'interactions', { contact_id: contactId, date, type, summary, notes });
  return json({ interaction: withInteractionEditRevision(result.resource) }, 201, { 'Idempotency-Replayed': String(result.replayed) });
}

async function plans(request: Request, workspaceId: string, id?: number) {
  const db = getCloudflareContext().env.DB;
  if (id && request.method === 'GET') {
    const plan = await scheduleRecord(db, workspaceId, 'plan', id);
    return plan ? json({ plan: withCalendarScheduleRevision('plan', plan) }, 200, { 'Cache-Control': 'no-store' }) : json({ error: 'Plan not found' }, 404);
  }
  if (id && request.method === 'DELETE') {
    const result = await db.prepare('DELETE FROM plans WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).run();
    return json({ success: true, alreadyDeleted: result.meta.changes === 0 });
  }
  if (id && request.method === 'PATCH') {
    const body = await readCloudObject(request);
    if (Object.hasOwn(body, 'calendar_schedule')) return await reschedule(body, workspaceId, 'plan', id);
    if (body.completed === true) {
      const completedAt = new Date().toISOString();
      const date = completedAt.slice(0, 10);
      // changes() refers to the preceding conditional UPDATE in this atomic batch.
      // Only the caller that actually completed the plan creates its interaction.
      const [completion] = await db.batch([
        db.prepare('UPDATE plans SET completed_at = ? WHERE workspace_id = ? AND id = ? AND completed_at IS NULL').bind(completedAt, workspaceId, id),
        db.prepare(`INSERT INTO interactions (workspace_id, contact_id, date, type, summary, notes)
          SELECT workspace_id, contact_id, ?, type, summary, notes FROM plans WHERE workspace_id = ? AND id = ? AND changes() = 1`)
          .bind(date, workspaceId, id),
      ]);
      const updated = await db.prepare('SELECT * FROM plans WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).first();
      return updated ? json({ plan: updated, interactionCreated: completion.meta.changes > 0 }) : json({ error: 'Plan not found' }, 404);
    }
    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.type !== undefined) { const value = parseRelationshipActivityType(body.type); if (!value) return json({ error: 'Valid plan type is required' }, 400); updates.push('type = ?'); values.push(value); }
    if (body.planned_date !== undefined) { const value = parseDateOnly(body.planned_date); if (!value) return json({ error: 'Valid planned_date is required' }, 400); updates.push('planned_date = ?'); values.push(value); }
    for (const [field, limit] of [['summary', 500], ['notes', 10_000]] as const) if (body[field] !== undefined) { const value = parseOptionalText(body[field], limit); if (value === undefined) return json({ error: `Plan ${field} is invalid or too long` }, 400); updates.push(`${field} = ?`); values.push(value); }
    if (!updates.length) return json({ error: 'No fields to update' }, 400);
    await db.prepare(`UPDATE plans SET ${updates.join(', ')} WHERE workspace_id = ? AND id = ?`).bind(...values, workspaceId, id).run();
    const plan = await db.prepare('SELECT * FROM plans WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).first();
    return plan ? json({ plan }) : json({ error: 'Plan not found' }, 404);
  }
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const contactId = parsePositiveInteger(url.searchParams.get('contact_id'));
    const status = url.searchParams.get('status') || (contactId ? 'all' : 'open');
    if (!['open', 'completed', 'all'].includes(status)) return json({ error: 'Unknown plan status.' }, 400);
    const clauses = ['plans.workspace_id = ?'];
    const values: unknown[] = [workspaceId];
    if (contactId) { clauses.push('plans.contact_id = ?'); values.push(contactId); }
    if (status === 'open') clauses.push('plans.completed_at IS NULL');
    if (status === 'completed') clauses.push('plans.completed_at IS NOT NULL');
    const count = await db.prepare(`SELECT COUNT(*) AS total FROM plans WHERE ${clauses.join(' AND ')}`).bind(...values).first<{ total: number }>();
    const paging = page(url, Number(count?.total || 0));
    const result = await db.prepare(`SELECT plans.*, contacts.name AS contact_name FROM plans JOIN contacts ON contacts.workspace_id = plans.workspace_id AND contacts.id = plans.contact_id WHERE ${clauses.join(' AND ')} ORDER BY plans.completed_at IS NOT NULL, plans.planned_date, plans.id LIMIT ? OFFSET ?`).bind(...values, paging.pageSize, paging.offset).all();
    return json({ plans: result.results, pagination: publicPage(paging) });
  }
  const body = await readCloudObject(request);
  const contactId = parsePositiveInteger(body.contact_id);
  const type = parseRelationshipActivityType(body.type);
  const plannedDate = parseDateOnly(body.planned_date);
  const summary = parseOptionalText(body.summary, 500);
  const notes = parseOptionalText(body.notes, 10_000);
  if (!contactId || !type || !plannedDate || summary === undefined || notes === undefined) return json({ error: 'Valid contact_id, type, and planned_date are required' }, 400);
  if (!await ownedContact(db, workspaceId, contactId)) return json({ error: 'Contact not found' }, 404);
  const result = await createCloudResource(db, request, workspaceId, 'plans', { contact_id: contactId, type, planned_date: plannedDate, summary, notes });
  return json({ plan: result.resource }, 201, { 'Idempotency-Replayed': String(result.replayed) });
}

async function groups(request: Request, workspaceId: string, id?: number) {
  const db = getCloudflareContext().env.DB;
  if (id && request.method === 'DELETE') {
    const result = await db.prepare('DELETE FROM contact_groups WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).run();
    return result.meta.changes ? json({ success: true }) : json({ error: 'Group not found' }, 404);
  }
  if (id && request.method === 'GET') {
    const group = await db.prepare('SELECT * FROM contact_groups WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).first();
    if (!group) return json({ error: 'Group not found' }, 404);
    const members = await db.prepare(`SELECT contacts.* FROM contacts JOIN contact_group_members member ON member.workspace_id = contacts.workspace_id AND member.contact_id = contacts.id WHERE member.workspace_id = ? AND member.group_id = ? ORDER BY contacts.name COLLATE NOCASE`).bind(workspaceId, id).all();
    return json({ group, members: members.results, pagination: { page: 1, pageSize: 100, total: members.results.length, totalPages: 1 } });
  }
  if (request.method === 'GET') {
    const result = await db.prepare(`SELECT groups.*, COUNT(member.contact_id) AS member_count FROM contact_groups groups LEFT JOIN contact_group_members member ON member.workspace_id = groups.workspace_id AND member.group_id = groups.id WHERE groups.workspace_id = ? GROUP BY groups.id ORDER BY groups.name COLLATE NOCASE`).bind(workspaceId).all();
    return json({ groups: result.results, pagination: { page: 1, pageSize: 100, total: result.results.length, totalPages: 1 } });
  }
  const body = await readCloudObject(request);
  const name = parseGroupName(body.name);
  const color = parseGroupColor(body.color);
  if (!name || color === undefined) return json({ error: 'Group name or color is invalid' }, 400);
  if (id) {
    await db.prepare('UPDATE contact_groups SET name = ?, color = ? WHERE workspace_id = ? AND id = ?').bind(name, color, workspaceId, id).run();
    const group = await db.prepare('SELECT * FROM contact_groups WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).first();
    return group ? json({ group }) : json({ error: 'Group not found' }, 404);
  }
  const insert = await db.prepare('INSERT INTO contact_groups (workspace_id, name, color) VALUES (?, ?, ?)').bind(workspaceId, name, color).run();
  const group = await db.prepare('SELECT * FROM contact_groups WHERE workspace_id = ? AND id = ?').bind(workspaceId, insert.meta.last_row_id).first();
  return json({ group }, 201);
}

async function stats(request: Request, workspaceId: string) {
  const db = getCloudflareContext().env.DB;
  const today = statsToday(request);
  const [contacts, conversations, rhythms, actionItems, birthdays] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS total FROM contacts WHERE workspace_id = ?').bind(workspaceId).first<{ total: number }>(),
    db.prepare("SELECT COUNT(*) AS total FROM interactions WHERE workspace_id = ? AND date >= date(?, '-7 days') AND date <= ?")
      .bind(workspaceId, today, today).first<{ total: number }>(),
    db.prepare(checkInStatsSQL(true, false)).bind(today, workspaceId).first<{ ready: number; neglected: number }>(),
    db.prepare(checkInStatsSQL(true, true)).bind(today, workspaceId).all<{ id: number }>(),
    db.prepare(birthdayStatsSQL(true)).bind(today, workspaceId)
      .all<{ id: number; name: string; birthday: string; daysUntil: number; total: number }>(),
  ]);
  return json(statsResponse(Number(contacts?.total || 0), Number(conversations?.total || 0), rhythms,
    actionItems.results, birthdays.results));
}

async function integrations(workspaceId: string) {
  const db = getCloudflareContext().env.DB;
  const workspace = await db.prepare('SELECT name FROM workspaces WHERE id = ?').bind(workspaceId).first<{ name: string }>();
  return json({
    workspace: workspace ? { name: workspace.name, mode: 'cloud' } : undefined,
    capabilities: DATA_CAPABILITIES,
    automaticAccountSync: AUTOMATIC_ACCOUNT_SYNC,
  });
}

export async function handleCloudCore(request: Request, workspaceId: string, path: string[], userId?: string) {
  try {
    const id = parsePositiveInteger(path[1]) || undefined;
    if (path[0] === 'reminders') return await reminders(request, workspaceId, id);
    if (path[0] === 'interactions') return await interactions(request, workspaceId, id);
    if (path[0] === 'plans') return await plans(request, workspaceId, id);
    if (path[0] === 'groups') return await groups(request, workspaceId, id);
    if (path[0] === 'calendar' && request.method === 'GET') return json(await cloudCalendarEvents(request, workspaceId, userId));
    if (path[0] === 'stats' && request.method === 'GET') return await stats(request, workspaceId);
    if (path[0] === 'integrations' && request.method === 'GET') return await integrations(workspaceId);
    if (path.join('/') === 'intelligence/overview' && request.method === 'GET') return json(await cloudIntelligenceOverview(workspaceId, request));
    if (path[0] === 'smart-lists' && request.method === 'GET') return json({ smartLists: (await cloudIntelligenceOverview(workspaceId, request)).smartLists });
    return json({ error: 'Cloud endpoint not found.' }, 404);
  } catch (error) {
    if (error instanceof CalendarRangeError) return json({ error: error.message }, 400);
    const recoveryError = recoveryErrorResponse(error);
    if (recoveryError) return recoveryError;
    if (error instanceof IdempotencyError || error instanceof RequestBodyError) return json({ error: error.message }, error.status);
    if (error instanceof InteractionRevisionError) return json({ error: error.message }, 400);
    if (error instanceof CalendarScheduleError) return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return json({ error: 'Request body must be valid JSON.' }, 400);
    console.error('cloud.core.failed', error);
    return json({ error: 'Cloud operation failed.' }, 500);
  }
}
