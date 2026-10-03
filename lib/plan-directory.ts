import type Database from 'better-sqlite3';
import type { Pagination } from './contact-directory.ts';
import type { Plan } from './db.ts';

export const DEFAULT_PLAN_DIRECTORY_PAGE_SIZE = 50;
export const MAX_PLAN_DIRECTORY_PAGE_SIZE = 100;

export type PlanDirectoryStatus = 'open' | 'completed' | 'all';

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function buildPagination(total: number, pageValue: unknown, pageSizeValue: unknown): Pagination {
  const pageSize = boundedInteger(
    pageSizeValue,
    DEFAULT_PLAN_DIRECTORY_PAGE_SIZE,
    MAX_PLAN_DIRECTORY_PAGE_SIZE
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(boundedInteger(pageValue, 1, Number.MAX_SAFE_INTEGER), totalPages);
  return { page, pageSize, total, totalPages };
}

export function listPlanPage(
  db: Database.Database,
  options: {
    contactId?: number;
    status?: PlanDirectoryStatus;
    page?: unknown;
    pageSize?: unknown;
  } = {}
): { plans: Plan[]; pagination: Pagination } {
  const conditions: string[] = [];
  const params: number[] = [];
  if (options.contactId) {
    conditions.push('contact_id = ?');
    params.push(options.contactId);
  }
  if (options.status === 'open') conditions.push('completed_at IS NULL');
  if (options.status === 'completed') conditions.push('completed_at IS NOT NULL');
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM plans ${where}`)
    .get(...params) as { count: number }).count;
  const pagination = buildPagination(total, options.page, options.pageSize);
  const plans = db.prepare(`
    SELECT *
    FROM plans
    ${where}
    ORDER BY planned_date ASC, id ASC
    LIMIT ? OFFSET ?
  `).all(
    ...params,
    pagination.pageSize,
    (pagination.page - 1) * pagination.pageSize
  ) as Plan[];
  return { plans, pagination };
}
