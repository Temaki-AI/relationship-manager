import { NextResponse } from 'next/server';
import db from '@/lib/db';

export async function GET() {
  try {
    const reminders = db
      .prepare(`
        SELECT r.*, c.name as contact_name
        FROM reminders r
        JOIN contacts c ON r.contact_id = c.id
        WHERE r.completed_at IS NULL
        ORDER BY r.remind_at ASC
      `)
      .all();

    return NextResponse.json({ reminders });
  } catch (error) {
    console.error('Failed to fetch reminders:', error);
    return NextResponse.json({ error: 'Failed to fetch reminders' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { contact_id, title, notes, remind_at } = body;

    if (contact_id) {
      const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(contact_id);
      if (!contact) {
        return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
      }
    }

    const result = db
      .prepare(
        'INSERT INTO reminders (contact_id, title, notes, remind_at) VALUES (?, ?, ?, ?)'
      )
      .run(contact_id, title, notes || null, remind_at);

    const reminder = db
      .prepare('SELECT * FROM reminders WHERE id = ?')
      .get(result.lastInsertRowid);

    return NextResponse.json({ reminder });
  } catch (error) {
    console.error('Failed to create reminder:', error);
    return NextResponse.json({ error: 'Failed to create reminder' }, { status: 500 });
  }
}
