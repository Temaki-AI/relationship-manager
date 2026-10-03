import type Database from 'better-sqlite3';
import type {
  Contact,
  Interaction,
  Plan,
  RelationshipFact,
  Reminder,
} from './db.ts';
import type { Pagination } from './contact-directory.ts';
import {
  listContactChildrenPage,
  listContactRelationshipsPage,
} from './contact-connections.ts';
import { withInteractionEditRevision } from './interaction-revision.ts';
import {
  buildRelationshipBriefFromActivity,
  buildTimeline,
  type ContactActivitySummary,
  type TimelineItem,
} from './intelligence.ts';

export const DEFAULT_INTERACTION_PAGE_SIZE = 30;
export const DEFAULT_TIMELINE_PAGE_SIZE = 30;
export const DEFAULT_REMINDER_HISTORY_PAGE_SIZE = 3;
export const DEFAULT_FACT_PAGE_SIZE = 4;
export const DEFAULT_PLAN_PAGE_SIZE = 20;
export const MAX_CONTACT_HISTORY_PAGE_SIZE = 100;

export type ContactHistoryView = 'interactions' | 'reminders' | 'facts' | 'plans' | 'timeline';

type PageOptions = {
  page?: unknown;
  pageSize?: unknown;
};

export type TimelineKindFilter = TimelineItem['kind'];

export function parseTimelineKindFilter(value: string | null): TimelineKindFilter | null {
  return value === 'interaction' || value === 'reminder' || value === 'fact' || value === 'signal'
    ? value
    : null;
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function buildPagination(
  total: number,
  options: PageOptions,
  defaultPageSize: number
): Pagination {
  const pageSize = boundedInteger(
    options.pageSize,
    defaultPageSize,
    MAX_CONTACT_HISTORY_PAGE_SIZE
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(
    boundedInteger(options.page, 1, Number.MAX_SAFE_INTEGER),
    totalPages
  );
  return { page, pageSize, total, totalPages };
}

function countRows(
  db: Database.Database,
  table: string,
  where: string,
  contactId: number
): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .get(contactId) as { count: number }).count;
}

