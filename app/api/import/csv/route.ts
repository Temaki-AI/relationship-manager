import { NextResponse } from 'next/server';
import {
  CSVValidationError,
  MAX_CSV_IMPORT_ROWS,
  normalizeImportedFrequency,
  parseCSV,
  parseImportedGiftIdeasValue,
  parseImportedTagsValue,
} from '@/lib/csv';
import { getMaxCsvImportBytes, getMaxCsvImportMegabytes } from '@/lib/csv-config';
import { normalizeContactCreateInput, normalizeContactPatchInput } from '@/lib/contact-input';
import { getContactIdentityKeys, type ContactIdentity } from '@/lib/contact-import';
import db, { backupDirectory } from '@/lib/db';
import { MULTIPART_OVERHEAD_BYTES, readFormDataBody, RequestBodyError } from '@/lib/request-body';
import { logRouteError } from '@/lib/observability';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMutationLock,
} from '@/lib/database-maintenance-lock';

export async function POST(request: Request) {
  try {
    const maximumBytes = getMaxCsvImportBytes();
    const formData = await readFormDataBody(request, {
      maximumBytes: maximumBytes + MULTIPART_OVERHEAD_BYTES,
      sizeLimitMessage: `CSV uploads are limited to ${getMaxCsvImportMegabytes()} MB`,
    });
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > maximumBytes) {
      return NextResponse.json(
        { error: `CSV uploads are limited to ${getMaxCsvImportMegabytes()} MB` },
        { status: 413 }
      );
    }

    const text = await file.text();
    const records = parseCSV(text);

    if (records.length < 2) {
      return NextResponse.json({ error: 'CSV must have a header row and at least one data row' }, { status: 400 });
    }

    if (records.length - 1 > MAX_CSV_IMPORT_ROWS) {
      return NextResponse.json(
        { error: `CSV imports are limited to ${MAX_CSV_IMPORT_ROWS.toLocaleString()} contacts at a time` },
        { status: 413 }
      );
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
    let duplicates = 0;
    const errors: string[] = [];

    const insertMany = db.transaction((rows: Record<string, string>[]) => {
      const existing = db.prepare('SELECT name, email, phone, birthday, custom_fields, contact_methods FROM contacts')
        .all() as ContactIdentity[];
      const identities = new Set(existing.flatMap(getContactIdentityKeys));
      const insert = db.prepare(`
        INSERT INTO contacts (name, nickname, email, phone, photo_url, birthday, birthday_reminder_days, how_we_met, tags, notes, gift_ideas, custom_fields, last_contacted, contact_frequency, contact_methods)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of rows) {
        try {
          const name = row.name?.trim() || '';
          if (!name) {
            skipped++;
            continue;
          }

          const tags = parseImportedTagsValue(row.tags || '');
          const giftIdeas = parseImportedGiftIdeasValue(row.gift_ideas || '');
          const customFields: unknown = row.custom_fields ? JSON.parse(row.custom_fields) : null;
          const normalized = normalizeContactCreateInput({
            name,
            nickname: row.nickname || null,
            ...(!row.contact_methods || 'email' in row ? { email: row.email || null } : {}),
            ...(!row.contact_methods || 'phone' in row ? { phone: row.phone || null } : {}),
            photo_url: row.photo_url || null,
            birthday: row.birthday || null,
            birthday_reminder_days: row.birthday_reminder_days || undefined,
            how_we_met: row.how_we_met || null,
            tags: tags ? JSON.parse(tags) : [],
            notes: row.notes || null,
            gift_ideas: giftIdeas ? JSON.parse(giftIdeas) : [],
            custom_fields: customFields,
            contact_frequency: normalizeImportedFrequency(row.contact_frequency),
            ...(row.contact_methods ? { contact_methods: row.contact_methods } : {}),
          });
          const lastContacted = row.last_contacted
            ? normalizeContactPatchInput({ last_contacted: row.last_contacted }).last_contacted
            : null;
          const identityKeys = getContactIdentityKeys(normalized);
          if (identityKeys.some((key) => identities.has(key))) {
            duplicates++;
            skipped++;
            continue;
          }

          insert.run(
            normalized.name,
            normalized.nickname,
            normalized.email,
            normalized.phone,
            normalized.photo_url,
            normalized.birthday,
            normalized.birthday_reminder_days,
            normalized.how_we_met,
            normalized.tags,
            normalized.notes,
            normalized.gift_ideas,
            normalized.custom_fields,
            lastContacted,
            normalized.contact_frequency,
            normalized.contact_methods ?? 'null',
          );
          identityKeys.forEach((key) => identities.add(key));
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

    withDatabaseMutationLock(backupDirectory, () => insertMany.immediate(rows));

    return NextResponse.json({
      imported,
      skipped,
      duplicates,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof CSVValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logRouteError('csv.import_failed', error, request, '/api/import/csv');
    return NextResponse.json({ error: 'Failed to import CSV' }, { status: 500 });
  }
}

const HEADER_MAP: Record<string, string> = {
  'contact methods': 'contact_methods',
  'contact_methods': 'contact_methods',
  'name': 'name',
  'nickname': 'nickname',
  'email': 'email',
  'phone': 'phone',
  'photo url': 'photo_url',
  'photo_url': 'photo_url',
  'birthday': 'birthday',
  'birthday alert': 'birthday_reminder_days',
  'birthday alert (days before)': 'birthday_reminder_days',
  'birthday_reminder_days': 'birthday_reminder_days',
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
  'custom fields': 'custom_fields',
  'custom_fields': 'custom_fields',
};
