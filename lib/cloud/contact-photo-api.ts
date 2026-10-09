import { createHash } from 'node:crypto';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { isEmbeddedContactPhoto } from '@/packages/domain/src/contact-photo';
import { isSyncUuid } from '@/packages/domain/src/sync';
import type { DeviceActor } from './device-api';
import { readContactPhotoMutation, type ContactPhotoMutation, type ContactPhotoAcknowledgement } from '@/packages/domain/src/contact-photo-mutation';
import { MAX_CONTACT_PHOTO_RESPONSE_BYTES } from '@/packages/domain/src/contact-photo-transfer';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { maintenanceGuard, removeGuard } from './recovery-storage';

type DB = CloudflareEnv['DB'];
class ContactPhotoError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
});
const digest = (photo: string | null) => photo === null ? null : createHash('sha256').update(photo).digest('hex');
function authorization(actor: DeviceActor) {
  const now = new Date().toISOString();
  return { sql: `EXISTS (SELECT 1 FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
    JOIN workspace_sync_state s ON s.workspace_id = w.id WHERE w.id = ? AND m.user_id = ?
    AND w.lifecycle = 'active' AND s.paused = 0 AND s.epoch = ? ${actor.authMethod === 'device' ? `AND EXISTS
    (SELECT 1 FROM device_sessions d WHERE d.id = ? AND d.workspace_id = w.id AND d.user_id = m.user_id
      AND d.revoked_at IS NULL AND d.expires_at > ?)` : ''})`,
  values: (epoch: string) => [actor.workspaceId, actor.userId, epoch, ...(actor.authMethod === 'device' ? [actor.deviceId ?? '', now] : [])] };
}
async function assertWriteAccount(db: DB, actor: DeviceActor, epoch: string) {
  const state = await db.prepare(`SELECT w.lifecycle, s.epoch, s.paused FROM workspaces w JOIN workspace_members m
    ON m.workspace_id = w.id JOIN workspace_sync_state s ON s.workspace_id = w.id WHERE w.id = ? AND m.user_id = ?
    ${actor.authMethod === 'device' ? `AND EXISTS (SELECT 1 FROM device_sessions d WHERE d.id = ? AND d.workspace_id = w.id
      AND d.user_id = m.user_id AND d.revoked_at IS NULL AND d.expires_at > ?)` : ''}`)
    .bind(actor.workspaceId, actor.userId, ...(actor.authMethod === 'device' ? [actor.deviceId ?? '', new Date().toISOString()] : []))
    .first<{ lifecycle: string; epoch: string; paused: number }>();
  if (!state) throw new ContactPhotoError('This account or phone session is no longer valid.', 401, 'unauthorized');
  if (state.lifecycle !== 'active' || state.paused) throw new ContactPhotoError('Account recovery is in progress. Retry later.', 423, 'maintenance');
  if (state.epoch !== epoch) throw new ContactPhotoError('Account data was restored. Review your saved photo after syncing.', 409, 'epoch_changed');
}
type PhotoReceipt = { fingerprint: string; result: string | null };
function acknowledge(receipt: PhotoReceipt, fingerprint: string): ContactPhotoAcknowledgement {
  if (receipt.fingerprint !== fingerprint) throw new ContactPhotoError('This operation ID was already used for another change.', 409, 'operation_reused');
  if (!receipt.result) throw new ContactPhotoError('The photo result is unconfirmed. Retry the same operation.', 503, 'unavailable');
  const result = JSON.parse(receipt.result) as ContactPhotoAcknowledgement;
  if (result.transfer) {
    if (result.transfer.photo !== null && !isEmbeddedContactPhoto(result.transfer.photo)) result.transfer = null;
    else result.transfer.digest = digest(result.transfer.photo);
  }
  return result;
}

