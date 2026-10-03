import type Database from 'better-sqlite3';
import type { Pagination } from './contact-directory.ts';
import { parseDateOnly, parsePositiveInteger } from './relationship-validation.ts';

export const DEFAULT_CONNECTION_PAGE_SIZE = 20;
export const MAX_CONNECTION_PAGE_SIZE = 100;

export type ContactRelationshipItem = {
  id: number;
  related_contact_id: number;
  related_name: string;
  related_nickname: string | null;
  relationship_label: string;
  reciprocal_label: string;
  created_at: string;
};

export type ContactChildItem = {
  id: number;
  contact_id: number;
  linked_contact_id: number | null;
  linked_name: string | null;
  linked_birthday: string | null;
  name: string;
  birthday: string | null;
  created_at: string;
  updated_at: string;
};

export class ContactConnectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContactConnectionInputError';
  }
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function buildPagination(total: number, requestedPage: unknown, requestedPageSize: unknown): Pagination {
  const pageSize = boundedInteger(
    requestedPageSize,
    DEFAULT_CONNECTION_PAGE_SIZE,
    MAX_CONNECTION_PAGE_SIZE
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(boundedInteger(requestedPage, 1, Number.MAX_SAFE_INTEGER), totalPages);
  return { page, pageSize, total, totalPages };
}

function normalizedText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new ContactConnectionInputError(`${field} is required.`);
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized) throw new ContactConnectionInputError(`${field} is required.`);
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ContactConnectionInputError(`${field} contains unsupported characters.`);
  }
  if (normalized.length > maximumLength) {
    throw new ContactConnectionInputError(`${field} must be ${maximumLength} characters or fewer.`);
  }
  return normalized;
}

export function normalizeRelationshipLabels(value: unknown): {
  relationshipLabel: string;
  reciprocalLabel: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContactConnectionInputError('Relationship details are required.');
  }
  const body = value as Record<string, unknown>;
  return {
    relationshipLabel: normalizedText(body.relationship_label, 'Relationship label', 80),
    reciprocalLabel: normalizedText(body.reciprocal_label, 'Reciprocal label', 80),
  };
}

export function normalizeChildInput(value: unknown): { name: string; birthday: string | null; linked_contact_id: number | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContactConnectionInputError('Child details are required.');
  }
  const body = value as Record<string, unknown>;
  const name = normalizedText(body.name, 'Child name', 200);
  const linkedContactId = body.linked_contact_id === undefined || body.linked_contact_id === null || body.linked_contact_id === ''
    ? null : parsePositiveInteger(body.linked_contact_id);
  if (linkedContactId === null && body.linked_contact_id !== undefined && body.linked_contact_id !== null && body.linked_contact_id !== '') {
    throw new ContactConnectionInputError('Choose a valid linked profile.');
  }
  if (body.birthday === undefined || body.birthday === null || body.birthday === '') {
    return { name, birthday: null, linked_contact_id: linkedContactId };
  }
  const birthday = parseDateOnly(body.birthday);
  if (!birthday) throw new ContactConnectionInputError('Child birthday must be a valid date.');
  return { name, birthday, linked_contact_id: linkedContactId };
}

export function validateChildLink(parentId: number, birthday: string | null, linkedId: number, linkedBirthday: string | null): void {
  if (parentId === linkedId) throw new ContactConnectionInputError('A contact cannot be linked as their own child.');
  if (birthday && birthday !== linkedBirthday) {
    throw new ContactConnectionInputError('Set the same birthday on the linked profile before connecting these records.');
  }
}

export function listContactRelationshipsPage(
  db: Database.Database,
  contactId: number,
  options: { page?: unknown; pageSize?: unknown } = {}
): { relationships: ContactRelationshipItem[]; pagination: Pagination } {
  const total = Number(db.prepare(`
    SELECT COUNT(*)
    FROM contact_relationships
    WHERE contact_id = ? OR related_contact_id = ?
  `).pluck().get(contactId, contactId));
  const pagination = buildPagination(total, options.page, options.pageSize);
  const relationships = db.prepare(`
    SELECT
      relationship.id,
      related.id AS related_contact_id,
      related.name AS related_name,
      related.nickname AS related_nickname,
      CASE
        WHEN relationship.contact_id = ? THEN relationship.relationship_label
        ELSE relationship.reciprocal_label
      END AS relationship_label,
      CASE
        WHEN relationship.contact_id = ? THEN relationship.reciprocal_label
        ELSE relationship.relationship_label
      END AS reciprocal_label,
      relationship.created_at
    FROM contact_relationships relationship
    JOIN contacts related ON related.id = CASE
      WHEN relationship.contact_id = ? THEN relationship.related_contact_id
      ELSE relationship.contact_id
    END
    WHERE relationship.contact_id = ? OR relationship.related_contact_id = ?
    ORDER BY related.name COLLATE NOCASE, related.id, relationship.id
    LIMIT ? OFFSET ?
  `).all(
    contactId,
    contactId,
    contactId,
    contactId,
    contactId,
    pagination.pageSize,
    (pagination.page - 1) * pagination.pageSize
  ) as ContactRelationshipItem[];
  return { relationships, pagination };
}

export function listContactChildrenPage(
  db: Database.Database,
  contactId: number,
  options: { page?: unknown; pageSize?: unknown } = {}
): { children: ContactChildItem[]; pagination: Pagination } {
  const total = Number(db.prepare('SELECT COUNT(*) FROM contact_children WHERE contact_id = ?')
    .pluck().get(contactId));
  const pagination = buildPagination(total, options.page, options.pageSize);
  const children = db.prepare(`
    SELECT child.id, child.contact_id, child.linked_contact_id, child.name, child.birthday,
      child.created_at, child.updated_at, linked.name AS linked_name, linked.birthday AS linked_birthday
    FROM contact_children child
    LEFT JOIN contacts linked ON linked.id = child.linked_contact_id
    WHERE child.contact_id = ?
    ORDER BY COALESCE(linked.name, child.name) COLLATE NOCASE, child.id
    LIMIT ? OFFSET ?
  `).all(
    contactId,
    pagination.pageSize,
    (pagination.page - 1) * pagination.pageSize
  ) as ContactChildItem[];
  return { children, pagination };
}
