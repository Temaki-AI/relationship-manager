import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { normalizeLinkedInImport, normalizeLinkedInUrl, type LinkedInImportPayload } from '@/lib/linkedin';

type ExistingContact = {
  id: number;
  name: string;
  email: string | null;
  custom_fields: string | null;
};

function hasMatchingLinkedInProfile(customFields: string | null, profileUrl: string): boolean {
  if (!customFields) return false;

  try {
    const parsed = JSON.parse(customFields) as {
      linkedin?: { profile_url?: string | null };
      social?: { linkedin?: string | null };
    };

    const normalizedTarget = normalizeLinkedInUrl(profileUrl);
    const stored1 = parsed.linkedin?.profile_url;
    const stored2 = parsed.social?.linkedin;

    return (
      (!!stored1 && normalizeLinkedInUrl(stored1) === normalizedTarget) ||
      (!!stored2 && normalizeLinkedInUrl(stored2) === normalizedTarget)
    );
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as LinkedInImportPayload;
    const normalized = normalizeLinkedInImport(payload);

    let existing: ExistingContact | undefined;

    if (normalized.email) {
      existing = db
        .prepare('SELECT id, name, email, custom_fields FROM contacts WHERE lower(email) = lower(?)')
        .get(normalized.email) as ExistingContact | undefined;
    }

    if (!existing && normalized.profile_url) {
      const contacts = db
        .prepare('SELECT id, name, email, custom_fields FROM contacts WHERE custom_fields IS NOT NULL')
        .all() as ExistingContact[];

      existing = contacts.find((contact) =>
        hasMatchingLinkedInProfile(contact.custom_fields, normalized.profile_url!)
      );
    }

    if (existing) {
      return NextResponse.json(
        {
          imported: false,
          duplicate: true,
          contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(existing.id),
        },
        { status: 200 }
      );
    }

    const result = db.prepare(`
      INSERT INTO contacts (
        name, email, phone, photo_url, how_we_met,
        tags, notes, custom_fields, contact_frequency
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.name,
      normalized.email,
      normalized.phone,
      normalized.photo_url,
      normalized.how_we_met,
      JSON.stringify(normalized.tags),
      normalized.notes,
      normalized.custom_fields,
      normalized.contact_frequency
    );

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(result.lastInsertRowid);

    return NextResponse.json({ imported: true, duplicate: false, contact }, { status: 201 });
  } catch (error) {
    console.error('LinkedIn import failed:', error);
    const message = error instanceof Error ? error.message : 'Failed to import LinkedIn contact';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
