export async function DELETE() {
  return Response.json({ error: 'Google source management requires the cloud service.' }, { status: 501 });
}

export const PATCH = DELETE;
