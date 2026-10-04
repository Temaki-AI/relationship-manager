import type { SyncContactRecord, SyncValue } from './sync';

export const SYNC_V2_ENTITIES = ['contact', 'interaction', 'reminder'] as const;
export type SyncEntity = typeof SYNC_V2_ENTITIES[number];
export type SyncEntityRecord = SyncContactRecord & { entity: SyncEntity };
export type SyncEntityMutation = {
  operationId: string;
  entity: SyncEntity;
  entityId: string;
} & (
  | { type: 'create'; data: Record<string, unknown> }
  | { type: 'update'; baseRevision: number; base: Record<string, SyncValue>; patch: Record<string, unknown> }
  | { type: 'delete'; baseRevision: number }
);
export type SyncV2PushRequest = { version: 2; epoch: string; mutation: SyncEntityMutation };
export type SyncV2MutationResult = {
  operationId: string;
  status: 'applied' | 'conflict';
  record: SyncEntityRecord | null;
  canonicalRecord?: SyncEntityRecord & { entity: 'contact' };
};
export type SyncV2BootstrapPosition = { epoch: string; sequence: number; entity: SyncEntity; after: string };
