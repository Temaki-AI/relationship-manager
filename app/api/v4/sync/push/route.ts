function unavailable() { return Response.json({ error: 'Version 4 sync requires the cloud service.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } }); }
export const POST = unavailable;
