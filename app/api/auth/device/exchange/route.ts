import { getCloudflareContext } from '@opennextjs/cloudflare';
import { isGoogleAuthEnabled } from '@/lib/cloud/auth';
import { deviceErrorResponse, exchangeDeviceCode } from '@/lib/cloud/device-api';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  if (!isGoogleAuthEnabled()) return Response.json({ error: 'Cloud phone sign-in is unavailable.' }, { status: 404 });
  try { return await exchangeDeviceCode(request, getCloudflareContext().env.DB); }
  catch (error) { return deviceErrorResponse(error); }
}
