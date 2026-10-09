import { createHash, randomBytes } from 'node:crypto';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { maintenanceGuard, removeGuard } from '@/lib/cloud/recovery-storage';
import { isSyncUuid } from '@/packages/domain/src/sync';
import {
  DEVICE_CALLBACK_URL, DEVICE_CODE_TTL_SECONDS, DEVICE_SESSION_TTL_SECONDS, DEVICE_TOKEN_PREFIX,
  isDeviceSecret, isDeviceState, isPkceVerifier, parseDeviceBearer, type DeviceIdentity,
} from '@/packages/domain/src/devices';

type DB = CloudflareEnv['DB'];
export type DeviceActor = {
  userId: string; workspaceId: string; lifecycle: string; authMethod: 'web' | 'device'; deviceId?: string;
};
type Authorization = {
  code_hash: string; challenge: string; state: string; user_id: string; workspace_id: string;
  device_name: string; expires_at: string; device_id: string | null;
};
export class DeviceSessionError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalidCode(): never { throw new DeviceSessionError('This phone sign-in has expired or is invalid. Start sign-in again.', 401); }

export async function requireDeviceWorkspace(db: DB, headers: Headers) {
  const token = parseDeviceBearer(headers.get('authorization'));
  if (!token) throw new DeviceSessionError('Authentication required.', 401);
  const current = await db.prepare(`SELECT device.id AS deviceId, device.user_id AS userId,
    device.workspace_id AS workspaceId, device.expires_at AS expiresAt, member.role,
    workspace.lifecycle, user.email, user.name FROM device_sessions device
    JOIN workspace_members member ON member.workspace_id = device.workspace_id AND member.user_id = device.user_id
    JOIN workspaces workspace ON workspace.id = device.workspace_id JOIN user ON user.id = device.user_id
    WHERE device.token_hash = ? AND device.revoked_at IS NULL AND device.expires_at > ?`)
    .bind(hash(token), new Date().toISOString()).first<DeviceIdentity & { role: string; lifecycle: string }>();
  if (!current) throw new DeviceSessionError('This phone session is no longer valid. Sign in again.', 401);
  return current;
}

export async function authorizeDevice(request: Request, actor: DeviceActor, db: DB) {
  if (actor.authMethod !== 'web') throw new DeviceSessionError('Approve a phone from your signed-in web session.', 403);
  if (actor.lifecycle !== 'active') throw new DeviceSessionError('Wait for workspace maintenance to finish before connecting a phone.', 423);
  const expectedOrigin = new URL(getCloudflareContext().env.BETTER_AUTH_URL).origin;
  if (request.headers.get('origin') !== expectedOrigin) throw new DeviceSessionError('Approve this phone from the Everclose website.', 403);
  const body = await readJsonBody(request, { maximumBytes: 4096 });
  if (!object(body) || !isDeviceSecret(body.challenge) || !isDeviceState(body.state)
    || typeof body.deviceName !== 'string' || !body.deviceName.trim() || body.deviceName.length > 80
    || Object.keys(body).some((key) => !['challenge', 'state', 'deviceName'].includes(key))) {
    throw new DeviceSessionError('The phone sign-in request is incomplete.', 400);
  }
  const now = new Date();
  const code = randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000).toISOString();
  const results = await db.batch([
    db.prepare(`DELETE FROM device_authorization_codes WHERE code_hash IN (
      SELECT code_hash FROM device_authorization_codes WHERE user_id = ? AND expires_at <= ? LIMIT 64)`)
      .bind(actor.userId, now.toISOString()),
    db.prepare(`INSERT INTO device_authorization_codes
      (code_hash, workspace_id, user_id, challenge, state, device_name, expires_at, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM workspace_members member
        JOIN workspaces workspace ON workspace.id = member.workspace_id
        WHERE member.workspace_id = ? AND member.user_id = ? AND workspace.lifecycle = 'active')
        AND (SELECT COUNT(*) FROM device_authorization_codes WHERE user_id = ? AND expires_at > ? AND device_id IS NULL) < 5`)
      .bind(hash(code), actor.workspaceId, actor.userId, body.challenge, body.state, body.deviceName.trim(), expires, now.toISOString(),
        actor.workspaceId, actor.userId, actor.userId, now.toISOString()),
  ]);
  if (!results[1].meta.changes) throw new DeviceSessionError('Too many pending phone requests, or the workspace changed. Wait a few minutes and try again.', 429);
  const callback = new URL(DEVICE_CALLBACK_URL);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', body.state);
  return json({ callback: callback.href, expiresAt: expires });
}

