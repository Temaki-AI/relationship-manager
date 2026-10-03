import { NextResponse } from 'next/server';
import { AUTH_COOKIE_NAME } from '@/lib/auth';
import { isRequestSecure, trustsProxyHeaders } from '@/lib/request-security';

export async function POST(request: Request) {
  const response = NextResponse.json({ authenticated: false });
  const secure = isRequestSecure({
    requestUrl: request.url,
    forwardedProto: request.headers.get('x-forwarded-proto'),
    trustProxy: trustsProxyHeaders(),
  });
  response.cookies.set(AUTH_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: 0,
    priority: 'high',
  });
  return response;
}
