function unavailable() { return Response.json({ error: 'Saved calendar context requires the cloud service.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } }); }
export const GET = unavailable;
