import type { SQLiteDatabase } from 'expo-sqlite';
import { normalizeUserContactMethods, readContactMethods } from '../../../../packages/domain/src/contact-methods';
import type { ContactEditBase } from './contacts';
import { canonicalContactId } from './contact-aliases';
import { enqueueSyncIntent } from './sync-queue';
import { signalSyncChange } from './sync-signals';

export async function updateContactMethods(db: SQLiteDatabase, original: ContactEditBase, draft: unknown) {
  const methods = normalizeUserContactMethods(draft, original.contact_methods);
  if (methods === original.contact_methods) return;
  const values = readContactMethods(methods), now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (tx) => {
    const current = await canonicalContactId(tx, original.id);
    if (!await tx.getFirstAsync('SELECT id FROM contacts WHERE id = ? AND deleted_at IS NULL', current)) throw new Error('This person is no longer available. Your draft is preserved.');
    await tx.runAsync(`UPDATE contacts SET contact_methods = ?, email = ?, phone = ?, updated_at = ?, sync_state = CASE WHEN EXISTS
      (SELECT 1 FROM sync_queue WHERE entity_type = 'contact' AND entity_id = ? AND status = 'conflict') THEN 'conflict' ELSE 'pending' END WHERE id = ?`,
    methods, values.find((item) => item.kind === 'email' && item.preferred)?.value ?? null,
    values.find((item) => item.kind === 'phone' && item.preferred)?.value ?? null, now, original.id, original.id);
    await enqueueSyncIntent(tx, 'contact', original.id, 'update', { contact_methods: methods }, now,
      { revision: original.remote_revision, values: { contact_methods: original.contact_methods } });
  });
  signalSyncChange(db);
}
