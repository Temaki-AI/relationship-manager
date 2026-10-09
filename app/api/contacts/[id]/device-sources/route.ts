import db from '@/lib/db';
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[1-9]\d{0,14}$/u.test(id) || !db.prepare('SELECT id FROM contacts WHERE id = ?').get(Number(id))) return Response.json({ error: 'Person not found.' }, { status: 404 });
  return Response.json({ epoch: null, contact_id: null, links: [] }, { headers: { 'Cache-Control': 'no-store' } });
}
