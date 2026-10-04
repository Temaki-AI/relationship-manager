function unavailable() { return Response.json({ error: 'Google Calendar event downloads require the cloud service.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } }); }
export const GET = unavailable;
export const POST = unavailable;
export const DELETE = unavailable;
