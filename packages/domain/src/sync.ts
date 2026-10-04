/** Versioned, transport-independent contact sync contract. */
export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_PAGE_SIZE = 10;
export const MAX_SYNC_PUSH_BYTES = 256 * 1024;
export const MAX_SYNC_PAGE_BYTES = 1024 * 1024;
export const MAX_SYNC_RECORD_BYTES = 512 * 1024;

export const SYNC_WRITABLE_CONTACT_FIELDS = [
  'name', 'nickname', 'email', 'phone', 'birthday', 'birthday_reminder_days',
  'how_we_met', 'tags', 'notes', 'gift_ideas', 'custom_fields',
  'last_contacted', 'contact_frequency',
  'contact_methods',
] as const;
export type SyncContactField = typeof SYNC_WRITABLE_CONTACT_FIELDS[number];
export type SyncValue = string | number | null;
export type SyncCursor = { epoch: string; sequence: number };
export type SyncContactRecord = {
  id: string;
  legacyId: number;
  revision: number;
  deleted: boolean;
  data: Record<string, SyncValue> | null;
  mergedIntoId?: string;
};
export type SyncContactMutation = {
  operationId: string;
  contactId: string;
} & (
  | { type: 'create'; data: Record<string, unknown> }
  | { type: 'update'; baseRevision: number; base: Partial<Record<SyncContactField, SyncValue>>; patch: Record<string, unknown> }
  | { type: 'delete'; baseRevision: number }
);
export type SyncPushRequest = { version: 1; epoch: string; mutation: SyncContactMutation };
export type SyncMutationResult = {
  operationId: string;
  status: 'applied' | 'conflict';
  record: SyncContactRecord | null;
  canonicalRecord?: SyncContactRecord;
};

export function isSyncUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

export function isSyncSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
