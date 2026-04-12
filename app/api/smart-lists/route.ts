import { NextResponse } from 'next/server';
import db, { type Contact, type Interaction, type Reminder } from '@/lib/db';
import { buildSmartLists } from '@/lib/intelligence';

export async function GET() {
  try {
    const contacts = db.prepare('SELECT * FROM contacts ORDER BY updated_at DESC').all() as Contact[];
    const interactions = db.prepare('SELECT * FROM interactions ORDER BY date DESC').all() as Interaction[];
    const reminders = db.prepare('SELECT * FROM reminders ORDER BY remind_at ASC').all() as Reminder[];

    return NextResponse.json({
      smartLists: buildSmartLists(contacts, interactions, reminders),
    });
  } catch (error) {
    console.error('GET /api/smart-lists error:', error);
    return NextResponse.json({ error: 'Failed to fetch smart lists' }, { status: 500 });
  }
}
