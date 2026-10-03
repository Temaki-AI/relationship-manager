import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';

export type SyncEntityType = 'contact' | 'interaction' | 'reminder';
export type SyncOperation = 'create' | 'update' | 'delete';

export async function enqueueSyncIntent(
  db: SQLiteDatabase,
  entityType: SyncEntityType,
  entityId: string,
  operation: SyncOperation,
  payload: Record<string, unknown>,
  createdAt: string
): Promise<void> {
  await db.runAsync(
    `INSERT INTO sync_queue (
      id, entity_type, entity_id, operation, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    Crypto.randomUUID(),
    entityType,
    entityId,
    operation,
    JSON.stringify(payload),
    createdAt
  );
}
