import { ContactConnectionInputError, normalizeChildInput, normalizeRelationshipLabels, validateChildLink } from '@/lib/contact-connections';
import { DIRECTORY_CONTACT_COLUMNS } from '@/lib/contact-directory-projection';
import { embeddedContactPhotoResponse } from '@/lib/contact-photo-response';
import { ContactInputError, normalizeContactCreateInput, normalizeContactPatchInput } from '@/lib/contact-input';
import { ContactRevisionError, EDITABLE_CONTACT_FIELDS, getContactEditRevision, getExpectedContactRevision } from '@/lib/contact-revision';
import type { Contact, Interaction, Reminder, RelationshipFact } from '@/lib/db';
import { buildRelationshipBriefFromActivity, buildTimeline } from '@/lib/intelligence';
import { timelineCTE, parseTimelineKindFilter, DEFAULT_INTERACTION_PAGE_SIZE, DEFAULT_REMINDER_HISTORY_PAGE_SIZE, DEFAULT_FACT_PAGE_SIZE, DEFAULT_PLAN_PAGE_SIZE, DEFAULT_TIMELINE_PAGE_SIZE } from '@/lib/contact-history';
import { normalizeTimeZone } from '@/lib/civil-date';
import { withInteractionEditRevision } from '@/lib/interaction-revision';
import { IdempotencyError } from '@/lib/idempotency';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { createCloudResource } from '@/lib/cloud/idempotency';
import { readCloudObject } from '@/lib/cloud/request';
import { deleteCloudContactsWithRecovery } from '@/lib/cloud/recovery-storage';
import { recoveryErrorResponse } from '@/lib/cloud/recovery-contract';
import { parsePositiveInteger } from '@/lib/relationship-validation';
import { MAX_TAGS_PER_CONTACT, normalizeTag, TagValidationError } from '@/lib/tag-validation';
import { getCloudflareContext } from '@opennextjs/cloudflare';

type ContactRow = Contact & { workspace_id: string };

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, { status, headers });
}

