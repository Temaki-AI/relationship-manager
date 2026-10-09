function unavailable() { return Response.json({ error: 'Google Calendar event context requires the cloud service.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } }); }
export const POST = unavailable;
