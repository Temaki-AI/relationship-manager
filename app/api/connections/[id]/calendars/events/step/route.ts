export function POST() { return Response.json({ error: 'Google Calendar event downloads require the cloud service.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } }); }
