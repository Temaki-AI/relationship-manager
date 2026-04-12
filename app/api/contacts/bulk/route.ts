import { NextResponse } from 'next/server';
import db from '@/lib/db';

type BulkOperation = 'delete' | 'add_tag' | 'remove_tag' | 'add_to_group' | 'remove_from_group';

type ContactRow = {
  id: number;
  tags: string | null;
};

function parseContactIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
}

function parseTags(tagsString: string | null): string[] {
  if (!tagsString) {
    return [];
  }

  try {
    const parsed = JSON.parse(tagsString);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const operation = body.operation as BulkOperation;
    const contactIds = parseContactIds(body.contactIds);

    if (!operation) {
      return NextResponse.json({ error: 'Operation is required' }, { status: 400 });
    }

    if (contactIds.length === 0) {
      return NextResponse.json({ error: 'Select at least one contact' }, { status: 400 });
    }

    const placeholders = contactIds.map(() => '?').join(', ');
    const contacts = db
      .prepare(`SELECT id, tags FROM contacts WHERE id IN (${placeholders})`)
      .all(...contactIds) as ContactRow[];

    if (contacts.length === 0) {
      return NextResponse.json({ error: 'No matching contacts found' }, { status: 404 });
    }

    if (operation === 'delete') {
      const result = db
        .prepare(`DELETE FROM contacts WHERE id IN (${placeholders})`)
        .run(...contactIds);

      return NextResponse.json({
        operation,
        affected: result.changes,
      });
    }

    if (operation === 'add_tag' || operation === 'remove_tag') {
      const tag = typeof body.tag === 'string' ? body.tag.trim() : '';

      if (!tag) {
        return NextResponse.json({ error: 'Tag is required' }, { status: 400 });
      }

      const updateTags = db.prepare('UPDATE contacts SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');

      const affected = db.transaction(() => {
        let changed = 0;

        for (const contact of contacts) {
          const existingTags = parseTags(contact.tags);
          const nextTags = operation === 'add_tag'
            ? Array.from(new Set([...existingTags, tag]))
            : existingTags.filter((existingTag) => existingTag !== tag);

          const nextTagsString = nextTags.length > 0 ? JSON.stringify(nextTags) : null;
          const result = updateTags.run(nextTagsString, contact.id);
          changed += result.changes;
        }

        return changed;
      })();

      return NextResponse.json({
        operation,
        affected,
      });
    }

    if (operation === 'add_to_group' || operation === 'remove_from_group') {
      const groupId = Number(body.groupId);

      if (!Number.isInteger(groupId) || groupId < 1) {
        return NextResponse.json({ error: 'Valid group is required' }, { status: 400 });
      }

      const group = db.prepare('SELECT id FROM contact_groups WHERE id = ?').get(groupId);

      if (!group) {
        return NextResponse.json({ error: 'Group not found' }, { status: 404 });
      }

      const addMember = db.prepare(
        'INSERT OR IGNORE INTO contact_group_members (contact_id, group_id) VALUES (?, ?)'
      );
      const removeMember = db.prepare(
        'DELETE FROM contact_group_members WHERE contact_id = ? AND group_id = ?'
      );

      const affected = db.transaction(() => {
        let changed = 0;

        for (const contactId of contactIds) {
          const result = operation === 'add_to_group'
            ? addMember.run(contactId, groupId)
            : removeMember.run(contactId, groupId);
          changed += result.changes;
        }

        return changed;
      })();

      return NextResponse.json({
        operation,
        affected,
      });
    }

    return NextResponse.json({ error: 'Unsupported bulk operation' }, { status: 400 });
  } catch (error) {
    console.error('POST /api/contacts/bulk error:', error);
    return NextResponse.json({ error: 'Failed to perform bulk operation' }, { status: 500 });
  }
}
