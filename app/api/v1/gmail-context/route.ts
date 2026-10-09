const unavailable = () => Response.json({ error: 'Reviewed Gmail context requires the hosted Google account.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } });
export const GET = unavailable;
export const POST = unavailable;
export const DELETE = unavailable;
export const PATCH = unavailable;
export const PUT = unavailable;
