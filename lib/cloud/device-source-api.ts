import { createHash } from 'node:crypto';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { deviceSourceProjection, readDeviceSourceMutation } from '@/packages/domain/src/device-sources';
import { ProviderSourceError } from '@/packages/domain/src/provider-sources';
import { maintenanceGuard, removeGuard } from './recovery-storage';
import type { DeviceActor } from './device-api';

type DB = CloudflareEnv['DB'];
type StoredSource = Record<string, string | number>;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
class DeviceSourceError extends ProviderSourceError {
  constructor(message: string, status: number, readonly code: string) { super(message, status); }
}
function actorPredicate(actor: DeviceActor, now: string) {
  const membership = `EXISTS (SELECT 1 FROM workspace_members member JOIN workspaces w ON w.id = member.workspace_id
    WHERE member.workspace_id = ? AND member.user_id = ? AND w.lifecycle = 'active')`;
  const values: (string | number | null)[] = [actor.workspaceId, actor.userId];
  if (actor.authMethod === 'web') return { sql: membership, values };
  return { sql: `${membership} AND EXISTS (SELECT 1 FROM device_sessions WHERE id = ? AND workspace_id = ?
    AND user_id = ? AND revoked_at IS NULL AND expires_at > ?)`, values: [...values, actor.deviceId ?? '', actor.workspaceId, actor.userId, now] };
}
async function requireState(db: DB, actor: DeviceActor, epoch: string, now: string) {
  const authorization = actorPredicate(actor, now);
  if (!await db.prepare(`SELECT 1 WHERE ${authorization.sql}`).bind(...authorization.values).first()) throw new DeviceSourceError('This account or phone session is no longer valid.', 401, 'unauthorized');
  const state = await db.prepare('SELECT epoch, paused FROM workspace_sync_state WHERE workspace_id = ?').bind(actor.workspaceId).first<{ epoch: string; paused: number }>();
  if (!state || state.epoch !== epoch) throw new DeviceSourceError('Your account data was restored. Review this source before syncing.', 409, 'epoch_changed');
  if (state.paused) throw new DeviceSourceError('Account recovery is in progress. Source changes are retained on the phone.', 423, 'maintenance');
}

