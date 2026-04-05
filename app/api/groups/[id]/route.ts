import { NextResponse } from 'next/server';
import db from '@/lib/db';

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    
    const group = db.prepare('SELECT * FROM contact_groups WHERE id = ?').get(id);

    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }
    
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

    if (!name || !String(name).trim()) {
      return NextResponse.json({ error: 'Group name is required' }, { status: 400 });
    }

    const result = db.prepare('UPDATE contact_groups SET name = ?, color = ? WHERE id = ?').run(
      String(name).trim(),
      color || null,
      id
    );

    if (result.changes === 0) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    const group = db.prepare('SELECT * FROM contact_groups WHERE id = ?').get(id);
    return NextResponse.json({ group });
  } catch (error) {
    console.error('Failed to update group:', error);
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: 'A group with that name already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to update group' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = db.prepare('DELETE FROM contact_groups WHERE id = ?').run(id);

    if (result.changes === 0) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete group:', error);
    return NextResponse.json({ error: 'Failed to delete group' }, { status: 500 });
  }
}