export function listContactInteractionsPage(
  db: Database.Database,
  contactId: number,
  options: PageOptions = {}
) {
  const total = countRows(db, 'interactions', 'contact_id = ?', contactId);
  const pagination = buildPagination(total, options, DEFAULT_INTERACTION_PAGE_SIZE);
  const interactionRows = db.prepare(`
    SELECT *
    FROM interactions
    WHERE contact_id = ?
    ORDER BY date DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(
    contactId,
    pagination.pageSize,
    (pagination.page - 1) * pagination.pageSize
  ) as Interaction[];
  const interactions = interactionRows.map(withInteractionEditRevision);
  return { interactions, pagination };
}

export function listContactRemindersPage(
  db: Database.Database,
  contactId: number,
  options: PageOptions = {}
) {
  const total = countRows(
    db,
    'reminders',
    'contact_id = ? AND completed_at IS NULL',
    contactId
  );
  const pagination = buildPagination(total, options, DEFAULT_REMINDER_HISTORY_PAGE_SIZE);
  const reminders = db.prepare(`
    SELECT *
    FROM reminders
    WHERE contact_id = ? AND completed_at IS NULL
    ORDER BY julianday(remind_at) ASC, id ASC
    LIMIT ? OFFSET ?
  `).all(
    contactId,
    pagination.pageSize,
    (pagination.page - 1) * pagination.pageSize
  ) as Reminder[];
  return { reminders, pagination };
}

export function listContactFactsPage(
  db: Database.Database,
  contactId: number,
  options: PageOptions = {}
) {
  const total = countRows(db, 'relationship_facts', 'contact_id = ?', contactId);
  const pagination = buildPagination(total, options, DEFAULT_FACT_PAGE_SIZE);
  const facts = db.prepare(`
    SELECT *
    FROM relationship_facts
    WHERE contact_id = ?
    ORDER BY julianday(COALESCE(last_verified_at, created_at)) DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(
    contactId,
    pagination.pageSize,
    (pagination.page - 1) * pagination.pageSize
  ) as RelationshipFact[];
  return { facts, pagination };
}

export function listContactPlansPage(
  db: Database.Database,
  contactId: number,
  options: PageOptions = {}
) {
  const total = countRows(
    db,
    'plans',
    'contact_id = ? AND completed_at IS NULL',
    contactId
  );
  const pagination = buildPagination(total, options, DEFAULT_PLAN_PAGE_SIZE);
  const plans = db.prepare(`
    SELECT *
    FROM plans
    WHERE contact_id = ? AND completed_at IS NULL
    ORDER BY planned_date ASC, id ASC
    LIMIT ? OFFSET ?
  `).all(
    contactId,
    pagination.pageSize,
    (pagination.page - 1) * pagination.pageSize
  ) as Plan[];
  return { plans, pagination };
}

export function timelineCTE(workspaceScoped = false) {
  return `
    WITH derived AS (
      SELECT
        CAST(json_extract(value, '$.id') AS TEXT) AS id,
        CAST(json_extract(value, '$.kind') AS TEXT) AS kind,
        CAST(json_extract(value, '$.title') AS TEXT) AS title,
        CAST(json_extract(value, '$.summary') AS TEXT) AS summary,
        CAST(json_extract(value, '$.date') AS TEXT) AS date,
        CAST(json_extract(value, '$.tone') AS TEXT) AS tone
      FROM json_each(?)
    ), timeline AS (
      SELECT
        'interaction-' || id AS id,
        'interaction' AS kind,
        COALESCE(NULLIF(summary, ''), type || ' logged') AS title,
        COALESCE(NULLIF(notes, ''), 'Interaction type: ' || type) AS summary,
        date,
        'warm' AS tone
      FROM interactions
      WHERE contact_id = ?
      ${workspaceScoped ? 'AND workspace_id = ?' : ''}
      UNION ALL
      SELECT
        'reminder-' || id,
        'reminder',
        title,
        CASE
          WHEN completed_at IS NOT NULL THEN 'Reminder completed'
          ELSE COALESCE(NULLIF(notes, ''), 'Reminder scheduled')
        END,
        COALESCE(completed_at, remind_at),
        CASE WHEN completed_at IS NOT NULL THEN 'info' ELSE 'urgent' END
      FROM reminders
      WHERE contact_id = ?
      ${workspaceScoped ? 'AND workspace_id = ?' : ''}
      UNION ALL
      SELECT
        'fact-' || id,
        'fact',
        label,
        COALESCE(NULLIF(value, ''), 'Source: ' || source),
        COALESCE(last_verified_at, created_at),
        'info'
      FROM relationship_facts
      WHERE contact_id = ?
      ${workspaceScoped ? 'AND workspace_id = ?' : ''}
      UNION ALL
      SELECT id, kind, title, summary, date, tone FROM derived
    )
  `;
}

export function listContactTimelinePage(
  db: Database.Database,
  contact: Contact,
  options: PageOptions & { kind?: TimelineKindFilter } = {}
) {
  const derived = buildTimeline(contact, [], [], []);
  const derivedJson = JSON.stringify(derived);
  const cte = timelineCTE();
  const parameters = [derivedJson, contact.id, contact.id, contact.id];
  const filter = options.kind ? ' AND kind = ?' : '';
  const values = options.kind ? [...parameters, options.kind] : parameters;
  const total = (db.prepare(`
    ${cte}
    SELECT COUNT(*) AS count
    FROM timeline
    WHERE date IS NOT NULL AND date <> ''${filter}
  `).get(...values) as { count: number }).count;
  const pagination = buildPagination(total, options, DEFAULT_TIMELINE_PAGE_SIZE);
  const timeline = db.prepare(`
    ${cte}
    SELECT id, kind, title, summary, date, tone
    FROM timeline
    WHERE date IS NOT NULL AND date <> ''${filter}
    ORDER BY julianday(date) DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(
    ...values,
    pagination.pageSize,
    (pagination.page - 1) * pagination.pageSize
  ) as TimelineItem[];
  return { timeline, pagination };
}

export function loadContactDetailData(
  db: Database.Database,
  contact: Contact,
  now = new Date(),
  timeZone = 'UTC'
) {
  return db.transaction(() => {
    const interactionPage = listContactInteractionsPage(db, contact.id);
    const reminderPage = listContactRemindersPage(db, contact.id);
    const factPage = listContactFactsPage(db, contact.id);
    const planPage = listContactPlansPage(db, contact.id);
    const timelinePage = listContactTimelinePage(db, contact);
    const relationshipPage = listContactRelationshipsPage(db, contact.id);
    const childPage = listContactChildrenPage(db, contact.id);
    const activity: ContactActivitySummary = {
      contactId: contact.id,
      interactionsCount: interactionPage.pagination.total,
      latestInteraction: interactionPage.interactions[0] ?? null,
      openReminders: reminderPage.reminders,
    };

    return {
      contact,
      interactions: interactionPage.interactions,
      reminders: reminderPage.reminders,
      facts: factPage.facts,
      plans: planPage.plans,
      relationships: relationshipPage.relationships,
      children: childPage.children,
      brief: buildRelationshipBriefFromActivity(contact, activity, factPage.facts, now, timeZone),
      timeline: timelinePage.timeline,
      history: {
        interactions: interactionPage.pagination,
        reminders: reminderPage.pagination,
        facts: factPage.pagination,
        plans: planPage.pagination,
        timeline: timelinePage.pagination,
      },
      connections: {
        relationships: relationshipPage.pagination,
        children: childPage.pagination,
      },
    };
  })();
}
