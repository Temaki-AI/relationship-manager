export function GET() { return Response.json({ error: 'Gmail correspondence requires the cloud service.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } }); }
