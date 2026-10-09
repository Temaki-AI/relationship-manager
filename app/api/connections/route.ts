// Cloud mode rewrites this route to the authenticated provider handler.
export async function GET() {
  return Response.json({ mode: 'local', configured: false, epoch: null, connections: [], automatic_sync: false }, { headers: { 'Cache-Control': 'no-store' } });
}