function boundedInteger(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function pagination(url: URL, total: number, defaultSize = 20) {
  const pageSize = boundedInteger(url.searchParams.get('pageSize'), defaultSize, 100);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(boundedInteger(url.searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER), totalPages);
  return { page, pageSize, total, totalPages, offset: (page - 1) * pageSize };
}

function paginationResponse(value: ReturnType<typeof pagination>) {
  return {
    page: value.page,
    pageSize: value.pageSize,
    total: value.total,
    totalPages: value.totalPages,
  };
}

async function contactExists(db: CloudflareEnv['DB'], workspaceId: string, contactId: number) {
  return Boolean(await db.prepare('SELECT 1 FROM contacts WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, contactId).first());
}

async function listRelationships(db: CloudflareEnv['DB'], workspaceId: string, contactId: number, url: URL) {
  const count = await db.prepare(`
    SELECT COUNT(*) AS total FROM contact_relationships
    WHERE workspace_id = ? AND (contact_id = ? OR related_contact_id = ?)
  `).bind(workspaceId, contactId, contactId).first<{ total: number }>();
  const paging = pagination(url, Number(count?.total || 0));
  const result = await db.prepare(`
    SELECT relationship.id, related.id AS related_contact_id, related.name AS related_name,
      related.nickname AS related_nickname,
      CASE WHEN relationship.contact_id = ? THEN relationship.relationship_label ELSE relationship.reciprocal_label END AS relationship_label,
      CASE WHEN relationship.contact_id = ? THEN relationship.reciprocal_label ELSE relationship.relationship_label END AS reciprocal_label,
      relationship.created_at
    FROM contact_relationships relationship
    JOIN contacts related ON related.workspace_id = relationship.workspace_id
      AND related.id = CASE WHEN relationship.contact_id = ? THEN relationship.related_contact_id ELSE relationship.contact_id END
    WHERE relationship.workspace_id = ? AND (relationship.contact_id = ? OR relationship.related_contact_id = ?)
    ORDER BY related.name COLLATE NOCASE, related.id, relationship.id LIMIT ? OFFSET ?
  `).bind(contactId, contactId, contactId, workspaceId, contactId, contactId, paging.pageSize, paging.offset).all();
  return { relationships: result.results, pagination: paginationResponse(paging) };
}

async function listChildren(db: CloudflareEnv['DB'], workspaceId: string, contactId: number, url: URL) {
  const count = await db.prepare(`
    SELECT COUNT(*) AS total FROM contact_children WHERE workspace_id = ? AND contact_id = ?
  `).bind(workspaceId, contactId).first<{ total: number }>();
  const paging = pagination(url, Number(count?.total || 0));
  const result = await db.prepare(`
    SELECT child.id, child.contact_id, child.linked_contact_id, child.name, child.birthday,
      child.created_at, child.updated_at, linked.name AS linked_name, linked.birthday AS linked_birthday
    FROM contact_children child
    LEFT JOIN contacts linked ON linked.id = child.linked_contact_id AND linked.workspace_id = child.workspace_id
    WHERE child.workspace_id = ? AND child.contact_id = ?
    ORDER BY COALESCE(linked.name, child.name) COLLATE NOCASE, child.id LIMIT ? OFFSET ?
  `).bind(workspaceId, contactId, paging.pageSize, paging.offset).all();
  return { children: result.results, pagination: paginationResponse(paging) };
}

async function listHistory(db: CloudflareEnv['DB'], workspaceId: string, contactId: number, table: string, url: URL) {
  const allowed = new Map([
    ['interactions', { order: 'date DESC, id DESC', pageSize: DEFAULT_INTERACTION_PAGE_SIZE }],
    ['reminders', { order: 'julianday(remind_at), id', pageSize: DEFAULT_REMINDER_HISTORY_PAGE_SIZE }],
    ['relationship_facts', { order: 'julianday(COALESCE(last_verified_at, created_at)) DESC, id DESC', pageSize: DEFAULT_FACT_PAGE_SIZE }],
    ['plans', { order: 'planned_date, id', pageSize: DEFAULT_PLAN_PAGE_SIZE }],
  ]);
  const config = allowed.get(table);
  if (!config) throw new Error('Unsupported history table.');
  const where = `workspace_id = ? AND contact_id = ?${table === 'reminders' || table === 'plans' ? ' AND completed_at IS NULL' : ''}`;
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`)
    .bind(workspaceId, contactId).first<{ total: number }>();
  const paging = pagination(url, Number(count?.total || 0), config.pageSize);
  const result = await db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${config.order} LIMIT ? OFFSET ?`)
    .bind(workspaceId, contactId, paging.pageSize, paging.offset).all();
  return {
    results: table === 'interactions' ? (result.results as Interaction[]).map(withInteractionEditRevision) : result.results,
    pagination: paginationResponse(paging),
  };
}

async function listTimeline(db: CloudflareEnv['DB'], workspaceId: string, contact: Contact, url: URL) {
  const cte = timelineCTE(true);
  const values = [JSON.stringify(buildTimeline(contact, [], [], [])), contact.id, workspaceId, contact.id, workspaceId, contact.id, workspaceId];
  const rawKind = url.searchParams.get('kind');
  const kind = parseTimelineKindFilter(rawKind);
  const where = `date IS NOT NULL AND date <> ''${kind ? ' AND kind = ?' : ''}`;
  const parameters = kind ? [...values, kind] : values;
  const count = await db.prepare(`${cte} SELECT COUNT(*) AS total FROM timeline WHERE ${where}`).bind(...parameters).first<{ total: number }>();
  const paging = pagination(url, Number(count?.total || 0), DEFAULT_TIMELINE_PAGE_SIZE);
  const result = await db.prepare(`${cte} SELECT id, kind, title, summary, date, tone FROM timeline WHERE ${where}
    ORDER BY julianday(date) DESC, id DESC LIMIT ? OFFSET ?`).bind(...parameters, paging.pageSize, paging.offset).all();
  return { timeline: result.results, pagination: paginationResponse(paging) };
}

async function listContacts(request: Request, workspaceId: string) {
  const db = getCloudflareContext().env.DB;
  const url = new URL(request.url);
  const view = url.searchParams.get('view') || 'page';
  const search = (url.searchParams.get('search') || '').trim().slice(0, 200);

  if (view === 'mentions') {
    const limit = boundedInteger(url.searchParams.get('limit'), 20, 100);
    const result = await db.prepare(`
      SELECT id, name, nickname FROM contacts WHERE workspace_id = ?
        AND (? = '' OR instr(lower(name), lower(?)) > 0 OR instr(lower(COALESCE(nickname, '')), lower(?)) > 0)
      ORDER BY name COLLATE NOCASE, id LIMIT ?
    `).bind(workspaceId, search, search, search, limit).all();
    return json({ contacts: result.results });
  }
  if (view === 'tags') return tagSummaries(db, workspaceId, url);

  const clauses = ['workspace_id = ?'];
  const values: unknown[] = [workspaceId];
  if (search) {
    const fields = ['name', 'nickname', 'email', 'phone', 'notes', 'how_we_met'];
    // instr treats %, _, and backslashes literally, without D1's LIKE-pattern byte limit.
    clauses.push(`(${fields.map((field) => `instr(lower(COALESCE(${field}, '')), lower(?)) > 0`).join(' OR ')}
      OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(custom_fields) THEN custom_fields ELSE '{}' END)
        WHERE type = 'text' AND instr(lower(CAST(atom AS TEXT)), lower(?)) > 0)
      OR EXISTS (SELECT 1 FROM json_each(contact_methods) WHERE instr(lower(json_extract(value, '$.value')), lower(?)) > 0
        OR instr(lower(COALESCE(json_extract(value, '$.label'), '')), lower(?)) > 0))`);
    values.push(...fields.map(() => search), search, search, search);
  }
  const rawTag = url.searchParams.get('tag');
  if (rawTag?.trim()) {
    let tag: string;
    try { tag = normalizeTag(rawTag); } catch { return json({ error: 'Invalid tag filter.' }, 400); }
    clauses.push(`EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags) THEN CASE WHEN json_type(tags) = 'array' THEN tags ELSE '[]' END ELSE '[]' END)
      WHERE type = 'text' AND lower(trim(value)) = lower(?))`);
    values.push(tag);
  }
  const where = clauses.join(' AND ');
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM contacts WHERE ${where}`).bind(...values).first<{ total: number }>();
  const paging = pagination(url, Number(count?.total || 0), 50);
  const result = await db.prepare(`
    SELECT ${DIRECTORY_CONTACT_COLUMNS} FROM contacts WHERE ${where}
    ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?
  `).bind(...values, paging.pageSize, paging.offset).all();
  const overall = await db.prepare('SELECT COUNT(*) AS total FROM contacts WHERE workspace_id = ?')
    .bind(workspaceId).first<{ total: number }>();
  return json({ contacts: result.results, pagination: paginationResponse(paging), overallTotal: Number(overall?.total || 0) });
}

const VALID_TAGS_SQL = `CASE WHEN json_valid(contacts.tags) THEN
  CASE WHEN json_type(contacts.tags) = 'array' THEN contacts.tags ELSE '[]' END
  ELSE '[]' END`;

const TAG_MEMBERSHIP_SQL = `EXISTS (SELECT 1 FROM json_each(${VALID_TAGS_SQL}) AS member_tags
  WHERE member_tags.type = 'text' AND lower(trim(member_tags.value)) = lower(?))`;

async function tagSummaries(db: CloudflareEnv['DB'], workspaceId: string, url: URL) {
  const from = `FROM contacts JOIN json_each(${VALID_TAGS_SQL}) AS tag_values
    WHERE contacts.workspace_id = ? AND tag_values.type = 'text' AND trim(tag_values.value) <> ''`;
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM (
    SELECT 1 ${from} GROUP BY lower(trim(tag_values.value)))`)
    .bind(workspaceId).first<{ total: number }>();
  const paging = pagination(url, Number(count?.total || 0), 100);
  const result = await db.prepare(`SELECT MIN(trim(tag_values.value)) AS tag,
      COUNT(DISTINCT contacts.id) AS contactCount ${from}
    GROUP BY lower(trim(tag_values.value))
    ORDER BY contactCount DESC, tag COLLATE NOCASE LIMIT ? OFFSET ?`)
    .bind(workspaceId, paging.pageSize, paging.offset).all<{ tag: string; contactCount: number }>();
  return json({ tags: result.results, pagination: paginationResponse(paging) });
}

async function mutateTags(db: CloudflareEnv['DB'], workspaceId: string, ids: number[], tagValue: unknown, operation: 'add' | 'remove') {
  const tag = normalizeTag(tagValue);
  const selection = JSON.stringify(ids);
  const validTags = "CASE WHEN json_valid(tags) THEN CASE WHEN json_type(tags) = 'array' THEN tags ELSE '[]' END ELSE '[]' END";
  const matching = `EXISTS (SELECT 1 FROM json_each(${validTags}) WHERE type = 'text' AND lower(trim(value)) = lower(?))`;
  const nextTags = operation === 'add' ? `json_insert(${validTags}, '$[#]', ?)`
    : `(SELECT json_group_array(value) FROM json_each(${validTags}) WHERE type = 'text' AND lower(trim(value)) <> lower(?))`;
  const owned = 'SELECT COUNT(*) AS total FROM contacts WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))';
  const capacity = `SELECT COUNT(*) AS total FROM contacts WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))
    AND json_array_length(${validTags}) >= ? AND NOT ${matching}`;
  const capacityValues = [workspaceId, selection, MAX_TAGS_PER_CONTACT, tag];
  // Compute from the current row in SQL so concurrent additions cannot replace
  // each other. One JSON binding supports the full 500-person selection.
  const [count, blocked, update] = await db.batch([
    db.prepare(owned).bind(workspaceId, selection),
    operation === 'add' ? db.prepare(capacity).bind(...capacityValues) : db.prepare('SELECT 0 AS total'),
    db.prepare(`UPDATE contacts SET tags = ${nextTags}, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))
      AND (${owned}) = ? ${operation === 'add' ? `AND (${capacity}) = 0` : ''}
      AND ${operation === 'add' ? 'NOT ' : ''}${matching} RETURNING id`)
      .bind(tag, workspaceId, selection, workspaceId, selection, ids.length, ...(operation === 'add' ? capacityValues : []), tag),
  ]);
  if (Number((blocked.results[0] as { total: number }).total)) throw new TagValidationError(`A selected contact has the maximum of ${MAX_TAGS_PER_CONTACT} tags.`);
  return Number((count.results[0] as { total: number }).total) === ids.length ? update.results.length : null;
}

async function bulkContacts(request: Request, workspaceId: string) {
  const db = getCloudflareContext().env.DB;
  const body = await readCloudObject(request);
  if (!Array.isArray(body.contactIds)) return json({ error: 'Select at least one contact' }, 400);
  const ids = [...new Set(body.contactIds.map(Number))];
  if (!ids.length || ids.some((id) => !Number.isInteger(id) || id < 1) || ids.length > 500) return json({ error: 'Choose only valid contacts' }, 400);
  const operation = String(body.operation || '');
  if (operation === 'delete') {
    return json({ operation, ...await deleteCloudContactsWithRecovery(workspaceId, ids) });
  }
  if (operation === 'add_tag' || operation === 'remove_tag') {
    const affected = await mutateTags(db, workspaceId, ids, body.tag, operation === 'add_tag' ? 'add' : 'remove');
    return affected === null ? json({ error: 'One or more selected contacts no longer exist' }, 404) : json({ operation, affected });
  }
  return json({ error: 'Unsupported bulk operation' }, 400);
}

export async function handleCloudTagGroups(request: Request, workspaceId: string, path: string[]) {
  const db = getCloudflareContext().env.DB;
  try {
    if (path.length === 2) return tagSummaries(db, workspaceId, new URL(request.url));
    const url = new URL(request.url);
    if (request.method === 'GET') {
      const tag = normalizeTag(url.searchParams.get('tag'));
      const membership = url.searchParams.get('membership') === 'available' ? 'available' : 'members';
      const search = (url.searchParams.get('search') || '').trim().slice(0, 200);
      const where = `workspace_id = ? AND ${membership === 'members' ? '' : 'NOT '}${TAG_MEMBERSHIP_SQL}
        AND (? = '' OR instr(lower(name), lower(?)) > 0 OR instr(lower(COALESCE(email, '')), lower(?)) > 0)`;
      const values = [workspaceId, tag, search, search, search];
      const count = await db.prepare(`SELECT COUNT(*) AS total FROM contacts WHERE ${where}`)
        .bind(...values).first<{ total: number }>();
      const paging = pagination(url, Number(count?.total || 0));
      const result = await db.prepare(`SELECT id, name, email FROM contacts WHERE ${where}
        ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?`)
        .bind(...values, paging.pageSize, paging.offset).all<{ id: number; name: string; email: string | null }>();
      return json({
        contacts: result.results,
        pagination: paginationResponse(paging),
      });
    }
    const body = await readCloudObject(request);
    if (!Array.isArray(body.contactIds)) return json({ error: 'Choose at least one contact.' }, 400);
    const ids = [...new Set(body.contactIds.map(Number))];
    if (!ids.length || ids.length > 500 || ids.some((id) => !Number.isInteger(id) || id < 1)) return json({ error: 'Choose between 1 and 500 valid contacts.' }, 400);
    const affected = await mutateTags(db, workspaceId, ids, body.tag, 'add');
    return affected === null ? json({ error: 'One or more selected contacts no longer exist.' }, 404) : json({ affected });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Tag operation failed.' }, 400);
  }
}

async function createContact(request: Request, workspaceId: string) {
  const db = getCloudflareContext().env.DB;
  const input = normalizeContactCreateInput(await readJsonBody(request));
  const result = await createCloudResource<ContactRow>(db, request, workspaceId, 'contacts', input);
  return json({ contact: result.resource }, 201, { 'Idempotency-Replayed': String(result.replayed) });
}

async function contactDetail(request: Request, workspaceId: string, contactId: number) {
  const db = getCloudflareContext().env.DB;
  const url = new URL(request.url);
  const contact = await db.prepare('SELECT * FROM contacts WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, contactId).first<ContactRow>();
  if (!contact) return json({ error: 'Contact not found' }, 404);
  const view = url.searchParams.get('view') || '';
  if (view === 'timeline') {
    const rawKind = url.searchParams.get('kind');
    if (rawKind && !parseTimelineKindFilter(rawKind)) return json({ error: 'Unknown activity filter.' }, 400);
    return json(await listTimeline(db, workspaceId, contact, url));
  }
  if (view === 'interactions' || view === 'reminders' || view === 'facts' || view === 'plans') {
    const table = view === 'facts' ? 'relationship_facts' : view;
    const history = await listHistory(db, workspaceId, contactId, table, url);
    return json({ [view]: history.results, pagination: history.pagination });
  }
  if (view) return json({ error: 'Unknown contact history view.' }, 400);

  const initialUrl = new URL(url);
  initialUrl.searchParams.delete('page');
  const [interactions, reminders, facts, plans, relationships, children, timeline] = await Promise.all([
    listHistory(db, workspaceId, contactId, 'interactions', initialUrl),
    listHistory(db, workspaceId, contactId, 'reminders', initialUrl),
    listHistory(db, workspaceId, contactId, 'relationship_facts', initialUrl),
    listHistory(db, workspaceId, contactId, 'plans', initialUrl),
    listRelationships(db, workspaceId, contactId, url),
    listChildren(db, workspaceId, contactId, url),
    listTimeline(db, workspaceId, contact, initialUrl),
  ]);
  return json({
    contact: { ...contact, edit_revision: getContactEditRevision(contact) },
    interactions: interactions.results,
    reminders: reminders.results,
    facts: facts.results,
    plans: plans.results,
    relationships: relationships.relationships,
    children: children.children,
    brief: buildRelationshipBriefFromActivity(contact, {
      contactId, interactionsCount: interactions.pagination.total,
      latestInteraction: (interactions.results as Interaction[])[0] ?? null,
      openReminders: reminders.results as Reminder[],
    }, facts.results as RelationshipFact[], new Date(), normalizeTimeZone(url.searchParams.get('timeZone'))),
    timeline: timeline.timeline,
    history: { interactions: interactions.pagination, reminders: reminders.pagination, facts: facts.pagination, plans: plans.pagination, timeline: timeline.pagination },
    connections: { relationships: relationships.pagination, children: children.pagination },
  });
}

async function contactPhoto(workspaceId: string, contactId: number) {
  const db = getCloudflareContext().env.DB;
  const row = await db.prepare('SELECT photo_url FROM contacts WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, contactId).first<{ photo_url: string | null }>();
  return embeddedContactPhotoResponse(row?.photo_url) || new Response(null, { status: 404 });
}

async function updateContact(request: Request, workspaceId: string, contactId: number) {
  const db = getCloudflareContext().env.DB;
  const body = await readCloudObject(request);
  const expectedRevision = getExpectedContactRevision(body);
  const current = await db.prepare('SELECT * FROM contacts WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, contactId).first<ContactRow>();
  if (!current) return json({ error: 'Contact not found' }, 404);
  const fields = normalizeContactPatchInput(body, current.contact_methods);
  if (Object.keys(fields).length === 0) return json({ error: 'No supported fields to update' }, 400);
  const revision = getContactEditRevision(current);
  if (expectedRevision !== revision) {
    return json({ error: 'This contact changed after you opened it. Your draft has not been saved.', current_edit_revision: revision }, 409);
  }
  const keys = Object.keys(fields);
  const values = Object.values(fields);
  // Match the complete revision snapshot inside the write, not just in the read
  // above. IS provides null-safe comparisons and also catches history/tag edits.
  const contact = await db.prepare(`UPDATE contacts SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ?
    WHERE workspace_id = ? AND id = ? AND ${EDITABLE_CONTACT_FIELDS.map((field) => `${field} IS ?`).join(' AND ')} RETURNING *`)
    .bind(...values, new Date().toISOString(), workspaceId, contactId, ...EDITABLE_CONTACT_FIELDS.map((field) => current[field]))
    .first<ContactRow>();
  if (!contact) {
    const latest = await db.prepare('SELECT * FROM contacts WHERE workspace_id = ? AND id = ?').bind(workspaceId, contactId).first<ContactRow>();
    return latest ? json({ error: 'This contact changed after you opened it. Your draft has not been saved.', current_edit_revision: getContactEditRevision(latest) }, 409)
      : json({ error: 'Contact not found' }, 404);
  }
  return json({ contact: { ...contact, edit_revision: getContactEditRevision(contact) } });
}

async function deleteContact(workspaceId: string, contactId: number) {
  const result = await deleteCloudContactsWithRecovery(workspaceId, [contactId]);
  return json({ success: true, ...result, alreadyDeleted: result.affected === 0 });
}

async function children(request: Request, workspaceId: string, contactId: number, childId?: number) {
  const db = getCloudflareContext().env.DB;
  if (request.method === 'DELETE' && childId) {
    const result = await db.prepare('DELETE FROM contact_children WHERE workspace_id = ? AND contact_id = ? AND id = ?')
      .bind(workspaceId, contactId, childId).run();
    return json({ success: true, alreadyDeleted: result.meta.changes === 0 });
  }
  if (!await contactExists(db, workspaceId, contactId)) return json({ error: 'Contact not found' }, 404);
  if (request.method === 'PATCH' && childId) {
    const body = await readCloudObject(request);
    const input = normalizeChildInput(body);
    if (typeof body.expected_updated_at !== 'string' || !body.expected_updated_at) return json({ error: 'Refresh this child entry before editing.' }, 400);
    const current = await db.prepare('SELECT name, birthday, linked_contact_id, updated_at FROM contact_children WHERE workspace_id = ? AND contact_id = ? AND id = ?')
      .bind(workspaceId, contactId, childId).first<{ name: string; birthday: string | null; linked_contact_id: number | null; updated_at: string }>();
    if (!current) return json({ error: 'Child not found' }, 404);
    if (current.updated_at !== body.expected_updated_at) return json({ error: 'This child entry changed after you opened it. Your draft was not saved.' }, 409);
    if (input.linked_contact_id !== null) {
      const linked = await db.prepare('SELECT birthday FROM contacts WHERE workspace_id = ? AND id = ?')
        .bind(workspaceId, input.linked_contact_id).first<{ birthday: string | null }>();
      if (!linked) return json({ error: 'Linked profile not found.' }, 404);
      if (current.linked_contact_id !== input.linked_contact_id) {
        validateChildLink(contactId, input.birthday, input.linked_contact_id, linked.birthday);
      }
    }
    const child = await db.prepare(`UPDATE contact_children SET name = ?, birthday = ?, linked_contact_id = ?, updated_at = ?
      WHERE workspace_id = ? AND contact_id = ? AND id = ? AND updated_at = ?
        AND name = ? AND birthday IS ? AND linked_contact_id IS ? RETURNING *`)
      .bind(input.name, input.birthday, input.linked_contact_id, new Date().toISOString(),
        workspaceId, contactId, childId, current.updated_at, current.name, current.birthday, current.linked_contact_id)
      .first();
    return child ? json({ child }) : json({ error: 'This child entry changed after you opened it. Your draft was not saved.' }, 409);
  }
  if (childId) return json({ error: 'Child operation not supported.' }, 405);
  if (request.method === 'GET') return json(await listChildren(db, workspaceId, contactId, new URL(request.url)));
  if (request.method !== 'POST') return json({ error: 'Child operation not supported.' }, 405);
  const input = normalizeChildInput(await readJsonBody(request));
  if (input.linked_contact_id !== null) {
    const linked = await db.prepare('SELECT birthday FROM contacts WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, input.linked_contact_id).first<{ birthday: string | null }>();
    if (!linked) return json({ error: 'Linked profile not found.' }, 404);
    validateChildLink(contactId, input.birthday, input.linked_contact_id, linked.birthday);
  }
  const result = await createCloudResource(db, request, workspaceId, 'contact_children', { contact_id: contactId, linked_contact_id: input.linked_contact_id, name: input.name, birthday: input.birthday });
  return json({ child: result.resource }, 201, { 'Idempotency-Replayed': String(result.replayed) });
}

async function relationships(request: Request, workspaceId: string, contactId: number, relationshipId?: number) {
  const db = getCloudflareContext().env.DB;
  if (request.method === 'DELETE' && relationshipId) {
    const result = await db.prepare(`DELETE FROM contact_relationships WHERE workspace_id = ? AND id = ? AND (contact_id = ? OR related_contact_id = ?)`)
      .bind(workspaceId, relationshipId, contactId, contactId).run();
    return json({ success: true, alreadyDeleted: result.meta.changes === 0 });
  }
  if (!await contactExists(db, workspaceId, contactId)) return json({ error: 'Contact not found' }, 404);
  if (request.method === 'GET') return json(await listRelationships(db, workspaceId, contactId, new URL(request.url)));
  const body = await readCloudObject(request);
  const relatedId = parsePositiveInteger(body.related_contact_id);
  if (!relatedId || relatedId === contactId) return json({ error: 'Choose a valid contact to connect.' }, 400);
  const labels = normalizeRelationshipLabels(body);
  if (!await contactExists(db, workspaceId, relatedId)) return json({ error: 'One of these contacts no longer exists.' }, 404);
  const result = await createCloudResource(db, request, workspaceId, 'contact_relationships', {
    contact_id: contactId, related_contact_id: relatedId,
    relationship_label: labels.relationshipLabel, reciprocal_label: labels.reciprocalLabel,
  });
  return json({ relationship: result.resource }, 201, { 'Idempotency-Replayed': String(result.replayed) });
}

export async function handleCloudContacts(request: Request, workspaceId: string, path: string[]) {
  try {
    if (path[1] === 'bulk' && request.method === 'POST') return await bulkContacts(request, workspaceId);
    if (path.length === 1) {
      if (request.method === 'GET') return await listContacts(request, workspaceId);
      if (request.method === 'POST') return await createContact(request, workspaceId);
    }
    const contactId = parsePositiveInteger(path[1]);
    if (!contactId) return json({ error: 'Contact not found' }, 404);
    if (path.length === 2) {
      if (request.method === 'GET') return await contactDetail(request, workspaceId, contactId);
      if (request.method === 'PATCH') return await updateContact(request, workspaceId, contactId);
      if (request.method === 'DELETE') return await deleteContact(workspaceId, contactId);
    }
    if (path.length === 3 && path[2] === 'photo' && request.method === 'GET') {
      return await contactPhoto(workspaceId, contactId);
    }
    if (path[2] === 'children') return await children(request, workspaceId, contactId, parsePositiveInteger(path[3]) || undefined);
    if (path[2] === 'relationships') return await relationships(request, workspaceId, contactId, parsePositiveInteger(path[3]) || undefined);
    return json({ error: 'Cloud contact endpoint not found.' }, 404);
  } catch (error) {
    if (String(error).includes('CONTACT_SYNC_LIMIT')) return json({ error: 'This person has reached the device-sync size limit. Shorten the profile or unlink an unused source before saving.', code: 'contact_capacity' }, 413);
    if (error instanceof Error && error.message.includes('CONTACT_RELATIONSHIP_EXISTS')) return json({ error: 'These contacts are already connected.' }, 409);
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: contact_children.workspace_id, contact_children.contact_id, contact_children.linked_contact_id')) {
      return json({ error: 'This child profile is already linked to this contact.' }, 409);
    }
    const recoveryError = recoveryErrorResponse(error);
    if (recoveryError) return recoveryError;
    if (error instanceof IdempotencyError || error instanceof RequestBodyError) return json({ error: error.message }, error.status);
    if (error instanceof ContactInputError || error instanceof ContactConnectionInputError || error instanceof ContactRevisionError || error instanceof TagValidationError || error instanceof SyntaxError) {
      return json({ error: error.message }, 400);
    }
    console.error('cloud.contacts.failed', error);
    return json({ error: 'Cloud contact operation failed.' }, 500);
  }
}
