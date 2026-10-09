export async function POST() {
  return Response.json({ error: 'Google Contacts downloads require the cloud service.' }, { status: 501, headers: { 'Cache-Control': 'no-store' } });
}
