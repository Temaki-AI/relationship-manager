import { NextResponse } from 'next/server';
import {
  normalizeImportedFrequency,
  parseCSV,
  parseImportedGiftIdeasValue,
  parseImportedTagsValue,
} from '@/lib/csv';
import db from '@/lib/db';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const text = await file.text();
    const records = parseCSV(text);

    if (records.length < 2) {
      return NextResponse.json({ error: 'CSV must have a header row and at least one data row' }, { status: 400 });
    }

    const headers = records[0].map((header) => header.trim().toLowerCase());
    const columnMap: Record<number, string> = {};

    headers.forEach((header, idx) => {
      const field = HEADER_MAP[header];
      if (field) columnMap[idx] = field;
    });

    if (!Object.values(columnMap).includes('name')) {
      return NextResponse.json({ error: 'CSV must have a "Name" column' }, { status: 400 });
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    const insert = db.prepare(`
      INSERT INTO contacts (name, email, phone, birthday, how_we_met, tags, notes, gift_ideas, last_contacted, contact_frequency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((rows: Record<string, string>[]) => {
      for (const row of rows) {
        try {
          const name = row.name?.trim() || '';
          if (!name) {
            skipped++;
            continue;
          }

          insert.run(
            name,
            row.email || null,
            row.phone || null,
            row.birthday || null,
            row.how_we_met || null,
            parseImportedTagsValue(row.tags || ''),
            row.notes || null,
            parseImportedGiftIdeasValue(row.gift_ideas || ''),
            row.last_contacted || null,
            normalizeImportedFrequency(row.contact_frequency),
          );
          imported++;
        } catch (error) {
          skipped++;
          const message = error instanceof Error ? error.message : 'Unknown error';
          errors.push(`Row "${row.name || '?'}": ${message}`);
        }
      }
    });

    const rows: Record<string, string>[] = [];
    for (let i = 1; i < records.length; i++) {
      const values = records[i];
      const row: Record<string, string> = {};
      Object.entries(columnMap).forEach(([idx, field]) => {
        row[field] = values[Number(idx)] || '';
      });
      rows.push(row);
    }

    insertMany(rows);

    return NextResponse.json({
      imported,
      skipped,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    console.error('CSV import failed:', error);
    return NextResponse.json({ error: 'Failed to import CSV' }, { status: 500 });
  }
}

const HEADER_MAP: Record<string, string> = {
  'name': 'name',
  'email': 'email',
  'phone': 'phone',
  'birthday': 'birthday',
  'how we met': 'how_we_met',
  'how_we_met': 'how_we_met',
  'tags': 'tags',
  'notes': 'notes',
  'gift ideas': 'gift_ideas',
  'gift_ideas': 'gift_ideas',
  'last contacted': 'last_contacted',
  'last_contacted': 'last_contacted',
  'contact frequency': 'contact_frequency',
  'contact frequency (days)': 'contact_frequency',
  'contact_frequency': 'contact_frequency',
};
