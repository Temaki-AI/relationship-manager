import { NextResponse } from 'next/server';
import db from '@/lib/db';

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
  }
  fields.push(current.trim());
  return fields;
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

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(l => l.trim());

    if (lines.length < 2) {
      return NextResponse.json({ error: 'CSV must have a header row and at least one data row' }, { status: 400 });
    }

    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
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
          const name = row.name || '';
          if (!name) {
            skipped++;
            continue;
          }

          // Parse tags: could be JSON array or comma-separated
          let tags: string | null = null;
          if (row.tags) {
            try {
              const parsed = JSON.parse(row.tags);
              tags = Array.isArray(parsed) ? JSON.stringify(parsed) : null;
            } catch {
              tags = JSON.stringify(row.tags.split(',').map((t: string) => t.trim()).filter(Boolean));
            }
          }

          // Parse gift ideas similarly
          let giftIdeas: string | null = null;
          if (row.gift_ideas) {
            try {
              const parsed = JSON.parse(row.gift_ideas);
              giftIdeas = Array.isArray(parsed) ? JSON.stringify(parsed) : null;
            } catch {
              giftIdeas = JSON.stringify(row.gift_ideas.split('\n').map((g: string) => g.trim()).filter(Boolean));
            }
          }

          const frequency = row.contact_frequency ? parseInt(row.contact_frequency) : 14;

          insert.run(
            name,
            row.email || null,
            row.phone || null,
            row.birthday || null,
            row.how_we_met || null,
            tags,
            row.notes || null,
            giftIdeas,
            row.last_contacted || null,
            isNaN(frequency) ? 14 : frequency,
          );
          imported++;
        } catch (err: any) {
          skipped++;
          errors.push(`Row "${row.name || '?'}": ${err.message}`);
        }
      }
    });

    const rows: Record<string, string>[] = [];
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
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
