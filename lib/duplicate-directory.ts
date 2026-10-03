import type Database from 'better-sqlite3';
import {
  findDuplicateContactGroups,
  type DuplicateContact,
} from './contact-merge.ts';
import { paginateDuplicateGroups, selectDuplicateBatch, MAX_DUPLICATE_BATCH_CONTACTS } from './duplicate-review.ts';
export { DEFAULT_DUPLICATE_GROUP_PAGE_SIZE, MAX_DUPLICATE_GROUP_PAGE_SIZE,
  MAX_DUPLICATE_BATCH_CONTACTS } from './duplicate-review.ts';

const RELATIONSHIP_COUNTS = `
  (SELECT COUNT(*) FROM interactions i WHERE i.contact_id = c.id) AS interaction_count,
  (SELECT COUNT(*) FROM reminders r WHERE r.contact_id = c.id) AS reminder_count,
  (SELECT COUNT(*) FROM relationship_facts f WHERE f.contact_id = c.id) AS fact_count,
  (SELECT COUNT(*) FROM plans p WHERE p.contact_id = c.id) AS plan_count,
  (SELECT COUNT(*) FROM contact_group_members gm WHERE gm.contact_id = c.id) AS group_count
`;

function loadDuplicateIdentities(db: Database.Database): DuplicateContact[] {
  return db.prepare(`
    SELECT
      c.id,
      c.name,
      c.nickname,
      c.email,
      c.phone,
      NULL AS photo_url,
      c.birthday,
      c.birthday_reminder_days,
      NULL AS how_we_met,
      NULL AS tags,
      NULL AS notes,
      NULL AS gift_ideas,
      CASE
        WHEN json_valid(c.custom_fields) THEN json_object(
          'vcard', json_object(
            'additional_emails', json_extract(c.custom_fields, '$.vcard.additional_emails'),
            'additional_phones', json_extract(c.custom_fields, '$.vcard.additional_phones')
          )
        )
        ELSE NULL
      END AS custom_fields,
      NULL AS last_contacted,
      c.contact_frequency,
      c.created_at,
      c.updated_at,
      ${RELATIONSHIP_COUNTS},
      (c.email IS NOT NULL AND trim(c.email) <> '')
        + (c.nickname IS NOT NULL AND trim(c.nickname) <> '')
        + (c.phone IS NOT NULL AND trim(c.phone) <> '')
        + (c.photo_url IS NOT NULL AND trim(c.photo_url) <> '')
        + (c.birthday IS NOT NULL AND trim(c.birthday) <> '')
        + (c.how_we_met IS NOT NULL AND trim(c.how_we_met) <> '')
        + (c.notes IS NOT NULL AND trim(c.notes) <> '')
        + (c.gift_ideas IS NOT NULL AND trim(c.gift_ideas) <> '')
        + (c.custom_fields IS NOT NULL AND trim(c.custom_fields) <> '')
        + (c.last_contacted IS NOT NULL AND trim(c.last_contacted) <> '')
        AS completeness_count
    FROM contacts c
    ORDER BY c.id
  `).all() as DuplicateContact[];
}

function loadHydratedContacts(
  db: Database.Database,
  ids: number[]
): Map<number, DuplicateContact> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const contacts = db.prepare(`
    SELECT c.*, ${RELATIONSHIP_COUNTS}
    FROM contacts c
    WHERE c.id IN (${placeholders})
  `).all(...ids) as DuplicateContact[];
  return new Map(contacts.map((contact) => [contact.id, contact]));
}

export function loadDuplicateReview(
  db: Database.Database,
  options: { page?: unknown; pageSize?: unknown } = {}
) {
  return db.transaction(() => {
    const allGroups = findDuplicateContactGroups(loadDuplicateIdentities(db));
    const { pageGroups, groupCount, contactCount, truncatedGroupCount, pagination } = paginateDuplicateGroups(allGroups, options);
    const batchIds = pageGroups.flatMap(selectDuplicateBatch);
    const hydrated = loadHydratedContacts(db, batchIds);
    const groups = pageGroups.map((group) => {
      const selectedIds = new Set(selectDuplicateBatch(group));
      return {
        ...group,
        contacts: group.contacts
          .filter((contact) => selectedIds.has(contact.id))
          .map((contact) => hydrated.get(contact.id))
          .filter((contact): contact is DuplicateContact => Boolean(contact)),
        totalContacts: group.contacts.length,
        hasMoreContacts: group.contacts.length > MAX_DUPLICATE_BATCH_CONTACTS,
      };
    });

    return {
      groups,
      groupCount,
      contactCount,
      truncatedGroupCount,
      pagination,
    };
  })();
}