/** Receipt, guarded resource write and resulting photo are committed in one D1 transaction. */
export async function uploadContactPhoto(db: DB, actor: DeviceActor, mutation: ContactPhotoMutation) {
  readContactPhotoMutation(mutation);
  await assertWriteAccount(db, actor, mutation.epoch);
  const fingerprint = createHash('sha256').update(JSON.stringify(['contact-photo:v1', mutation.operation_id,
    mutation.epoch, mutation.contact_id, mutation.base_digest, mutation.photo])).digest('hex');
  const receiptValues = [actor.workspaceId, mutation.epoch, mutation.operation_id];
  const query = db.prepare('SELECT fingerprint, result FROM sync_mutation_receipts WHERE workspace_id = ? AND epoch = ? AND operation_id = ?').bind(...receiptValues);
  const previous = await query.first<PhotoReceipt>();
  if (previous) return acknowledge(previous, fingerprint);
  const row = await db.prepare(`SELECT c.public_id, c.photo_url FROM contacts c WHERE c.workspace_id = ?
    AND c.public_id = COALESCE((SELECT canonical_public_id FROM contact_merge_aliases WHERE workspace_id = ? AND public_id = ?), ?)`)
    .bind(actor.workspaceId, actor.workspaceId, mutation.contact_id, mutation.contact_id).first<{ public_id: string; photo_url: string | null }>();
  if (row?.photo_url != null && !isEmbeddedContactPhoto(row.photo_url)) throw new ContactPhotoError('The current photo uses an unsupported format. Your photo is preserved for review.', 409, 'photo_unavailable');
  const owner = crypto.randomUUID(), guard = crypto.randomUUID(), auth = authorization(actor);
  const canonicalId = row?.public_id ?? mutation.contact_id;
  const owned = 'EXISTS (SELECT 1 FROM sync_mutation_receipts WHERE workspace_id = ? AND epoch = ? AND operation_id = ? AND owner_token = ? AND result IS NULL)';
  try {
    const results = await db.batch([
      maintenanceGuard(db, guard, auth.sql, auth.values(mutation.epoch)),
      db.prepare(`INSERT INTO sync_mutation_receipts (workspace_id, epoch, operation_id, fingerprint, owner_token)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, epoch, operation_id) DO NOTHING`).bind(...receiptValues, fingerprint, owner),
      db.prepare(`UPDATE contacts SET photo_url = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND public_id = ?
        AND photo_url IS ? AND ? = 1 AND ${owned}
        AND COALESCE((SELECT canonical_public_id FROM contact_merge_aliases WHERE workspace_id = ? AND public_id = ?), ?) = public_id`)
        .bind(mutation.photo, actor.workspaceId, canonicalId, row?.photo_url ?? null,
          row && digest(row.photo_url) === mutation.base_digest ? 1 : 0, ...receiptValues, owner, actor.workspaceId, mutation.contact_id, mutation.contact_id),
      db.prepare(`UPDATE sync_mutation_receipts SET result = json_object('version', 1, 'operation_id', operation_id,
        'status', CASE WHEN changes() > 0 THEN 'applied' ELSE 'conflict' END, 'transfer', json((SELECT
          json_object('version', 1, 'epoch', ?, 'contact_id', c.public_id, 'revision', r.revision, 'photo', c.photo_url, 'digest', NULL)
          FROM contacts c JOIN sync_contact_records r ON r.workspace_id = c.workspace_id AND r.public_id = c.public_id
          AND r.deleted_at IS NULL WHERE c.workspace_id = ? AND c.public_id = COALESCE(
            (SELECT canonical_public_id FROM contact_merge_aliases WHERE workspace_id = ? AND public_id = ?), ?))))
        WHERE workspace_id = ? AND epoch = ? AND operation_id = ? AND owner_token = ? AND result IS NULL`)
        .bind(mutation.epoch, actor.workspaceId, actor.workspaceId, mutation.contact_id, mutation.contact_id, ...receiptValues, owner),
      query, removeGuard(db, guard),
    ]);
    return acknowledge(results[4].results[0] as PhotoReceipt, fingerprint);
  } catch (error) {
    await assertWriteAccount(db, actor, mutation.epoch);
    throw error;
  }
}

