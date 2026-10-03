import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import {
  AUTH_COOKIE_NAME,
  createSessionToken,
  getAuthConfiguration,
  verifyCredential,
} from '@/lib/auth';
import {
  clearLoginAttempts,
  consumeLoginAttempt,
  getLoginClientKey,
} from '@/lib/login-protection';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { getRequestId, logInfo, logRouteError, logWarning } from '@/lib/observability';
import { isRequestSecure, trustsProxyHeaders } from '@/lib/request-security';
import { withDatabaseMutationLock } from '@/lib/database-maintenance-lock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const configuration = getAuthConfiguration();

  if (configuration.mode === 'disabled') {
    return NextResponse.json({ authenticated: true, mode: 'disabled' });
  }

  if (configuration.mode === 'misconfigured') {
    return NextResponse.json(
      { error: 'Authentication is not configured securely.' },
      { status: 503 }
    );
  }

  let password: unknown;
  try {
    ({ password } = await readJsonBody<{ password?: unknown }>(request, {
      maximumBytes: 4 * 1024,
      sizeLimitMessage: 'Sign-in payload is too large.',
    }));
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  if (typeof password !== 'string') {
    return NextResponse.json({ error: 'Password is required.' }, { status: 400 });
  }

  const clientKey = getLoginClientKey(request.headers);
  let attempt;
  try {
    attempt = withDatabaseMutationLock(
      backupDirectory,
      () => consumeLoginAttempt(db, clientKey)
    );
  } catch (error) {
    logRouteError('auth.login_protection_failed', error, request, '/api/auth/login', 503);
    return NextResponse.json(
      { error: 'Sign-in protection is temporarily unavailable.' },
      { status: 503 }
    );
  }
  if (!attempt.allowed) {
    logWarning('auth.login_limited', {
      request_id: getRequestId(request.headers) || undefined,
      operation: 'login',
      status_code: 429,
    });
    return NextResponse.json(
      {
        error: 'Too many login attempts. Try again later.',
        retryAfterSeconds: attempt.retryAfterSeconds,
      },
      { status: 429, headers: { 'Retry-After': String(attempt.retryAfterSeconds) } }
    );
  }

  if (!await verifyCredential(password, configuration.password)) {
    return NextResponse.json({ error: 'Invalid password.' }, { status: 401 });
  }

  try {
    withDatabaseMutationLock(backupDirectory, () => clearLoginAttempts(db));
  } catch (error) {
    logRouteError('auth.login_reset_failed', error, request, '/api/auth/login', 503);
    return NextResponse.json(
      { error: 'Sign-in protection is temporarily unavailable.' },
      { status: 503 }
    );
  }
  const token = await createSessionToken(
    configuration.sessionSecret,
    configuration.password,
    Date.now(),
    configuration.sessionTtlSeconds
  );
  logInfo('auth.login_succeeded', {
    request_id: getRequestId(request.headers) || undefined,
    operation: 'login',
    status_code: 200,
  });
  const response = NextResponse.json({ authenticated: true, mode: 'enabled' });
  const secure = isRequestSecure({
    requestUrl: request.url,
    forwardedProto: request.headers.get('x-forwarded-proto'),
    trustProxy: trustsProxyHeaders(),
  });
  response.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: configuration.sessionTtlSeconds,
    priority: 'high',
  });
  return response;
}
