const unavailable = () => Response.json({ error: 'Plan publishing requires the cloud service.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } });
export const GET = unavailable;
export const POST = unavailable;
export const DELETE = unavailable;
