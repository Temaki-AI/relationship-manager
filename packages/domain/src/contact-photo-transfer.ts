import { isEmbeddedContactPhoto } from './contact-photo.ts';
import { isSyncSequence, isSyncUuid } from './sync.ts';

export type ContactPhotoTransfer = {
  version: 1;
  epoch: string;
  contact_id: string;
  revision: number;
  photo: string | null;
  digest: string | null;
};
export const MAX_CONTACT_PHOTO_RESPONSE_BYTES = 184_000;
export const MAX_CACHED_CONTACT_PHOTOS = 64;

export function readContactPhotoTransfer(value: unknown, expected: { epoch: string; contactId: string; revision: number }): ContactPhotoTransfer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid contact photo response.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['version', 'epoch', 'contact_id', 'revision', 'photo', 'digest'].includes(key))
    || row.version !== 1 || !isSyncUuid(row.epoch) || row.epoch !== expected.epoch
    || !isSyncUuid(row.contact_id) || row.contact_id !== expected.contactId
    || !isSyncSequence(row.revision) || row.revision < 1 || row.revision !== expected.revision
    || (row.photo === null ? row.digest !== null : !isEmbeddedContactPhoto(row.photo)
      || typeof row.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(row.digest))) {
    throw new Error('Invalid contact photo response.');
  }
  return row as ContactPhotoTransfer;
}
