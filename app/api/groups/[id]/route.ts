import { NextResponse } from 'next/server';
import db from '@/lib/db';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    
    const group = db.prepare('SELECT * FROM contact_groups WHERE id = ?').get(id);
    
    const members = db
      .prepare(`
        SELECT c.*
        FROM contacts c
        JOIN contact_group_members cgm ON c.id = cgm.contact_id
        WHERE cgm.group_id = ?
        ORDER BY c.name
      `)
      .all(id);

    return NextResponse.json({ group, members });
  } catch (error) {
    console.error('Failed to fetch group:', error);
    return NextResponse.json({ error: 'Failed to fetch group' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, color } = body;

    db.prepare('UPDATE contact_groups SET name = ?, color = ? WHERE id = ?').run(
      name,
      color || null,
      id
    );

    const group = db.prepare('SELECT * FROM contact_groups WHERE id = ?').get(id);
    return NextResponse.json({ group });
  } catch (error) {
    console.error('Failed to update group:', error);
    return NextResponse.json({ error: 'Failed to update group' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    db.prepare('DELETE FROM contact_groups WHERE id = ?').run(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete group:', error);
    return NextResponse.json({ error: 'Failed to delete group' }, { status: 500 });
  }
}
