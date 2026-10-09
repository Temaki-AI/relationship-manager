export function POST() { return Response.json({ error: 'Plan publishing requires the cloud service.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } }); }
