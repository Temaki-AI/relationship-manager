function unavailable() { return Response.json({ error: 'Gmail downloads require the cloud service.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } }); }
export const PATCH = unavailable;