/** Reads bytes separately from the bounded v1–v4 contact journal. */
export async function downloadContactPhoto(db: DB, actor: DeviceActor, contactId: string, epoch: string, revision: number) {
  if (!isSyncUuid(contactId) || !isSyncUuid(epoch) || !Number.isSafeInteger(revision) || revision < 1) {
    throw new ContactPhotoError('A current person identity and sync position are required.', 400, 'invalid_photo_request');
  }
  const now = new Date().toISOString();
  const session = actor.authMethod === 'device' ? `AND EXISTS (SELECT 1 FROM device_sessions d
    WHERE d.id = ? AND d.workspace_id = w.id AND d.user_id = m.user_id AND d.revoked_at IS NULL AND d.expires_at > ?)` : '';
  const results = await db.batch([
    db.prepare(`SELECT w.lifecycle, s.epoch, s.paused FROM workspaces w
      JOIN workspace_members m ON m.workspace_id = w.id
      LEFT JOIN workspace_sync_state s ON s.workspace_id = w.id
      WHERE w.id = ? AND m.user_id = ? ${session}`)
      .bind(actor.workspaceId, actor.userId, ...(actor.authMethod === 'device' ? [actor.deviceId ?? '', now] : [])),
    db.prepare(`SELECT c.photo_url, r.revision FROM contacts c JOIN sync_contact_records r
      ON r.workspace_id = c.workspace_id AND r.public_id = c.public_id AND r.deleted_at IS NULL
      WHERE c.workspace_id = ? AND c.public_id = ?`).bind(actor.workspaceId, contactId),
  ]);
  const state = results[0].results[0] as { lifecycle: string; epoch: string | null; paused: number | null } | undefined;
  if (!state) throw new ContactPhotoError('This account or phone session is no longer valid.', 401, 'unauthorized');
  if (state.lifecycle !== 'active' || state.paused) throw new ContactPhotoError('Account recovery is in progress. Retry the photo later.', 423, 'maintenance');
  if (!state.epoch) throw new ContactPhotoError('Workspace sync is unavailable.', 503, 'unavailable');
  if (state.epoch !== epoch) throw new ContactPhotoError('Account data was restored. Sync before downloading this photo.', 409, 'epoch_changed');
  const row = results[1].results[0] as { photo_url: string | null; revision: number } | undefined;
  if (!row) throw new ContactPhotoError('This person is no longer available. Sync before retrying.', 404, 'person_missing');
  if (row.revision !== revision) throw new ContactPhotoError('This person changed. Sync before downloading the photo.', 409, 'photo_changed');
  if (row.photo_url !== null && !isEmbeddedContactPhoto(row.photo_url)) {
    throw new ContactPhotoError('This saved photo uses an unsupported format. Your original photo is unchanged.', 409, 'photo_unavailable');
  }
  return { version: 1 as const, epoch, contact_id: contactId, revision,
    photo: row.photo_url, digest: row.photo_url === null ? null : createHash('sha256').update(row.photo_url).digest('hex') };
}

export async function handleContactPhotos(request: Request, actor: DeviceActor, path: string[]) {
  try {
    if (path.length !== 3 || path[0] !== 'v1' || path[1] !== 'contact-photos' || !isSyncUuid(path[2])) return json({ error: 'Photo route not found.' }, 404);
    if (request.method === 'POST') {
      if (new URL(request.url).search) return json({ error: 'Photo changes do not accept query parameters.' }, 400);
      let mutation: ContactPhotoMutation;
      const body = await readJsonBody(request, { maximumBytes: MAX_CONTACT_PHOTO_RESPONSE_BYTES });
      try { mutation = readContactPhotoMutation(body); }
      catch { return json({ error: 'Invalid photo change.', code: 'invalid_photo_request' }, 400); }
      if (mutation.contact_id !== path[2]) return json({ error: 'The photo change belongs to another person.' }, 400);
      return json(await uploadContactPhoto(getCloudflareContext().env.DB, actor, mutation));
    }
    if (request.method !== 'GET') return json({ error: 'Use GET to download or POST to save a contact photo.' }, 405);
    const url = new URL(request.url), epoch = url.searchParams.get('epoch'), rawRevision = url.searchParams.get('revision');
    if (!isSyncUuid(epoch) || !rawRevision || !/^[1-9][0-9]*$/u.test(rawRevision)
      || Array.from(url.searchParams.keys()).some((key) => !['epoch', 'revision'].includes(key))
      || url.searchParams.getAll('epoch').length !== 1 || url.searchParams.getAll('revision').length !== 1) {
      return json({ error: 'A current person identity and sync position are required.', code: 'invalid_photo_request' }, 400);
    }
    return json(await downloadContactPhoto(getCloudflareContext().env.DB, actor, path[2], epoch, Number(rawRevision)));
  } catch (error) {
    if (error instanceof ContactPhotoError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
    return json({ error: 'The photo result is unconfirmed. Keep your saved photo and retry.', code: 'unavailable' }, 503);
  }
}
