import type { SyncV3Entity, SyncV3EntityRecord, SyncV3EntityMutation, SyncV3MutationResult } from './sync-v3';
export const SYNC_V4_ENTITIES = ['contact', 'family', 'interaction', 'plan', 'relationship', 'reminder', 'source_event'] as const;
export type SyncV4Entity = SyncV3Entity | 'source_event';
export type SyncV4EntityRecord = Omit<SyncV3EntityRecord, 'entity'> & { entity: SyncV4Entity };
// Provider facts arrive from the reviewed canonical source; ordinary six-entity edits keep their existing contract.
export type SyncV4PushRequest = { version: 4; epoch: string; mutation: SyncV3EntityMutation };
export type SyncV4MutationResult = Omit<SyncV3MutationResult, 'record'> & { record: SyncV4EntityRecord | null };
export type SyncV4BootstrapPosition = { epoch: string; sequence: number; entity: SyncV4Entity; after: string };
