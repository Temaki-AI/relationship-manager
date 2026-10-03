import { readinessResponse } from '@/lib/health-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return readinessResponse(request, '/api/health');
}
