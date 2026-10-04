import type Database from 'better-sqlite3';
import { DIRECTORY_CONTACT_COLUMNS, type DirectoryContact } from './contact-directory-projection.ts';
import {
  MAX_TAGS_PER_CONTACT,
  normalizeTag as normalizeCanonicalTag,
  parseStoredTags,
  serializeTagList,
  TagValidationError,
} from './tag-validation.ts';

export const DEFAULT_CONTACT_PAGE_SIZE = 50;
export const MAX_CONTACT_PAGE_SIZE = 100;
export const DEFAULT_GROUP_PAGE_SIZE = 30;
export const MAX_TAG_SUMMARIES_PER_PAGE = 100;
export const MAX_MENTION_OPTIONS = 20;
export const MAX_BULK_TAG_CONTACTS = 100;

export type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type TagSummary = {
  tag: string;
  contactCount: number;
};

export type ContactOption = {
  id: number;
  name: string;
  email: string | null;
  photo_url: null;
};

export type TagDirectoryContact = {
  id: number;
  name: string;
  email: string | null;
};

export class ContactDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContactDirectoryError';
  }
}

const VALID_TAGS_TABLE = `
  contacts
  JOIN json_each(
    CASE WHEN json_valid(contacts.tags) THEN contacts.tags ELSE '[]' END
  ) AS tag_values
`;

const TAG_MEMBERSHIP_SQL = `EXISTS (
  SELECT 1
  FROM json_each(CASE WHEN json_valid(contacts.tags) THEN contacts.tags ELSE '[]' END) AS member_tags
  WHERE member_tags.type = 'text' AND lower(member_tags.value) = lower(?)
)`;

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function normalizeSearch(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
}

function normalizeTag(value: unknown): string {
  try {
    return normalizeCanonicalTag(value);
  } catch (error) {
    if (error instanceof TagValidationError) throw new ContactDirectoryError(error.message);
    throw error;
  }
}

