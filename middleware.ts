import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3100',
  'http://127.0.0.1:3100',
];

function getAllowedOrigins(): string[] {
  const extra = process.env.CORS_ALLOWED_ORIGINS;
  if (extra) {
    return [...DEFAULT_ALLOWED_ORIGINS, ...extra.split(',').map(o => o.trim())];
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true; // same-origin requests have no Origin header
  return getAllowedOrigins().includes(origin);
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin');
  const allowed = isOriginAllowed(origin);
  const corsOrigin = allowed && origin ? origin : '';

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const response = NextResponse.next();

  if (corsOrigin) {
    response.headers.set('Access-Control-Allow-Origin', corsOrigin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  return response;
}

export const config = {
  matcher: '/api/:path*',
};
