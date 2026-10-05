export async function GET() {
  return Response.json({ error: 'Contact photo downloads require a Cloudflare-backed Everclose account.', code: 'cloud_required' },
    { status: 501, headers: { 'Cache-Control': 'private, no-store' } });
}
