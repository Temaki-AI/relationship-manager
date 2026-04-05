import { NextResponse } from 'next/server';
import db from '@/lib/db';

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

export async function GET() {
  try {
    const groups = db
      .prepare(`
        SELECT g.*, COUNT(cgm.contact_id) as member_count
        FROM contact_groups g
        LEFT JOIN contact_group_members cgm ON g.id = cgm.group_id
        GROUP BY g.id
        ORDER BY g.name
      `)
      .all();

    return NextResponse.json({ groups });
  } catch (error) {
    console.error('Failed to fetch groups:', error);
    return NextResponse.json({ error: 'Failed to fetch groups' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, color } = body;

    if (!name || !String(name).trim()) {
      return NextResponse.json({ error: 'Group name is required' }, { status: 400 });
    }

    const result = db
      .prepare('INSERT INTO contact_groups (name, color) VALUES (?, ?)')
      .run(String(name).trim(), color || null);

    const group = db
      .prepare('SELECT * FROM contact_groups WHERE id = ?')
      .get(result.lastInsertRowid);

    return NextResponse.json({ group });
  } catch (error) {
    console.error('Failed to create group:', error);
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: 'A group with that name already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to create group' }, { status: 500 });
  }
}
