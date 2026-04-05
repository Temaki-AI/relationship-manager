import { NextResponse } from 'next/server';
import db from '@/lib/db';

function normalizeContactFrequency(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 14;
  }
  return Math.floor(parsed);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search');
    const tag = searchParams.get('tag');

    let query = 'SELECT * FROM contacts';
    const conditions: string[] = [];
    const params: string[] = [];

    if (search) {
      conditions.push('(name LIKE ? OR email LIKE ? OR notes LIKE ?)');
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    if (tag) {
      conditions.push('tags LIKE ?');
      params.push(`%"${tag}"%`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY last_contacted DESC';

    const stmt = db.prepare(query);
    const contacts = stmt.all(...params);

    return NextResponse.json({ contacts });
  } catch (error) {
    console.error('GET /api/contacts error:', error);
    return NextResponse.json({ error: 'Failed to fetch contacts' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      name,
      email,
      phone,
      photo_url,
      birthday,
      how_we_met,
      tags,
      notes,
      gift_ideas,
      contact_frequency
    } = body;

    if (!name || !String(name).trim()) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    const stmt = db.prepare(`
      INSERT INTO contacts (
        name, email, phone, photo_url, birthday, how_we_met, 
        tags, notes, gift_ideas, contact_frequency
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      String(name).trim(),
      email || null,
      phone || null,
      photo_url || null,
      birthday || null,
      how_we_met || null,
      tags ? JSON.stringify(tags) : null,
      notes || null,
      gift_ideas ? JSON.stringify(gift_ideas) : null,
      normalizeContactFrequency(contact_frequency)
    );

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(result.lastInsertRowid);

    return NextResponse.json({ contact }, { status: 201 });
  } catch (error) {
    console.error('POST /api/contacts error:', error);
    return NextResponse.json({ error: 'Failed to create contact' }, { status: 500 });
  }
}
