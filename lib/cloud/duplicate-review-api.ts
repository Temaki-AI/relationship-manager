import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { DuplicateContact, DuplicateIdentity } from '@/lib/contact-merge';
import { DEFAULT_DUPLICATE_GROUP_PAGE_SIZE, MAX_DUPLICATE_BATCH_CONTACTS } from '@/lib/duplicate-review';

const SCAN_PAGE_SIZE = 500;
const MAX_DETAIL_CONTACTS = DEFAULT_DUPLICATE_GROUP_PAGE_SIZE * MAX_DUPLICATE_BATCH_CONTACTS;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

const COMPLETENESS_SQL = `(c.email IS NOT NULL AND trim(c.email) <> '')
  + (c.nickname IS NOT NULL AND trim(c.nickname) <> '')
  + (c.phone IS NOT NULL AND trim(c.phone) <> '')
  + (c.photo_url IS NOT NULL AND trim(c.photo_url) <> '')
  + (c.birthday IS NOT NULL AND trim(c.birthday) <> '')
  + (c.how_we_met IS NOT NULL AND trim(c.how_we_met) <> '')
  + (c.notes IS NOT NULL AND trim(c.notes) <> '')
  + (c.gift_ideas IS NOT NULL AND trim(c.gift_ideas) <> '')
  + (c.custom_fields IS NOT NULL AND trim(c.custom_fields) <> '')
  + (c.last_contacted IS NOT NULL AND trim(c.last_contacted) <> '')`;

const ACTIVITY_SQL = `(SELECT COUNT(*) FROM interactions i WHERE i.workspace_id = c.workspace_id AND i.contact_id = c.id)
  + (SELECT COUNT(*) FROM reminders r WHERE r.workspace_id = c.workspace_id AND r.contact_id = c.id)
  + (SELECT COUNT(*) FROM relationship_facts f WHERE f.workspace_id = c.workspace_id AND f.contact_id = c.id)
  + (SELECT COUNT(*) FROM plans p WHERE p.workspace_id = c.workspace_id AND p.contact_id = c.id)
  + (SELECT COUNT(*) FROM contact_group_members gm WHERE gm.workspace_id = c.workspace_id AND gm.contact_id = c.id)`;

const IDENTITY_SQL = `SELECT c.id, c.name, c.email, c.phone, c.birthday,
  CASE WHEN json_valid(c.custom_fields) THEN json_object('vcard', json_object(
    'additional_emails', json_extract(c.custom_fields, '$.vcard.additional_emails'),
    'additional_phones', json_extract(c.custom_fields, '$.vcard.additional_phones')))
    ELSE NULL END AS custom_fields,
  c.created_at, 100 * (${ACTIVITY_SQL}) + ${COMPLETENESS_SQL} AS quality_score
  FROM contacts c WHERE c.workspace_id = ? AND c.id > ? ORDER BY c.id LIMIT ?`;

const DETAILS_SQL = `SELECT c.id, c.name, c.nickname, c.email, c.phone,
  CASE WHEN c.photo_url LIKE 'data:image/%' THEN '/api/contacts/' || c.id || '/photo' ELSE NULL END AS photo_url,
  c.birthday, c.birthday_reminder_days, NULL AS how_we_met, c.tags, NULL AS notes,
  NULL AS gift_ideas,
  CASE WHEN json_valid(c.custom_fields) THEN json_object('vcard', json_object(
    'additional_emails', json_extract(c.custom_fields, '$.vcard.additional_emails'),
    'additional_phones', json_extract(c.custom_fields, '$.vcard.additional_phones')))
    ELSE NULL END AS custom_fields,
  c.last_contacted, c.contact_frequency, c.created_at, c.updated_at,
  (SELECT COUNT(*) FROM interactions i WHERE i.workspace_id = c.workspace_id AND i.contact_id = c.id) AS interaction_count,
  (SELECT COUNT(*) FROM reminders r WHERE r.workspace_id = c.workspace_id AND r.contact_id = c.id) AS reminder_count,
  (SELECT COUNT(*) FROM relationship_facts f WHERE f.workspace_id = c.workspace_id AND f.contact_id = c.id) AS fact_count,
  (SELECT COUNT(*) FROM plans p WHERE p.workspace_id = c.workspace_id AND p.contact_id = c.id) AS plan_count,
  (SELECT COUNT(*) FROM contact_group_members gm WHERE gm.workspace_id = c.workspace_id AND gm.contact_id = c.id) AS group_count,
  ${COMPLETENESS_SQL} AS completeness_count
  FROM contacts c WHERE c.workspace_id = ? AND c.id IN (SELECT value FROM json_each(?)) ORDER BY c.id`;

