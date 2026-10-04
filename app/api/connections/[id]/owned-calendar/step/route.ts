export function POST() { return Response.json({ error: 'Google Calendar publishing requires the cloud service.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } }); }
