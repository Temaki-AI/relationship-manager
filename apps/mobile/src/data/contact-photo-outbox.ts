import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { isSyncUuid } from '../../../../packages/domain/src/sync';
import { readSyncRecord } from '../../../../packages/domain/src/sync-client';
import { isEmbeddedContactPhoto } from '../../../../packages/domain/src/contact-photo';
import { readContactPhotoMutation, readContactPhotoAcknowledgement } from '../../../../packages/domain/src/contact-photo-mutation';
import { contactPhotoBaseline, saveTransferredContactPhoto } from './contact-photos';
import { signalSyncChange } from './sync-signals';
import { canonicalContactId } from './contact-aliases';

export const PHOTO_QUEUE_PREFIX = 'contact-photo-outbox:v1:';
const DRAFT_PREFIX = 'contact-photo-draft:v1:';
export type PhotoOpening = { contactId: string; scope: string; epoch: string | null; digest: string | null; queueId: string | null };
export type PhotoQueue = { id: string; contactId: string; scope: string; epoch: string | null; base_digest: string | null;
  photo: string | null; status: 'pending' | 'conflict'; request_json: string | null; error: string | null };
type PhotoDraft = { version: 1; opening: PhotoOpening; photo: string | null };
async function metadata(db: SQLiteDatabase, key: string) {
  return (await db.getFirstAsync<{ value: string }>('SELECT value FROM app_metadata WHERE key = ?', key))?.value ?? null;
}
async function save(db: SQLiteDatabase, key: string, value: unknown) {
  await db.runAsync(`INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, key, JSON.stringify(value), new Date().toISOString());
}
async function check(db: SQLiteDatabase, scope: string, isCurrent: () => boolean) {
  if (!isCurrent() || await metadata(db, 'account-scope') !== scope) throw new Error('The active account changed.');
}
function validPhoto(value: unknown) { return value === null || isEmbeddedContactPhoto(value); }
function readQueue(raw: string): PhotoQueue {
  const row = JSON.parse(raw) as PhotoQueue;
  if (!row || !isSyncUuid(row.id) || !isSyncUuid(row.contactId) || typeof row.scope !== 'string'
    || (row.epoch !== null && !isSyncUuid(row.epoch)) || !validPhoto(row.photo)
    || (row.base_digest !== null && (typeof row.base_digest !== 'string' || !/^[0-9a-f]{64}$/u.test(row.base_digest)))
    || !['pending', 'conflict'].includes(row.status) || (row.request_json !== null && typeof row.request_json !== 'string')) throw new Error('This saved photo change needs recovery. Its original bytes are preserved.');
  if (row.request_json) {
    const request = readContactPhotoMutation(JSON.parse(row.request_json));
    if (request.operation_id !== row.id || request.contact_id !== row.contactId || request.epoch !== row.epoch
      || request.base_digest !== row.base_digest || request.photo !== row.photo) throw new Error('This saved photo request needs recovery.');
  }
  return row;
}
export async function queuedContactPhoto(db: SQLiteDatabase, id: string, scope: string) {
  await check(db, scope, () => true);
  const raw = await metadata(db, PHOTO_QUEUE_PREFIX + id), row = raw ? readQueue(raw) : null;
  if (row && row.scope !== scope) throw new Error('This photo belongs to another account.');
  return row;
}
export async function openContactPhoto(db: SQLiteDatabase, id: string, scope: string, reviewCurrent = false) {
  await check(db, scope, () => true);
  const queue = await queuedContactPhoto(db, id, scope);
  const raw = await metadata(db, DRAFT_PREFIX + id);
  if (raw && !reviewCurrent) {
    let draft: PhotoDraft;
    try {
      draft = JSON.parse(raw) as PhotoDraft;
      const opening = draft.opening;
      if (draft.version !== 1 || !opening || opening.scope !== scope || opening.contactId !== id || !validPhoto(draft.photo)
        || (opening.epoch !== null && !isSyncUuid(opening.epoch))
        || (opening.digest !== null && !/^[0-9a-f]{64}$/u.test(opening.digest))
        || (opening.queueId !== null && !isSyncUuid(opening.queueId))) throw new Error('Invalid draft');
    } catch { throw new Error('Your unfinished photo is preserved but could not be read. Discard only this draft to start again.'); }
    return { opening: draft.opening, draft, queue };
  }
  const base = await contactPhotoBaseline(db, id, scope);
  return { opening: { contactId: id, scope, epoch: base.epoch, digest: base.digest, queueId: queue?.id ?? null }, draft: null, queue };
}
export async function saveContactPhotoDraft(db: SQLiteDatabase, opening: PhotoOpening, photo: string | null, isCurrent: () => boolean = () => true) {
  if (!validPhoto(photo)) throw new Error('Choose a smaller JPEG, PNG or WebP photo.');
  await db.withExclusiveTransactionAsync(async (tx) => {
    await check(tx, opening.scope, isCurrent);
    await save(tx, DRAFT_PREFIX + opening.contactId, { version: 1, opening, photo });
    await check(tx, opening.scope, isCurrent);
  });
}
export async function discardContactPhotoDraft(db: SQLiteDatabase, id: string, scope: string, isCurrent: () => boolean = () => true) {
  await db.withExclusiveTransactionAsync(async (tx) => { await check(tx, scope, isCurrent); await tx.runAsync('DELETE FROM app_metadata WHERE key = ?', DRAFT_PREFIX + id); });
}
export async function queueContactPhoto(db: SQLiteDatabase, opening: PhotoOpening, photo: string | null, isCurrent: () => boolean = () => true) {
  if (!validPhoto(photo) || !isSyncUuid(opening.contactId)) throw new Error('Choose a valid photo for a saved person.');
  await db.withExclusiveTransactionAsync(async (tx) => {
    await check(tx, opening.scope, isCurrent);
    if (!await tx.getFirstAsync('SELECT id FROM contacts WHERE id = ? AND deleted_at IS NULL', opening.contactId)) throw new Error('This person was removed or merged. Your photo draft is preserved.');
    const queue = await queuedContactPhoto(tx, opening.contactId, opening.scope);
    if ((queue?.id ?? null) !== opening.queueId) throw new Error('The queued photo changed. Reopen its current review.');
    if (queue?.request_json && queue.status === 'pending') throw new Error('The last upload is unconfirmed. Retry it unchanged before replacing it.');
    const current = await contactPhotoBaseline(tx, opening.contactId, opening.scope);
    if (current.epoch !== opening.epoch || current.digest !== opening.digest) throw new Error('The cloud photo changed. Your selection is saved; review the current photo before sending it.');
    if (!queue && (await tx.getFirstAsync<{ n: number }>('SELECT count(*) n FROM app_metadata WHERE key LIKE ?', PHOTO_QUEUE_PREFIX + '%'))!.n >= 64) throw new Error('Sync or review saved photos before adding more.');
    const row: PhotoQueue = { id: Crypto.randomUUID(), contactId: opening.contactId, scope: opening.scope, epoch: opening.epoch,
      base_digest: opening.digest, photo, status: 'pending', request_json: null, error: null };
    await save(tx, PHOTO_QUEUE_PREFIX + opening.contactId, row);
    await tx.runAsync('DELETE FROM app_metadata WHERE key = ?', DRAFT_PREFIX + opening.contactId);
    await check(tx, opening.scope, isCurrent);
  });
  signalSyncChange(db);
}
export async function discardQueuedContactPhoto(db: SQLiteDatabase, id: string, scope: string, queueId: string, isCurrent: () => boolean = () => true) {
  await db.withExclusiveTransactionAsync(async (tx) => {
    await check(tx, scope, isCurrent);
    const row = await queuedContactPhoto(tx, id, scope);
    if (row?.id !== queueId || (row.request_json && row.status === 'pending')) throw new Error('Retry the unconfirmed photo unchanged before discarding it.');
    await tx.runAsync('DELETE FROM app_metadata WHERE key = ?', PHOTO_QUEUE_PREFIX + id);
  }); signalSyncChange(db);
}
export async function holdContactPhotosForEpoch(db: SQLiteDatabase, epoch: string) {
  await db.runAsync(`UPDATE app_metadata SET value = json_set(value, '$.status', 'conflict', '$.error', 'epoch_changed')
    WHERE key LIKE ? AND json_valid(value) AND json_extract(value, '$.epoch') IS NOT NULL AND json_extract(value, '$.epoch') != ?`, PHOTO_QUEUE_PREFIX + '%', epoch);
}
export async function photoSyncReviews(db: SQLiteDatabase) {
  const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM app_metadata WHERE key LIKE ? ORDER BY updated_at, key LIMIT 64', PHOTO_QUEUE_PREFIX + '%');
  return rows.map((row) => readQueue(row.value)).filter((row) => row.status === 'conflict');
}

export async function syncContactPhotos(db: SQLiteDatabase, epoch: string, request: (id: string, body: string) => Promise<unknown>, checkAccount: (tx: SQLiteDatabase) => Promise<void>) {
  let changed = 0;
  for (let step = 0; step < 8; step++) {
    let frozen: PhotoQueue | null = null;
    await db.withExclusiveTransactionAsync(async (tx) => {
      await checkAccount(tx); await holdContactPhotosForEpoch(tx, epoch);
      const candidates = await tx.getAllAsync<{ value: string }>(`SELECT value FROM app_metadata WHERE key LIKE ?
        ORDER BY updated_at, key LIMIT 64`, PHOTO_QUEUE_PREFIX + '%');
      for (const candidate of candidates) {
        const row = readQueue(candidate.value);
        await check(tx, row.scope, () => true);
        if (row.status !== 'pending') continue;
        if (!row.request_json) {
          if (await tx.getFirstAsync("SELECT 1 FROM sync_queue WHERE entity_type = 'contact' AND entity_id = ?", row.contactId)) continue;
          const raw = await tx.getFirstAsync<{ record_json: string }>('SELECT record_json FROM sync_remote_contacts WHERE id = ?', row.contactId);
          const record = raw ? readSyncRecord(JSON.parse(raw.record_json)) : null;
          if (!record || record.deleted) { row.status = 'conflict'; row.error = 'person_missing'; await save(tx, PHOTO_QUEUE_PREFIX + row.contactId, row); continue; }
          // A locally created person has no cloud photo before its create acknowledgement.
          if (row.epoch === null) {
            if (record.data!.photo_available === 1) { row.status = 'conflict'; row.error = 'photo_changed'; await save(tx, PHOTO_QUEUE_PREFIX + row.contactId, row); continue; }
            row.epoch = epoch;
          }
          row.request_json = JSON.stringify(readContactPhotoMutation({ version: 1, operation_id: row.id, epoch: row.epoch,
            contact_id: row.contactId, base_digest: row.base_digest, photo: row.photo }));
          await save(tx, PHOTO_QUEUE_PREFIX + row.contactId, row);
        }
        frozen = row; break;
      }
      await checkAccount(tx);
    });
    if (!frozen) break;
    const row = frozen as PhotoQueue, mutation = readContactPhotoMutation(JSON.parse(row.request_json!));
    let result;
    try { result = readContactPhotoAcknowledgement(await request(row.contactId, row.request_json!), mutation); }
    catch (error) {
      const failure = error as { status?: number; code?: string };
      if (failure.code === 'epoch_changed' || ![400, 404, 409, 413].includes(failure.status ?? 0)) throw error;
      await db.withExclusiveTransactionAsync(async (tx) => {
        await checkAccount(tx);
        const current = await queuedContactPhoto(tx, row.contactId, row.scope);
        if (current?.id === row.id) await save(tx, PHOTO_QUEUE_PREFIX + row.contactId, { ...current, status: 'conflict', error: failure.code ?? 'photo_rejected' });
      }); changed++; continue;
    }
    if (result.transfer?.photo != null && await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, result.transfer.photo) !== result.transfer.digest) throw new Error('The photo acknowledgement failed its checksum. Retry the same saved request.');
    await db.withExclusiveTransactionAsync(async (tx) => {
      await checkAccount(tx);
      if (result.transfer && result.transfer.contact_id !== row.contactId
        && result.transfer.contact_id !== await canonicalContactId(tx, row.contactId)) throw new Error('Sync the merged person before accepting its photo result. The saved request is unchanged.');
      const current = await queuedContactPhoto(tx, row.contactId, row.scope);
      if (current?.id !== row.id || current.request_json !== row.request_json) throw new Error('The queued photo changed during its upload.');
      if (result.status === 'applied') {
        if (result.transfer) await saveTransferredContactPhoto(tx, result.transfer);
        await tx.runAsync('DELETE FROM app_metadata WHERE key = ?', PHOTO_QUEUE_PREFIX + row.contactId);
      } else await save(tx, PHOTO_QUEUE_PREFIX + row.contactId, { ...current, status: 'conflict', error: 'photo_changed' });
      await checkAccount(tx);
    }); changed++;
  }
  return changed;
}
