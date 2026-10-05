import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { accountScope, type NativeAccount } from '../../../../packages/domain/src/devices';
import { readSyncCursor, readSyncRecord } from '../../../../packages/domain/src/sync-client';
import { isSyncUuid } from '../../../../packages/domain/src/sync';
import { MAX_CACHED_CONTACT_PHOTOS, MAX_CONTACT_PHOTO_RESPONSE_BYTES, readContactPhotoTransfer, type ContactPhotoTransfer } from '../../../../packages/domain/src/contact-photo-transfer';

const PREFIX = 'contact-photo:v1:';
export class ContactPhotoDownloadError extends Error {
  constructor(message: string, readonly code: string, readonly status = 0) { super(message); }
}
type PhotoPosition = { contactId: string; epoch: string; revision: number; available: boolean; cached: ContactPhotoTransfer | null };
type Options = { fetcher?: typeof fetch; isCurrent?: () => boolean };

async function position(db: SQLiteDatabase, id: string, scope: string): Promise<PhotoPosition | null> {
  if (!isSyncUuid(id)) throw new ContactPhotoDownloadError('Open a saved person to view their photo.', 'invalid_person');
  const row = await db.getFirstAsync<{ scope: string | null; cursor: string | null; record: string | null; cached: string | null }>(`SELECT
    (SELECT value FROM app_metadata WHERE key = 'account-scope') AS scope,
    (SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4') AS cursor,
    r.record_json AS record, (SELECT value FROM app_metadata WHERE key = ?) AS cached
    FROM contacts c LEFT JOIN sync_remote_contacts r ON r.id = c.id WHERE c.id = ? AND c.deleted_at IS NULL`, PREFIX + id, id);
  if (!row) return null;
  if (row.scope !== scope) throw new ContactPhotoDownloadError('The active account changed.', 'account_changed');
  if (!row.cursor || !row.record) return null;
  const cursor = readSyncCursor(JSON.parse(row.cursor)), record = readSyncRecord(JSON.parse(row.record));
  if (record.deleted || record.id !== id) return null;
  let cached: ContactPhotoTransfer | null = null;
  try {
    if (row.cached) cached = readContactPhotoTransfer(JSON.parse(row.cached), { epoch: cursor.epoch, contactId: id, revision: record.revision });
    if (cached?.photo !== null && cached?.photo !== undefined
      && await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, cached.photo) !== cached.digest) cached = null;
  }
  catch { /* Changed revisions and damaged cache entries can be downloaded again. */ }
  return { contactId: id, epoch: cursor.epoch, revision: record.revision, available: record.data!.photo_available === 1, cached };
}

export async function cachedContactPhoto(db: SQLiteDatabase, id: string, scope: string) {
  const value = await position(db, id, scope);
  return value?.available ? value.cached?.photo ?? null : null;
}

/** Called inside the staged bootstrap transaction; a restore never reuses old photo bytes. */
export async function discardContactPhotosForEpoch(db: SQLiteDatabase, epoch: string) {
  if (!isSyncUuid(epoch)) throw new Error('A valid photo-cache epoch is required.');
  await db.runAsync(`DELETE FROM app_metadata WHERE key LIKE ? AND (NOT json_valid(value)
    OR CASE WHEN json_valid(value) THEN json_extract(value, '$.epoch') END IS NOT ?)`, PREFIX + '%', epoch);
}

export async function loadContactPhoto(db: SQLiteDatabase, account: NativeAccount, id: string, options: Options = {}) {
  const isCurrent = options.isCurrent ?? (() => true), scope = accountScope(account);
  const check = () => { if (!isCurrent()) throw new ContactPhotoDownloadError('The active account changed.', 'account_changed'); };
  check();
  const wanted = await position(db, id, scope); check();
  if (!wanted || !wanted.available) return null;
  if (wanted.cached) {
    await db.runAsync('UPDATE app_metadata SET updated_at = ? WHERE key = ? AND value = ?', new Date().toISOString(), PREFIX + id, JSON.stringify(wanted.cached));
    check(); return wanted.cached.photo;
  }
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20_000);
  let value: ContactPhotoTransfer;
  try {
    const url = `${account.origin}/api/v1/contact-photos/${id}?epoch=${wanted.epoch}&revision=${wanted.revision}`;
    const response = await (options.fetcher ?? fetch)(url, { method: 'GET', credentials: 'omit', redirect: 'error',
      headers: { Authorization: `Bearer ${account.token}`, Accept: 'application/json' }, signal: controller.signal });
    check();
    if (response.url && response.url !== url) throw new ContactPhotoDownloadError('The photo response came from an unexpected address.', 'invalid_response');
    const length = response.headers.get('content-length');
    if (length && Number(length) > MAX_CONTACT_PHOTO_RESPONSE_BYTES) throw new ContactPhotoDownloadError('This photo is too large to download.', 'photo_too_large');
    const raw = await response.text(); check();
    if (new TextEncoder().encode(raw).byteLength > MAX_CONTACT_PHOTO_RESPONSE_BYTES) throw new ContactPhotoDownloadError('This photo is too large to download.', 'photo_too_large');
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new ContactPhotoDownloadError('The server did not return a contact photo.', 'invalid_response'); }
    if (!response.ok) {
      const error = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      throw new ContactPhotoDownloadError(typeof error.error === 'string' ? error.error : 'Unable to download this photo. Sync and retry.',
        typeof error.code === 'string' ? error.code : 'photo_download_failed', response.status);
    }
    value = readContactPhotoTransfer(body, { epoch: wanted.epoch, contactId: id, revision: wanted.revision });
    if (value.photo !== null && await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value.photo) !== value.digest) {
      throw new ContactPhotoDownloadError('This photo did not pass its integrity check. Retry the download.', 'invalid_response');
    }
    check();
  } catch (error) {
    if (error instanceof ContactPhotoDownloadError) throw error;
    throw new ContactPhotoDownloadError('Unable to download the photo. Saved contact details remain available.', 'photo_download_failed');
  } finally { clearTimeout(timeout); }
  await db.withExclusiveTransactionAsync(async (tx) => {
    check();
    const current = await position(tx, id, scope); check();
    if (!current || current.epoch !== wanted.epoch || current.revision !== wanted.revision || current.available !== wanted.available) {
      throw new ContactPhotoDownloadError('This person changed during the photo download. Sync and retry.', 'photo_changed');
    }
    await tx.runAsync(`INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, PREFIX + id, JSON.stringify(value), new Date().toISOString());
    // Keep the visible person plus the 63 most recently accessed cached photos.
    await tx.runAsync(`DELETE FROM app_metadata WHERE key LIKE ? AND key != ? AND key NOT IN
      (SELECT key FROM app_metadata WHERE key LIKE ? AND key != ? ORDER BY updated_at DESC, key DESC LIMIT ?)`,
      PREFIX + '%', PREFIX + id, PREFIX + '%', PREFIX + id, MAX_CACHED_CONTACT_PHOTOS - 1);
    check();
  });
  return value.photo;
}
