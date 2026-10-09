export async function PATCH() {
  return Response.json({ error: 'Automatic Google sync requires the cloud service.' }, { status: 501 });
}
