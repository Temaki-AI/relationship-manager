import { createHash } from 'node:crypto';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { isEmbeddedContactPhoto } from '@/packages/domain/src/contact-photo';
import { isSyncUuid } from '@/packages/domain/src/sync';
import type { DeviceActor } from './device-api';

type DB = CloudflareEnv['DB'];
class ContactPhotoError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
});

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
    if (request.method !== 'GET') return json({ error: 'Photo downloading supports GET only.' }, 405);
    const url = new URL(request.url), epoch = url.searchParams.get('epoch'), rawRevision = url.searchParams.get('revision');
    if (!isSyncUuid(epoch) || !rawRevision || !/^[1-9][0-9]*$/u.test(rawRevision)
      || Array.from(url.searchParams.keys()).some((key) => !['epoch', 'revision'].includes(key))
      || url.searchParams.getAll('epoch').length !== 1 || url.searchParams.getAll('revision').length !== 1) {
      return json({ error: 'A current person identity and sync position are required.', code: 'invalid_photo_request' }, 400);
    }
    return json(await downloadContactPhoto(getCloudflareContext().env.DB, actor, path[2], epoch, Number(rawRevision)));
  } catch (error) {
    if (error instanceof ContactPhotoError) return json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
}
