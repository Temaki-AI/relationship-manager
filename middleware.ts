import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';
import { getCloudApiRewrite } from '@/lib/cloud/api-rewrite';
import { isNativeDeviceApiPath, parseDeviceBearer } from '@/packages/domain/src/devices';
import {
  AUTHENTICATED_BY_HEADER,
  authenticateRequest,
  getAuthConfiguration,
  isApiTokenPath,
} from '@/lib/auth';
import {
  buildContentSecurityPolicy,
  isPublicAppPath,
  isRequestOriginAllowed,
  isRequestSecure,
  trustsProxyHeaders,
} from '@/lib/request-security';

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3100',
  'http://127.0.0.1:3100',
];

function isGoogleAuthEnabled(): boolean {
  return process.env.AUTH_MODE === 'google';
}

function getAllowedExtensionIds(): string[] {
  const extra = process.env.CORS_ALLOWED_EXTENSION_IDS;
  if (!extra) return [];
  return extra
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function getAllowedOrigins(): string[] {
  const extra = process.env.CORS_ALLOWED_ORIGINS;
  const defaults = process.env.NODE_ENV === 'production' ? [] : DEFAULT_ALLOWED_ORIGINS;
  if (extra) {
    return [
      ...defaults,
      ...extra.split(',').map((origin) => origin.trim()).filter(Boolean),
    ];
  }
  return defaults;
}

function isHtmlNavigation(request: NextRequest): boolean {
  if (request.nextUrl.pathname.startsWith('/api/')) return false;
  const destination = request.headers.get('sec-fetch-dest')?.toLowerCase();
  const acceptedTypes = request.headers.get('accept')?.toLowerCase() || '';
  return destination === 'document' || acceptedTypes.includes('text/html');
}

function finalizeResponse(
  response: NextResponse,
  request: NextRequest,
  corsOrigin = '',
  trustProxy = false,
  contentSecurityPolicy = '',
  requestId = ''
): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  if (requestId) response.headers.set('X-Request-ID', requestId);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  response.headers.set('X-Permitted-Cross-Domain-Policies', 'none');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (request.nextUrl.pathname === '/sw.js') {
    response.headers.set('Service-Worker-Allowed', '/');
  }
  if (contentSecurityPolicy) {
    response.headers.set('Content-Security-Policy', contentSecurityPolicy);
  }

  if (
    process.env.NODE_ENV === 'production'
    && isRequestSecure({
      requestUrl: request.url,
      forwardedProto: request.headers.get('x-forwarded-proto'),
      trustProxy,
    })
  ) {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  if (request.nextUrl.pathname.startsWith('/api/')) {
    response.headers.set('Vary', 'Origin');
    if (corsOrigin) {
      response.headers.set('Access-Control-Allow-Origin', corsOrigin);
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
      response.headers.set('Access-Control-Expose-Headers', 'X-Request-ID, Retry-After, Idempotency-Replayed');
    }
  }

  return response;
}

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function middleware(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname.startsWith('/api/');
  const requestId = globalThis.crypto.randomUUID();
  const origin = request.headers.get('origin');
  const trustProxy = trustsProxyHeaders();
  const htmlNavigation = isHtmlNavigation(request);
  const nonce = htmlNavigation ? btoa(globalThis.crypto.randomUUID()) : '';
  const contentSecurityPolicy = htmlNavigation
    ? buildContentSecurityPolicy({
        nonce,
        development: process.env.NODE_ENV === 'development',
        upgradeInsecureRequests: process.env.NODE_ENV === 'production'
          && isRequestSecure({
            requestUrl: request.url,
            forwardedProto: request.headers.get('x-forwarded-proto'),
            trustProxy,
          }),
      })
    : '';
  const allowed = !isApiRequest || isRequestOriginAllowed({
    origin,
    requestUrl: request.url,
    host: request.headers.get('host'),
    forwardedHost: trustProxy ? request.headers.get('x-forwarded-host') : null,
    forwardedProto: trustProxy ? request.headers.get('x-forwarded-proto') : null,
    allowedOrigins: getAllowedOrigins(),
    allowedExtensionIds: getAllowedExtensionIds(),
  });
  const corsOrigin = allowed && origin ? origin : '';
  const finalize = (response: NextResponse, responseCorsOrigin = corsOrigin) => finalizeResponse(
    response,
    request,
    responseCorsOrigin,
    trustProxy,
    contentSecurityPolicy,
    requestId
  );

  if (isApiRequest && origin && !allowed) {
    return finalize(jsonError('Origin not allowed', 403), '');
  }

  if (isApiRequest && request.method === 'OPTIONS') {
    return finalize(new NextResponse(null, { status: 204 }));
  }

  const cloudAuthentication = isGoogleAuthEnabled();
  const publicPath = isPublicAppPath(request.nextUrl.pathname);
  const auth = cloudAuthentication ? null : getAuthConfiguration();
  let authenticatedBy: 'bearer' | 'session' | null = null;
  if (!publicPath) {
    if (cloudAuthentication) {
      const deviceCandidate = isNativeDeviceApiPath(request.nextUrl.pathname)
        && parseDeviceBearer(request.headers.get('authorization'));
      if (!deviceCandidate && !getSessionCookie(request.headers)) {
        if (isApiRequest) {
          return finalize(jsonError('Authentication required.', 401));
        }
        const loginUrl = new URL('/login', request.url);
        loginUrl.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
        return finalize(NextResponse.redirect(loginUrl), '');
      }
      authenticatedBy = deviceCandidate ? 'bearer' : 'session';
    } else if (auth?.mode === 'misconfigured') {
      const response = isApiRequest
        ? jsonError('Authentication is not configured securely.', 503)
        : new NextResponse('Everclose CRM authentication is not configured securely.', { status: 503 });
      return finalize(response);
    }

    if (auth?.mode === 'enabled') {
      authenticatedBy = await authenticateRequest(request.headers, auth, isApiRequest);
      if (!authenticatedBy) {
        if (isApiRequest) {
          const response = jsonError('Authentication required.', 401);
          response.headers.set('WWW-Authenticate', 'Bearer');
          return finalize(response);
        }

        const loginUrl = new URL('/login', request.url);
        loginUrl.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
        return finalize(NextResponse.redirect(loginUrl), '');
      }

      if (authenticatedBy === 'bearer' && !isApiTokenPath(request.nextUrl.pathname)) {
        return finalize(jsonError('This API token is not authorized for this endpoint.', 403));
      }
    }
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete('content-security-policy');
  requestHeaders.delete('x-nonce');
  requestHeaders.delete('x-request-id');
  requestHeaders.delete(AUTHENTICATED_BY_HEADER);
  requestHeaders.set('x-request-id', requestId);
  if (authenticatedBy) requestHeaders.set(AUTHENTICATED_BY_HEADER, authenticatedBy);
  if (contentSecurityPolicy) {
    requestHeaders.set('content-security-policy', contentSecurityPolicy);
    requestHeaders.set('x-nonce', nonce);
  }

  const cloudRewrite = cloudAuthentication ? getCloudApiRewrite(request.nextUrl.pathname) : null;
  if (cloudRewrite) {
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = cloudRewrite;
    return finalize(NextResponse.rewrite(rewriteUrl, { request: { headers: requestHeaders } }));
  }

  if (cloudAuthentication && isApiRequest && !publicPath) {
    return finalize(jsonError('This endpoint is not available in cloud mode.', 501));
  }

  return finalize(NextResponse.next({ request: { headers: requestHeaders } }));
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico|sitemap.xml).*)',
};
