import type Database from 'better-sqlite3';
import { createDatabaseBackup, type BackupMetadata } from './database-maintenance.ts';
import { withDatabaseMaintenanceLock } from './database-maintenance-lock.ts';

export const MAX_CONTACT_DELETE_BATCH_SIZE = 100;

export class ContactDeletionError extends Error {
  readonly code: 'invalid_input' | 'not_found' | 'delete_failed';

  constructor(
    message: string,
    code: 'invalid_input' | 'not_found' | 'delete_failed'
  ) {
    super(message);
    this.name = 'ContactDeletionError';
    this.code = code;
  }
}

type ContactDeletionOptions = {
  retentionCount?: number;
  now?: Date;
  lockWaitMilliseconds?: number;
};

export type ContactDeletionResult = {
  affected: number;
  recoveryPoint: BackupMetadata;
};

function normalizeContactIds(contactIds: number[]): number[] {
  if (
    contactIds.length === 0
    || contactIds.some((id) => !Number.isInteger(id) || id < 1)
  ) {
    throw new ContactDeletionError('Choose at least one valid contact.', 'invalid_input');
  }

  const uniqueIds = Array.from(new Set(contactIds));
  if (uniqueIds.length > MAX_CONTACT_DELETE_BATCH_SIZE) {
    throw new ContactDeletionError(
      `Delete no more than ${MAX_CONTACT_DELETE_BATCH_SIZE} contacts at once.`,
      'invalid_input'
    );
  }
  return uniqueIds;
}

export function deleteContactsWithRecovery(
  db: Database.Database,
  backupDirectory: string,
  contactIds: number[],
  options: ContactDeletionOptions = {}
): ContactDeletionResult {
  const ids = normalizeContactIds(contactIds);
  const placeholders = ids.map(() => '?').join(', ');

  return withDatabaseMaintenanceLock(backupDirectory, () => {
    const existing = db.prepare(`SELECT id FROM contacts WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: number }>;
    if (existing.length !== ids.length) {
      throw new ContactDeletionError(
        'One or more selected contacts no longer exist. Refresh and try again.',
        'not_found'
      );
    }

    const recoveryPoint = createDatabaseBackup(db, {
      backupDirectory,
      reason: 'pre-delete',
      retentionCount: options.retentionCount,
      now: options.now,
    });

    const affected = db.transaction(() => db
      .prepare(`DELETE FROM contacts WHERE id IN (${placeholders})`)
      .run(...ids).changes)();

    if (affected !== ids.length) {
      throw new ContactDeletionError('The contact deletion did not complete.', 'delete_failed');
    }

    return { affected, recoveryPoint };
  }, { waitMilliseconds: options.lockWaitMilliseconds });
}
