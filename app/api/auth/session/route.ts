import { NextResponse } from 'next/server';
import { authenticateRequest, getAuthConfiguration } from '@/lib/auth';

export async function GET(request: Request) {
  const configuration = getAuthConfiguration();

  if (configuration.mode === 'disabled') {
    return NextResponse.json({ authenticated: true, mode: 'disabled' });
  }

  if (configuration.mode === 'misconfigured') {
    return NextResponse.json(
      { authenticated: false, mode: 'misconfigured', error: configuration.reason },
      { status: 503 }
    );
  }

  const authenticatedBy = await authenticateRequest(request.headers, configuration);
  return NextResponse.json({
    authenticated: Boolean(authenticatedBy),
    mode: 'enabled',
    authenticatedBy,
  });
}
