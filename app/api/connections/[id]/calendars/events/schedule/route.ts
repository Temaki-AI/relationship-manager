export async function PATCH() {
  return Response.json({ error: 'Automatic Google Calendar downloads require the cloud service.' }, { status: 501 });
}
