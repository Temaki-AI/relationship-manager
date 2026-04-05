import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3100',
  'http://127.0.0.1:3100',
];

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
  if (extra) {
    return [
      ...DEFAULT_ALLOWED_ORIGINS,
      ...extra.split(',').map((origin) => origin.trim()).filter(Boolean),
    ];
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true; // same-origin requests have no Origin header
  if (origin.startsWith('chrome-extension://')) {
    const extensionId = origin.replace('chrome-extension://', '').replace(/\/$/, '');
    return getAllowedExtensionIds().includes(extensionId);
  }
  return getAllowedOrigins().includes(origin);
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin');
  const allowed = isOriginAllowed(origin);
  const corsOrigin = allowed && origin ? origin : '';

  if (origin && !allowed) {
    return new NextResponse(
      request.method === 'OPTIONS'
        ? null
        : JSON.stringify({ error: 'Origin not allowed' }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          Vary: 'Origin',
        },
      }
    );
  }

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        Vary: 'Origin',
      },
    });
  }

  const response = NextResponse.next();
  response.headers.set('Vary', 'Origin');

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
