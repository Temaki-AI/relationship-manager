import type { SyncContactRecord, SyncValue } from './sync';
import type { SyncEntity } from './sync-v2';

// Alphabetical order keeps contacts before every dependent record during bootstrap.
export const SYNC_V3_ENTITIES = ['contact', 'family', 'interaction', 'plan', 'relationship', 'reminder'] as const;
export type SyncV3Entity = SyncEntity | 'family' | 'plan' | 'relationship';
export type SyncV3EntityRecord = SyncContactRecord & { entity: SyncV3Entity };
export type SyncV3EntityMutation = {
  operationId: string;
  entity: SyncV3Entity;
  entityId: string;
} & (
  | { type: 'create'; data: Record<string, unknown> }
  | { type: 'update'; baseRevision: number; base: Record<string, SyncValue>; patch: Record<string, unknown> }
  | { type: 'delete'; baseRevision: number }
);
export type SyncV3PushRequest = { version: 3; epoch: string; mutation: SyncV3EntityMutation };
export type SyncV3MutationResult = { operationId: string; status: 'applied' | 'conflict'; record: SyncV3EntityRecord | null;
  canonicalRecord?: SyncV3EntityRecord & { entity: 'contact' } };
export type SyncV3BootstrapPosition = { epoch: string; sequence: number; entity: SyncV3Entity; after: string };
