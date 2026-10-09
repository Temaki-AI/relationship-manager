export async function POST() {
  return Response.json({ error: 'Shared iPhone sources require a Cloudflare-backed Everclose account.', code: 'cloud_required' }, { status: 501 });
}
