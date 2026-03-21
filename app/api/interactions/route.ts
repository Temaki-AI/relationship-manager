import { NextResponse } from 'next/server';
import db from '@/lib/db';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { contact_id, date, type, summary, notes } = body;

    if (!contact_id || !date || !type) {
      return NextResponse.json(
        { error: 'contact_id, date, and type are required' },
        { status: 400 }
      );
    }

    // Insert interaction
    const stmt = db.prepare(`
      INSERT INTO interactions (contact_id, date, type, summary, notes)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      contact_id,
      date,
      type,
      summary || null,
      notes || null
    );

    // Update last_contacted on contact
    const updateContact = db.prepare(`
      UPDATE contacts 
      SET last_contacted = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    updateContact.run(date, contact_id);

    const interaction = db.prepare(
      'SELECT * FROM interactions WHERE id = ?'
    ).get(result.lastInsertRowid);

    return NextResponse.json({ interaction }, { status: 201 });
  } catch (error) {
    console.error('POST /api/interactions error:', error);
    return NextResponse.json(
      { error: 'Failed to create interaction' },
      { status: 500 }
    );
  }
}