/** The phone supplies a freshly generated secret so a lost response can replay without storing a plaintext token. */
export async function exchangeDeviceCode(request: Request, db: DB) {
  const body = await readJsonBody(request, { maximumBytes: 4096 });
  if (!object(body) || !isDeviceSecret(body.code) || !isPkceVerifier(body.verifier) || !isDeviceState(body.state)
    || typeof body.token !== 'string' || !body.token.startsWith(DEVICE_TOKEN_PREFIX)
    || !isDeviceSecret(body.token.slice(DEVICE_TOKEN_PREFIX.length))
    || Object.keys(body).some((key) => !['code', 'verifier', 'state', 'token'].includes(key))) {
    throw new DeviceSessionError('The phone sign-in response is incomplete.', 400);
  }
  const now = new Date();
  const timestamp = now.toISOString();
  const codeHash = hash(body.code);
  const challenge = createHash('sha256').update(body.verifier).digest('base64url');
  const authorization = await db.prepare(`SELECT * FROM device_authorization_codes
    WHERE code_hash = ? AND challenge = ? AND state = ? AND expires_at > ?`)
    .bind(codeHash, challenge, body.state, timestamp).first<Authorization>();
  if (!authorization) return invalidCode();
  const tokenHash = hash(body.token);
  const guardToken = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + DEVICE_SESSION_TTL_SECONDS * 1000).toISOString();
  try {
    const results = await db.batch([
      maintenanceGuard(db, guardToken, `EXISTS (SELECT 1 FROM device_authorization_codes code
        JOIN workspace_members member ON member.workspace_id = code.workspace_id AND member.user_id = code.user_id
        JOIN workspaces workspace ON workspace.id = code.workspace_id
        WHERE code.code_hash = ? AND code.challenge = ? AND code.state = ? AND code.expires_at > ?
          AND workspace.lifecycle = 'active' AND (
            code.device_id IS NULL AND (SELECT COUNT(*) FROM device_sessions
              WHERE workspace_id = code.workspace_id AND user_id = code.user_id AND revoked_at IS NULL AND expires_at > ?) < 10
            OR EXISTS (SELECT 1 FROM device_sessions device WHERE device.id = code.device_id
              AND device.token_hash = ? AND device.user_id = code.user_id AND device.workspace_id = code.workspace_id
              AND device.revoked_at IS NULL AND device.expires_at > ?)))`,
      [codeHash, challenge, body.state, timestamp, timestamp, tokenHash, timestamp]),
      db.prepare(`UPDATE device_authorization_codes SET device_id = ?, consumed_at = ?
        WHERE code_hash = ? AND device_id IS NULL`).bind(deviceId, timestamp, codeHash),
      db.prepare(`INSERT INTO device_sessions (id, workspace_id, user_id, token_hash, device_name, expires_at, created_at)
        SELECT ?, workspace_id, user_id, ?, device_name, ?, ? FROM device_authorization_codes
        WHERE code_hash = ? AND device_id = ?`)
        .bind(deviceId, tokenHash, expiresAt, timestamp, codeHash, deviceId),
      db.prepare(`SELECT device.id AS deviceId, device.user_id AS userId, device.workspace_id AS workspaceId,
        device.expires_at AS expiresAt, user.email, user.name FROM device_sessions device
        JOIN device_authorization_codes code ON code.device_id = device.id JOIN user ON user.id = device.user_id
        WHERE code.code_hash = ? AND device.token_hash = ?`).bind(codeHash, tokenHash),
      removeGuard(db, guardToken),
    ]);
    const identity = results[3].results[0] as DeviceIdentity | undefined;
    if (!identity) return invalidCode();
    return json({ identity });
  } catch (error) {
    if (error instanceof Error && error.message.includes('CLOUD_RECOVERY_CONFLICT')) {
      throw new DeviceSessionError('This request changed, expired, or reached the ten-device limit. Review connected devices and start sign-in again.', 409);
    }
    throw error;
  }
}

export async function handleCloudDevices(request: Request, actor: DeviceActor, path: string[]) {
  const { DB } = getCloudflareContext().env;
  try {
    if (path.join('/') === 'v1/devices/authorize' && request.method === 'POST') return await authorizeDevice(request, actor, DB);
    if (path.join('/') === 'v1/devices/session') {
      if (actor.authMethod !== 'device' || !actor.deviceId) throw new DeviceSessionError('Use the session from this phone.', 400);
      if (request.method === 'GET') return json({ identity: await requireDeviceWorkspace(DB, request.headers) });
      if (request.method === 'DELETE') {
        await DB.prepare(`UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, ?)
          WHERE id = ? AND workspace_id = ? AND user_id = ?`)
          .bind(new Date().toISOString(), actor.deviceId, actor.workspaceId, actor.userId).run();
        return json({ success: true });
      }
    }
    if (actor.authMethod !== 'web') throw new DeviceSessionError('Manage connected phones from the website.', 403);
    if (path.length === 2 && request.method === 'GET') {
      const devices = await DB.prepare(`SELECT id, device_name, created_at, expires_at, revoked_at FROM device_sessions
        WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC, id LIMIT 100`).bind(actor.workspaceId, actor.userId).all();
      return json({ devices: devices.results });
    }
    if (path.length === 3 && isSyncUuid(path[2]) && request.method === 'DELETE') {
      const result = await DB.prepare(`UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ? AND workspace_id = ? AND user_id = ?`).bind(new Date().toISOString(), path[2], actor.workspaceId, actor.userId).run();
      if (!result.meta.changes) return json({ error: 'Device not found.' }, 404);
      return json({ success: true });
    }
    return json({ error: 'Method not allowed.' }, 405);
  } catch (error) { return deviceErrorResponse(error); }
}

export function deviceErrorResponse(error: unknown) {
  if (error instanceof DeviceSessionError || error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  console.error('cloud.device.failed', { errorName: error instanceof Error ? error.name : 'unknown' });
  return json({ error: 'Phone sign-in is temporarily unavailable. Try again.' }, 503);
}