function pagination(total: number, requestedPage: unknown, requestedPageSize: unknown, defaults: {
  pageSize: number;
  maximumPageSize: number;
}): Pagination {
  const pageSize = boundedInteger(
    requestedPageSize,
    defaults.pageSize,
    defaults.maximumPageSize
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(boundedInteger(requestedPage, 1, Number.MAX_SAFE_INTEGER), totalPages);
  return { page, pageSize, total, totalPages };
}

function searchCondition(search: string, fields: string[]): { sql: string; params: string[] } {
  if (!search) return { sql: '', params: [] };
  return {
    sql: `(${fields.map((field) => `instr(lower(COALESCE(${field}, '')), lower(?)) > 0`).join(' OR ')})`,
    params: fields.map(() => search),
  };
}

export function listContactPage(
  db: Database.Database,
  options: { page?: unknown; pageSize?: unknown; search?: unknown; tag?: unknown } = {}
): { contacts: DirectoryContact[]; pagination: Pagination } {
  const search = normalizeSearch(options.search);
  const tag = typeof options.tag === 'string' ? options.tag.trim().slice(0, 100) : '';
  const conditions: string[] = [];
  const params: string[] = [];
  const searchFilter = searchCondition(search, [
    'contacts.name',
    'contacts.nickname',
    'contacts.email',
    'contacts.phone',
    'contacts.notes',
    'contacts.custom_fields',
  ]);
  if (searchFilter.sql) {
    conditions.push(`(${searchFilter.sql} OR EXISTS (SELECT 1 FROM json_each(contacts.contact_methods) WHERE instr(lower(json_extract(value, '$.value')), lower(?)) > 0 OR instr(lower(COALESCE(json_extract(value, '$.label'), '')), lower(?)) > 0))`);
    params.push(...searchFilter.params, search, search);
  }
  if (tag) {
    conditions.push(TAG_MEMBERSHIP_SQL);
    params.push(tag);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = Number((db.prepare(`SELECT COUNT(*) AS count FROM contacts ${where}`)
    .get(...params) as { count: number }).count);
  const page = pagination(total, options.page, options.pageSize, {
    pageSize: DEFAULT_CONTACT_PAGE_SIZE,
    maximumPageSize: MAX_CONTACT_PAGE_SIZE,
  });
  const contacts = db.prepare(`
    SELECT ${DIRECTORY_CONTACT_COLUMNS}
    FROM contacts
    ${where}
    ORDER BY
      CASE WHEN last_contacted IS NULL THEN 1 ELSE 0 END,
      last_contacted DESC,
      name COLLATE NOCASE,
      id
    LIMIT ? OFFSET ?
  `).all(...params, page.pageSize, (page.page - 1) * page.pageSize) as DirectoryContact[];

  return { contacts, pagination: page };
}

export function listTagSummaries(
  db: Database.Database,
  options: { page?: unknown; pageSize?: unknown } = {}
): { tags: TagSummary[]; pagination: Pagination } {
  const total = Number((db.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT lower(tag_values.value)
      FROM ${VALID_TAGS_TABLE}
      WHERE tag_values.type = 'text' AND trim(tag_values.value) <> ''
      GROUP BY lower(tag_values.value)
    )
  `).get() as { count: number }).count);
  const page = pagination(total, options.page, options.pageSize, {
    pageSize: MAX_TAG_SUMMARIES_PER_PAGE,
    maximumPageSize: MAX_TAG_SUMMARIES_PER_PAGE,
  });
  const rows = db.prepare(`
    SELECT MIN(tag_values.value) AS tag, COUNT(DISTINCT contacts.id) AS contact_count
    FROM ${VALID_TAGS_TABLE}
    WHERE tag_values.type = 'text' AND trim(tag_values.value) <> ''
    GROUP BY lower(tag_values.value)
    ORDER BY contact_count DESC, tag COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(page.pageSize, (page.page - 1) * page.pageSize) as Array<{
    tag: string;
    contact_count: number;
  }>;

  return {
    tags: rows.map((row) => ({ tag: row.tag, contactCount: Number(row.contact_count) })),
    pagination: page,
  };
}

export function listMentionOptions(
  db: Database.Database,
  options: { search?: unknown; limit?: unknown } = {}
): ContactOption[] {
  const search = normalizeSearch(options.search).slice(0, 40);
  const limit = boundedInteger(options.limit, 8, MAX_MENTION_OPTIONS);
  const filter = searchCondition(search, ['contacts.name', 'contacts.nickname']);
  const where = filter.sql ? `WHERE ${filter.sql}` : '';
  const rows = db.prepare(`
    SELECT id, name, email
    FROM contacts
    ${where}
    ORDER BY name COLLATE NOCASE, id
    LIMIT ?
  `).all(...filter.params, limit) as Array<Omit<ContactOption, 'photo_url'>>;
  return rows.map((row) => ({ ...row, photo_url: null }));
}

export function listTagContacts(
  db: Database.Database,
  options: {
    tag: unknown;
    membership?: 'members' | 'available';
    search?: unknown;
    page?: unknown;
    pageSize?: unknown;
  }
): { contacts: TagDirectoryContact[]; pagination: Pagination } {
  const tag = normalizeTag(options.tag);
  const membership = options.membership === 'available' ? 'available' : 'members';
  const search = normalizeSearch(options.search);
  const conditions = [membership === 'available' ? `NOT ${TAG_MEMBERSHIP_SQL}` : TAG_MEMBERSHIP_SQL];
  const params = [tag];
  const filter = searchCondition(search, ['contacts.name', 'contacts.email']);
  if (filter.sql) {
    conditions.push(filter.sql);
    params.push(...filter.params);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = Number((db.prepare(`SELECT COUNT(*) AS count FROM contacts ${where}`)
    .get(...params) as { count: number }).count);
  const page = pagination(total, options.page, options.pageSize, {
    pageSize: DEFAULT_GROUP_PAGE_SIZE,
    maximumPageSize: MAX_CONTACT_PAGE_SIZE,
  });
  const contacts = db.prepare(`
    SELECT id, name, email
    FROM contacts
    ${where}
    ORDER BY name COLLATE NOCASE, id
    LIMIT ? OFFSET ?
  `).all(...params, page.pageSize, (page.page - 1) * page.pageSize) as TagDirectoryContact[];

  return { contacts, pagination: page };
}

export function addTagToContacts(
  db: Database.Database,
  tagValue: unknown,
  contactIdsValue: unknown
): number {
  return updateTagMembership(db, tagValue, contactIdsValue, 'add');
}

export function updateTagMembership(
  db: Database.Database,
  tagValue: unknown,
  contactIdsValue: unknown,
  operation: 'add' | 'remove'
): number {
  const tag = normalizeTag(tagValue);
  if (!Array.isArray(contactIdsValue)) {
    throw new ContactDirectoryError('Choose at least one contact.');
  }
  const parsedIds = contactIdsValue.map(Number);
  if (parsedIds.some((id) => !Number.isInteger(id) || id < 1)) {
    throw new ContactDirectoryError('Choose only valid contacts.');
  }
  const contactIds = Array.from(new Set(parsedIds));
  if (contactIds.length === 0) throw new ContactDirectoryError('Choose at least one contact.');
  if (contactIds.length > MAX_BULK_TAG_CONTACTS) {
    throw new ContactDirectoryError(`Choose at most ${MAX_BULK_TAG_CONTACTS} contacts at a time.`);
  }

  const mutation = db.transaction(() => {
    const placeholders = contactIds.map(() => '?').join(', ');
    const contacts = db.prepare(`SELECT id, tags FROM contacts WHERE id IN (${placeholders})`)
      .all(...contactIds) as Array<{ id: number; tags: string | null }>;
    if (contacts.length !== contactIds.length) {
      throw new ContactDirectoryError('One or more selected contacts no longer exist. Refresh and try again.');
    }
    const update = db.prepare(
      'UPDATE contacts SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    );
    const changes = contacts.flatMap((contact) => {
      const tags = parseStoredTags(contact.tags);
      const existingIndex = tags.findIndex((existing) => existing.toLowerCase() === tag.toLowerCase());
      if (operation === 'add') {
        if (existingIndex >= 0) return [];
        if (tags.length >= MAX_TAGS_PER_CONTACT) {
          throw new ContactDirectoryError(
            `${contactIds.length === 1 ? 'The contact has' : 'A selected contact has'} the maximum of ${MAX_TAGS_PER_CONTACT} tags.`
          );
        }
        return [{ id: contact.id, tags: [...tags, tag] }];
      }
      if (existingIndex < 0) return [];
      return [{ id: contact.id, tags: tags.filter((_, index) => index !== existingIndex) }];
    });

    let affected = 0;
    for (const change of changes) {
      affected += update.run(serializeTagList(change.tags), change.id).changes;
    }
    return affected;
  });
  return mutation.immediate();
}
