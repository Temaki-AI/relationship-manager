import { NextResponse } from 'next/server';
import db from '@/lib/db';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    const interactions = db.prepare(
      'SELECT * FROM interactions WHERE contact_id = ? ORDER BY date DESC'
    ).all(id);

    return NextResponse.json({ contact, interactions });
  } catch (error) {
    console.error('GET /api/contacts/[id] error:', error);
    return NextResponse.json({ error: 'Failed to fetch contact' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const updates: string[] = [];
    const values: any[] = [];

    Object.entries(body).forEach(([key, value]) => {
      if (key !== 'id' && key !== 'created_at') {
        updates.push(`${key} = ?`);
        if (key === 'tags' || key === 'gift_ideas') {
          values.push(value ? JSON.stringify(value) : null);
        } else {
          values.push(value === undefined ? null : value);
        }
      }
    });

    updates.push('updated_at = CURRENT_TIMESTAMP');

    if (updates.length > 0) {
      values.push(id);
      const stmt = db.prepare(`
        UPDATE contacts 
        SET ${updates.join(', ')}
        WHERE id = ?
      `);
      stmt.run(...values);
    }

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);

    return NextResponse.json({ contact });
  } catch (error) {
    console.error('PATCH /api/contacts/[id] error:', error);
    return NextResponse.json({ error: 'Failed to update contact' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    
    const stmt = db.prepare('DELETE FROM contacts WHERE id = ?');
    stmt.run(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/contacts/[id] error:', error);
    return NextResponse.json({ error: 'Failed to delete contact' }, { status: 500 });
  }
}
