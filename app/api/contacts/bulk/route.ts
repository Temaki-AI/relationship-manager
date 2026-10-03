import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { ContactDeletionError, deleteContactsWithRecovery } from '@/lib/contact-deletion';
import { ContactDirectoryError, updateTagMembership } from '@/lib/contact-directory';
import { getBackupRetentionCount } from '@/lib/database-maintenance-config';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMutationLock,
} from '@/lib/database-maintenance-lock';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { logRouteError } from '@/lib/observability';

type BulkOperation = 'delete' | 'add_tag' | 'remove_tag' | 'add_to_group' | 'remove_from_group';

function parseContactIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const parsed = value.map((id) => Number(id));
  if (parsed.some((id) => !Number.isInteger(id) || id < 1)) return null;
  return Array.from(new Set(parsed));
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const operation = body.operation as BulkOperation;
    const contactIds = parseContactIds(body.contactIds);

    if (!operation) {
      return NextResponse.json({ error: 'Operation is required' }, { status: 400 });
    }

    if (!contactIds || contactIds.length === 0) {
      return NextResponse.json({ error: 'Select at least one contact' }, { status: 400 });
    }

    if (operation === 'delete') {
      const result = deleteContactsWithRecovery(db, backupDirectory, contactIds, {
        retentionCount: getBackupRetentionCount(),
      });
      return NextResponse.json({
        operation,
        affected: result.affected,
        recoveryPoint: {
          filename: result.recoveryPoint.filename,
          createdAt: result.recoveryPoint.createdAt,
        },
      });
    }

    if (operation === 'add_tag' || operation === 'remove_tag') {
      const affected = withDatabaseMutationLock(
        backupDirectory,
        () => updateTagMembership(
          db,
          body.tag,
          contactIds,
          operation === 'add_tag' ? 'add' : 'remove'
        )
      );
      return NextResponse.json({ operation, affected });
    }

    if (operation === 'add_to_group' || operation === 'remove_from_group') {
      const groupId = Number(body.groupId);

      if (!Number.isInteger(groupId) || groupId < 1) {
        return NextResponse.json({ error: 'Valid group is required' }, { status: 400 });
      }

      const result = withDatabaseMutationLock(backupDirectory, () => {
        const placeholders = contactIds.map(() => '?').join(', ');
        const contacts = db
          .prepare(`SELECT id FROM contacts WHERE id IN (${placeholders})`)
          .all(...contactIds) as Array<{ id: number }>;
        if (contacts.length !== contactIds.length) {
          return { status: 'contacts-not-found' as const, affected: 0 };
        }

        const group = db.prepare('SELECT id FROM contact_groups WHERE id = ?').get(groupId);
        if (!group) return { status: 'group-not-found' as const, affected: 0 };
        const addMember = db.prepare(
          'INSERT OR IGNORE INTO contact_group_members (contact_id, group_id) VALUES (?, ?)'
        );
        const removeMember = db.prepare(
          'DELETE FROM contact_group_members WHERE contact_id = ? AND group_id = ?'
        );

        const affected = db.transaction(() => {
          let changed = 0;
          for (const contactId of contactIds) {
            const membership = operation === 'add_to_group'
              ? addMember.run(contactId, groupId)
              : removeMember.run(contactId, groupId);
            changed += membership.changes;
          }
          return changed;
        })();
        return { status: 'updated' as const, affected };
      });

      if (result.status === 'contacts-not-found') {
        return NextResponse.json({ error: 'One or more selected contacts no longer exist' }, { status: 404 });
      }
      if (result.status === 'group-not-found') {
        return NextResponse.json({ error: 'Group not found' }, { status: 404 });
      }

      return NextResponse.json({
        operation,
        affected: result.affected,
      });
    }

    return NextResponse.json({ error: 'Unsupported bulk operation' }, { status: 400 });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ContactDeletionError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.code === 'not_found' ? 404 : 400 }
      );
    }
    if (error instanceof ContactDirectoryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logRouteError('contacts.bulk_failed', error, request, '/api/contacts/bulk');
    return NextResponse.json({ error: 'Failed to perform bulk operation' }, { status: 500 });
  }
}
