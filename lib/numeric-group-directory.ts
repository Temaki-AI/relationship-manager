import type Database from 'better-sqlite3';
import type { Pagination } from './contact-directory.ts';
import type { Contact, ContactGroup } from './db.ts';

export const DEFAULT_NUMERIC_GROUP_PAGE_SIZE = 50;
export const MAX_NUMERIC_GROUP_PAGE_SIZE = 100;

export type NumericGroupSummary = ContactGroup & {
  member_count: number;
};

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function buildPagination(total: number, pageValue: unknown, pageSizeValue: unknown): Pagination {
  const pageSize = boundedInteger(
    pageSizeValue,
    DEFAULT_NUMERIC_GROUP_PAGE_SIZE,
    MAX_NUMERIC_GROUP_PAGE_SIZE
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(boundedInteger(pageValue, 1, Number.MAX_SAFE_INTEGER), totalPages);
  return { page, pageSize, total, totalPages };
}

export function listNumericGroupPage(
  db: Database.Database,
  options: { page?: unknown; pageSize?: unknown } = {}
) {
  const total = (db.prepare('SELECT COUNT(*) AS count FROM contact_groups')
    .get() as { count: number }).count;
  const pagination = buildPagination(total, options.page, options.pageSize);
  const groups = db.prepare(`
    SELECT
      contact_groups.*,
      COUNT(contact_group_members.contact_id) AS member_count
    FROM contact_groups
    LEFT JOIN contact_group_members
      ON contact_group_members.group_id = contact_groups.id
    GROUP BY contact_groups.id
    ORDER BY contact_groups.name ASC, contact_groups.id ASC
    LIMIT ? OFFSET ?
  `).all(
    pagination.pageSize,
    (pagination.page - 1) * pagination.pageSize
  ) as NumericGroupSummary[];
  return { groups, pagination };
}

export function listNumericGroupMemberPage(
  db: Database.Database,
  groupId: number,
  options: { page?: unknown; pageSize?: unknown } = {}
) {
  const total = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM contact_group_members
    WHERE group_id = ?
  `).get(groupId) as { count: number }).count;
  const pagination = buildPagination(total, options.page, options.pageSize);
  const members = db.prepare(`
    SELECT contacts.*
    FROM contacts
    JOIN contact_group_members
      ON contact_group_members.contact_id = contacts.id
    WHERE contact_group_members.group_id = ?
    ORDER BY contacts.name ASC, contacts.id ASC
    LIMIT ? OFFSET ?
  `).all(
    groupId,
    pagination.pageSize,
    (pagination.page - 1) * pagination.pageSize
  ) as Contact[];
  return { members, pagination };
}
