export function PATCH() { return Response.json({ error: 'Automatic Gmail checks require the cloud service.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } }); }
