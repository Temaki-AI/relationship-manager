import { isEmbeddedContactPhoto } from './contact-photo.ts';
import { readContactPhotoTransfer, type ContactPhotoTransfer } from './contact-photo-transfer.ts';
import { isSyncUuid } from './sync.ts';

export type ContactPhotoMutation = { version: 1; operation_id: string; epoch: string; contact_id: string; base_digest: string | null; photo: string | null };
export type ContactPhotoAcknowledgement = { version: 1; operation_id: string; status: 'applied' | 'conflict'; transfer: ContactPhotoTransfer | null };
export function readContactPhotoMutation(value: unknown): ContactPhotoMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid photo change.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 6 || Object.keys(row).some((key) => !['version', 'operation_id', 'epoch', 'contact_id', 'base_digest', 'photo'].includes(key))
    || row.version !== 1 || !isSyncUuid(row.operation_id) || !isSyncUuid(row.epoch) || !isSyncUuid(row.contact_id)
    || (row.base_digest !== null && (typeof row.base_digest !== 'string' || !/^[0-9a-f]{64}$/u.test(row.base_digest)))
    || (row.photo !== null && !isEmbeddedContactPhoto(row.photo))) throw new Error('Invalid photo change.');
  return row as ContactPhotoMutation;
}
export function readContactPhotoAcknowledgement(value: unknown, mutation: ContactPhotoMutation): ContactPhotoAcknowledgement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid photo acknowledgement.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || Object.keys(row).some((key) => !['version', 'operation_id', 'status', 'transfer'].includes(key))
    || row.version !== 1 || row.operation_id !== mutation.operation_id || !['applied', 'conflict'].includes(String(row.status))) throw new Error('Invalid photo acknowledgement.');
  let transfer: ContactPhotoTransfer | null = null;
  if (row.transfer !== null) {
    const item = row.transfer as ContactPhotoTransfer;
    transfer = readContactPhotoTransfer(item, { epoch: mutation.epoch, contactId: item.contact_id, revision: item.revision });
  }
  if (row.status === 'applied' && (!transfer || transfer.photo !== mutation.photo)) throw new Error('Invalid photo acknowledgement.');
  return { version: 1, operation_id: mutation.operation_id, status: row.status as 'applied' | 'conflict', transfer };
}