function nonnegativeInteger(value: string | null): number | null {
  if (value === null || !/^(0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function handleCloudDuplicateReview(request: Request, workspaceId: string): Promise<Response> {
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: NO_STORE });
  const url = new URL(request.url);
  const details = url.searchParams.get('ids');
  if (details !== null) {
    const expectedRevision = nonnegativeInteger(url.searchParams.get('revision'));
    const ids = details.split(',').map((value) => nonnegativeInteger(value));
    if (expectedRevision === null || ids.length < 1 || ids.length > MAX_DETAIL_CONTACTS
      || ids.some((id) => id === null || id < 1) || new Set(ids).size !== ids.length) {
      return Response.json({ error: 'Invalid duplicate detail request. Refresh the review.' }, { status: 400, headers: NO_STORE });
    }
    const { DB } = getCloudflareContext().env;
    const [workspace, result] = await DB.batch([
      DB.prepare('SELECT recovery_revision FROM workspaces WHERE id = ?').bind(workspaceId),
      DB.prepare(DETAILS_SQL).bind(workspaceId, JSON.stringify(ids)),
    ]);
    const revision = (workspace.results[0] as { recovery_revision: number } | undefined)?.recovery_revision;
    if (revision === undefined) return Response.json({ error: 'Workspace not found.' }, { status: 404, headers: NO_STORE });
    if (revision !== expectedRevision || result.results.length !== ids.length) {
      return Response.json({ error: 'Your people changed during the scan. Refresh to review current matches.' },
        { status: 409, headers: NO_STORE });
    }
    return Response.json({ contacts: result.results as DuplicateContact[], revision }, { headers: NO_STORE });
  }
  const after = url.searchParams.has('after') ? nonnegativeInteger(url.searchParams.get('after')) : 0;
  const expectedRevision = url.searchParams.has('revision') ? nonnegativeInteger(url.searchParams.get('revision')) : null;
  if (after === null || (after > 0 && expectedRevision === null)) {
    return Response.json({ error: 'Invalid duplicate scan cursor. Start again.' }, { status: 400, headers: NO_STORE });
  }

  const { DB } = getCloudflareContext().env;
  const [workspace, page] = await DB.batch([
    DB.prepare('SELECT recovery_revision, (SELECT COUNT(*) FROM contacts WHERE workspace_id = ?) AS total FROM workspaces WHERE id = ?')
      .bind(workspaceId, workspaceId),
    DB.prepare(IDENTITY_SQL)
      .bind(workspaceId, after, SCAN_PAGE_SIZE + 1),
  ]);
  const state = workspace.results[0] as { recovery_revision: number; total: number } | undefined;
  if (!state) return Response.json({ error: 'Workspace not found.' }, { status: 404, headers: NO_STORE });
  if (expectedRevision !== null && state.recovery_revision !== expectedRevision) {
    return Response.json({ error: 'Your people changed during the scan. Refresh to review current matches.' },
      { status: 409, headers: NO_STORE });
  }
  const rows = page.results as DuplicateIdentity[];
  const contacts = rows.slice(0, SCAN_PAGE_SIZE);
  const nextCursor = rows.length > SCAN_PAGE_SIZE ? contacts.at(-1)!.id : null;
  return Response.json({ contacts, nextCursor, total: state.total, revision: state.recovery_revision },
    { headers: NO_STORE });
}
