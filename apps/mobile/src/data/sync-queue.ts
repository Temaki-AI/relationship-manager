import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';

export type SyncEntityType = 'contact' | 'family' | 'interaction' | 'plan' | 'relationship' | 'reminder';
export type SyncOperation = 'create' | 'update' | 'delete';

export async function enqueueSyncIntent(
  db: SQLiteDatabase,
  entityType: SyncEntityType,
  entityId: string,
  operation: SyncOperation,
  payload: Record<string, unknown>,
  createdAt: string,
  base?: { revision: number | null; values: Record<string, string | number | null> }
): Promise<string> {
  const cursor = await db.getFirstAsync<{ value: string }>(`SELECT value FROM app_metadata WHERE key IN ('sync-cursor-v3', 'sync-cursor-v2', 'sync-cursor')
    ORDER BY CASE key WHEN 'sync-cursor-v3' THEN 0 WHEN 'sync-cursor-v2' THEN 1 ELSE 2 END LIMIT 1`);
  const epoch = cursor ? (JSON.parse(cursor.value) as { epoch: string }).epoch : null;
  const id = Crypto.randomUUID();
  await db.runAsync(
    `INSERT INTO sync_queue (
      id, entity_type, entity_id, operation, payload, created_at, epoch, base_revision, base_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    entityType,
    entityId,
    operation,
    JSON.stringify(payload),
    createdAt,
    epoch,
    base?.revision ?? null,
    base ? JSON.stringify(base.values) : null
  );
  return id;
}