/** Device observations are user-authorized provenance; they never write CRM fields or authenticate a provider. */
export async function pushDeviceSource(db: DB, actor: DeviceActor, value: unknown) {
  const body = readDeviceSourceMutation(value), now = new Date().toISOString();
  if (actor.authMethod !== 'device' && body.action !== 'unlink') throw new DeviceSourceError('Choose and share a contact from your signed-in phone.', 403, 'device_required');
  await requireState(db, actor, body.epoch, now);
  const fingerprint = createHash('sha256').update(JSON.stringify({ kind: 'device-source', mutation: body })).digest('hex');
  const parent = await db.prepare(`SELECT id, public_id FROM contacts WHERE workspace_id = ? AND public_id = COALESCE(
    (SELECT canonical_public_id FROM contact_merge_aliases WHERE workspace_id = ? AND public_id = ?), ?)`)
    .bind(actor.workspaceId, actor.workspaceId, body.contact_id, body.contact_id).first<{ id: number; public_id: string }>();
  const existingReceipt = await db.prepare('SELECT fingerprint FROM sync_mutation_receipts WHERE workspace_id = ? AND epoch = ? AND operation_id = ?')
    .bind(actor.workspaceId, body.epoch, body.operation_id).first<{ fingerprint: string }>();
  if (existingReceipt && existingReceipt.fingerprint !== fingerprint) throw new DeviceSourceError('This operation was already used for other changes.', 409, 'receipt_mismatch');
  if (!parent && !existingReceipt) throw new DeviceSourceError('The person is no longer available. Keep this source for review.', 409, 'person_missing');
  const token = crypto.randomUUID(), owner = crypto.randomUUID(), authorization = actorPredicate(actor, now);
  const receiptWhere = 'workspace_id = ? AND epoch = ? AND operation_id = ?';
  const receiptValues = [actor.workspaceId, body.epoch, body.operation_id];
  const owns = `EXISTS (SELECT 1 FROM sync_mutation_receipts WHERE ${receiptWhere} AND owner_token = ? AND result IS NULL)`;
  const ownsValues = [...receiptValues, owner];
  const parentPredicate = 'EXISTS (SELECT 1 FROM contacts WHERE workspace_id = ? AND id = ? AND public_id = ?)';
  let sourcePredicate: string, sourceValues: (string | number | null)[];
  if (body.expected_revision === null) {
    sourcePredicate = `NOT EXISTS (SELECT 1 FROM contact_device_links WHERE workspace_id = ? AND (public_id = ? OR installation_id = ? AND external_id = ?))
      AND NOT EXISTS (SELECT 1 FROM sync_mutation_receipts WHERE workspace_id = ? AND epoch = ?
        AND json_extract(result, '$.kind') = 'device-source' AND json_extract(result, '$.action') = 'publish' AND json_extract(result, '$.source_id') = ?)`;
    sourceValues = [actor.workspaceId, body.source_id, body.installation_id, body.external_id, actor.workspaceId, body.epoch, body.source_id];
  } else {
    sourcePredicate = `EXISTS (SELECT 1 FROM contact_device_links WHERE workspace_id = ? AND public_id = ? AND contact_id = ?
      AND installation_id = ? AND external_id = ? AND revision = ? ${body.action === 'publish' ? 'AND original_facts IS ?' : ''})`;
    sourceValues = [actor.workspaceId, body.source_id, parent?.id ?? -1, body.installation_id, body.external_id, body.expected_revision,
      ...(body.action === 'publish' ? [body.original_facts!] : [])];
  }
  const fence = `${authorization.sql} AND EXISTS (SELECT 1 FROM workspace_sync_state WHERE workspace_id = ? AND epoch = ? AND paused = 0)
    AND (EXISTS (SELECT 1 FROM sync_mutation_receipts WHERE ${receiptWhere} AND fingerprint = ?)
      OR (${parentPredicate} AND ${sourcePredicate}))`;
  const statements = [maintenanceGuard(db, token, fence, [...authorization.values, actor.workspaceId, body.epoch, ...receiptValues, fingerprint,
    actor.workspaceId, parent?.id ?? -1, parent?.public_id ?? '', ...sourceValues]),
  db.prepare(`INSERT INTO sync_mutation_receipts (workspace_id, epoch, operation_id, fingerprint, owner_token)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(...receiptValues, fingerprint, owner)];
  if (body.action === 'unlink') {
    statements.push(db.prepare(`DELETE FROM contact_device_links WHERE workspace_id = ? AND public_id = ? AND ${owns}`)
      .bind(actor.workspaceId, body.source_id, ...ownsValues));
  } else if (body.expected_revision === null) {
    statements.push(db.prepare(`INSERT INTO contact_device_links
      (public_id, workspace_id, contact_id, installation_id, external_id, original_facts, observed_facts, applied_fields, observed_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${owns}`).bind(body.source_id, actor.workspaceId, parent?.id ?? -1,
      body.installation_id, body.external_id, body.original_facts!, body.observed_facts!, body.applied_fields!, body.observed_at!, now, now, ...ownsValues));
  } else {
    statements.push(db.prepare(`UPDATE contact_device_links SET observed_facts = ?, applied_fields = ?, revision = revision + 1, observed_at = ?, updated_at = ?
      WHERE workspace_id = ? AND public_id = ? AND ${owns}`).bind(body.observed_facts!, body.applied_fields!, body.observed_at!, now, actor.workspaceId, body.source_id, ...ownsValues));
  }
  statements.push(db.prepare(`UPDATE sync_mutation_receipts SET result = ? WHERE ${receiptWhere} AND owner_token = ? AND result IS NULL`)
    .bind(JSON.stringify({ kind: 'device-source', action: body.action, source_id: body.source_id, contact_id: parent?.public_id ?? body.contact_id }), ...ownsValues),
  db.prepare(`SELECT fingerprint, result FROM sync_mutation_receipts WHERE ${receiptWhere}`).bind(...receiptValues),
  db.prepare(`SELECT link.*, c.public_id AS person_public_id FROM contact_device_links link JOIN contacts c
    ON c.workspace_id = link.workspace_id AND c.id = link.contact_id WHERE link.workspace_id = ? AND link.public_id = ?`).bind(actor.workspaceId, body.source_id), removeGuard(db, token));
  try {
    const results = await db.batch(statements), receipt = results.at(-3)!.results[0] as { fingerprint: string; result: string };
    if (!receipt || receipt.fingerprint !== fingerprint) throw new DeviceSourceError('This operation changed. Keep it for review.', 409, 'receipt_mismatch');
    const source = results.at(-2)!.results[0] as StoredSource | undefined;
    if (body.action === 'publish' && !source) throw new DeviceSourceError('The saved source or person was removed. It was not recreated.', 409, 'source_missing');
    return { operation_id: body.operation_id, epoch: body.epoch, action: body.action, contact_id: source ? String(source.person_public_id) : JSON.parse(receipt.result).contact_id,
      source: body.action === 'publish' ? deviceSourceProjection(source!) : null };
  } catch (error) {
    if (String(error).includes('CLOUD_RECOVERY_CONFLICT')) { await requireState(db, actor, body.epoch, now); throw new DeviceSourceError('This source, person or revision changed. Keep your choices and review the latest details.', 409, 'source_changed'); }
    if (/DEVICE_SOURCE_LIMIT|CONTACT_SYNC_LIMIT|(?:PROVIDER|SOURCE)_LINK_LIMIT/u.test(String(error))) throw new DeviceSourceError('This person has reached the saved-source size limit. No source details were changed.', 413, 'source_capacity');
    throw error;
  }
}

export async function handleDeviceSources(request: Request, actor: DeviceActor, path: string[]) {
  try {
    const env = getCloudflareContext().env;
    if (path.join('/') === 'v1/device-sources/push' && request.method === 'POST') {
      if (actor.authMethod === 'web' && request.headers.get('origin') !== new URL(env.BETTER_AUTH_URL).origin) throw new DeviceSourceError('Change this source from the Everclose app.', 403, 'origin_required');
      const body = await readJsonBody(request, { maximumBytes: 192 * 1024 });
      return json(await pushDeviceSource(env.DB, actor, body));
    }
    if (path[0] === 'contacts' && /^[1-9]\d{0,14}$/u.test(path[1]) && path[2] === 'device-sources' && path.length === 3 && request.method === 'GET') {
      const contact = await env.DB.prepare('SELECT public_id FROM contacts WHERE workspace_id = ? AND id = ?').bind(actor.workspaceId, Number(path[1])).first<{ public_id: string }>();
      if (!contact) return json({ error: 'Person not found.' }, 404);
      const state = await env.DB.prepare('SELECT epoch FROM workspace_sync_state WHERE workspace_id = ?').bind(actor.workspaceId).first<{ epoch: string }>();
      const sources = (await env.DB.prepare('SELECT * FROM contact_device_links WHERE workspace_id = ? AND contact_id = ? ORDER BY id').bind(actor.workspaceId, Number(path[1])).all<StoredSource>()).results;
      return json({ epoch: state?.epoch, contact_id: contact.public_id, links: sources.map(deviceSourceProjection) });
    }
    return json({ error: 'Source route not found.' }, 404);
  } catch (error) {
    if (error instanceof ProviderSourceError || error instanceof RequestBodyError) return json({ error: error.message, code: error instanceof DeviceSourceError ? error.code : 'invalid_source' }, error.status);
    console.error('cloud.device_source.failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    return json({ error: 'Unable to save source details. Keep this operation and try again.', code: 'source_unavailable' }, 503);
  }
}
