import { NextResponse } from 'next/server';
import db from '@/lib/db';

function recalcLastContacted(contactId: number | string) {
  const row = db.prepare(
    'SELECT MAX(date) as max_date FROM interactions WHERE contact_id = ?'
  ).get(contactId) as { max_date: string | null } | undefined;

  db.prepare(
    'UPDATE contacts SET last_contacted = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(row?.max_date ?? null, contactId);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { date, type, summary, notes } = body;

    const existing = db.prepare('SELECT * FROM interactions WHERE id = ?').get(id) as
      | { contact_id: number } | undefined;

    if (!existing) {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
    }

    db.prepare(
      'UPDATE interactions SET date = ?, type = ?, summary = ?, notes = ? WHERE id = ?'
    ).run(date, type, summary || null, notes || null, id);

    recalcLastContacted(existing.contact_id);

    const interaction = db.prepare('SELECT * FROM interactions WHERE id = ?').get(id);
    return NextResponse.json({ interaction });
  } catch (error) {
    console.error('PATCH /api/interactions/[id] error:', error);
    return NextResponse.json({ error: 'Failed to update interaction' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const existing = db.prepare('SELECT * FROM interactions WHERE id = ?').get(id) as
      | { contact_id: number } | undefined;

    if (!existing) {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
    }

    db.prepare('DELETE FROM interactions WHERE id = ?').run(id);

    recalcLastContacted(existing.contact_id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/interactions/[id] error:', error);
    return NextResponse.json({ error: 'Failed to delete interaction' }, { status: 500 });
  }
}
