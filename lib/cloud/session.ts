import { eq } from 'drizzle-orm';
import { getCloudAuth, isGoogleAuthEnabled } from './auth';
import { getCloudDb } from './db';
import { workspaceMembers, workspaces } from './schema';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { DeviceSessionError, requireDeviceWorkspace } from './device-api';

export class CloudAuthenticationError extends Error {
  readonly status = 401;

  constructor(message = 'Authentication required.') {
    super(message);
    this.name = 'CloudAuthenticationError';
  }
}

export class CloudWorkspaceError extends Error {
  readonly status = 403;

  constructor(message = 'No workspace is available for this account.') {
    super(message);
    this.name = 'CloudWorkspaceError';
  }
}

export async function getCloudSession(headers: Headers) {
  if (!isGoogleAuthEnabled()) return null;
  return getCloudAuth().api.getSession({ headers });
}

export async function requireCloudWorkspace(headers: Headers, allowDevice = false) {
  if (allowDevice && headers.has('authorization')) {
    try {
      const identity = await requireDeviceWorkspace(getCloudflareContext().env.DB, headers);
      return { ...identity, session: null, authMethod: 'device' as const };
    } catch (error) {
      if (error instanceof DeviceSessionError) throw new CloudAuthenticationError(error.message);
      throw error;
    }
  }
  const session = await getCloudSession(headers);
  if (!session) throw new CloudAuthenticationError();

  const [membership] = await getCloudDb()
    .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role, lifecycle: workspaces.lifecycle })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, session.user.id))
    .limit(1);

  if (!membership) throw new CloudWorkspaceError();
  return {
    session,
    userId: session.user.id,
    workspaceId: membership.workspaceId,
    role: membership.role,
    lifecycle: membership.lifecycle,
    authMethod: 'web' as const,
    deviceId: undefined,
  };
}
