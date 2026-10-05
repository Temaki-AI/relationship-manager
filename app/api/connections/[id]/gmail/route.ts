function unavailable() { return Response.json({ error: 'Gmail connections require the cloud service.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } }); }
export const GET = unavailable;
export const POST = unavailable;
