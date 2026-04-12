import { NextResponse } from 'next/server';
import db, { type Contact, type Interaction, type RelationshipFact, type Reminder } from '@/lib/db';
import { buildRelationshipBrief, buildTimeline } from '@/lib/intelligence';

function normalizeContactFrequency(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 14;
  }
  return Math.floor(parsed);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Contact | undefined;
    
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    const interactions = db.prepare(
      'SELECT * FROM interactions WHERE contact_id = ? ORDER BY date DESC'
    ).all(id) as Interaction[];

    const reminders = db.prepare(
      'SELECT * FROM reminders WHERE contact_id = ? ORDER BY remind_at DESC'
    ).all(id) as Reminder[];

    const facts = db.prepare(
      'SELECT * FROM relationship_facts WHERE contact_id = ? ORDER BY COALESCE(last_verified_at, created_at) DESC'
    ).all(id) as RelationshipFact[];

    return NextResponse.json({
      contact,
      interactions,
      reminders,
      facts,
      brief: buildRelationshipBrief(contact, interactions, reminders, facts),
      timeline: buildTimeline(contact, interactions, reminders, facts),
    });
  } catch (error) {
    console.error('GET /api/contacts/[id] error:', error);
    return NextResponse.json({ error: 'Failed to fetch contact' }, { status: 500 });
  }
}

const ALLOWED_FIELDS = new Set([
  'name', 'email', 'phone', 'photo_url', 'birthday',
  'how_we_met', 'tags', 'notes', 'gift_ideas', 'custom_fields',
  'last_contacted', 'contact_frequency',
]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const updates: string[] = [];
    const values: unknown[] = [];

    Object.entries(body).forEach(([key, value]) => {
      if (!ALLOWED_FIELDS.has(key)) return;
      updates.push(`${key} = ?`);
      if (key === 'tags' || key === 'gift_ideas') {
        values.push(value ? JSON.stringify(value) : null);
      } else if (key === 'contact_frequency') {
        values.push(normalizeContactFrequency(value));
      } else {
        values.push(value === undefined ? null : value);
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
      const result = stmt.run(...values);
      if (result.changes === 0) {
        return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
      }
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
    const result = stmt.run(id);

    if (result.changes === 0) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/contacts/[id] error:', error);
    return NextResponse.json({ error: 'Failed to delete contact' }, { status: 500 });
  }
}
