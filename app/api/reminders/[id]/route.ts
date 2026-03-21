import { NextResponse } from 'next/server';
import db from '@/lib/db';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (body.completed) {
      db.prepare('UPDATE reminders SET completed_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    } else {
      const { title, notes, remind_at } = body;
      db.prepare(
        'UPDATE reminders SET title = ?, notes = ?, remind_at = ? WHERE id = ?'
      ).run(title, notes || null, remind_at, id);
    }

    const reminder = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
    return NextResponse.json({ reminder });
  } catch (error) {
    console.error('Failed to update reminder:', error);
    return NextResponse.json({ error: 'Failed to update reminder' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete reminder:', error);
    return NextResponse.json({ error: 'Failed to delete reminder' }, { status: 500 });
  }
}
