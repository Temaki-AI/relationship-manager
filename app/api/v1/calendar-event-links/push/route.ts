export async function POST() {
  return Response.json({ error: 'Shared meeting links require a Cloudflare-backed Everclose account.', code: 'cloud_required' }, { status: 501, headers: { 'Cache-Control': 'no-store' } });
}
