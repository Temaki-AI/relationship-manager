import { NextResponse } from 'next/server';
import db, { backupDirectory } from '@/lib/db';
import { normalizeLinkedInImport, normalizeLinkedInUrl, type LinkedInImportPayload } from '@/lib/linkedin';
import { normalizeContactCreateInput } from '@/lib/contact-input';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { AUTHENTICATED_BY_HEADER } from '@/lib/auth';
import { consumeScopedImportAttempt } from '@/lib/integration-protection';
import { getRequestId, logRouteError, logWarning } from '@/lib/observability';
import {
  DatabaseMaintenanceBusyError,
  withDatabaseMutationLock,
} from '@/lib/database-maintenance-lock';

type ExistingContact = {
  id: number;
  name: string;
  email: string | null;
  custom_fields: string | null;
};

class IntegrationImportProtectionError extends Error {
  constructor() {
    super('Integration import protection is temporarily unavailable.');
    this.name = 'IntegrationImportProtectionError';
  }
}

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
    const payload = await readJsonBody<LinkedInImportPayload>(request, {
      maximumBytes: 64 * 1024,
      sizeLimitMessage: 'LinkedIn import payload is too large',
    });
    const normalized = normalizeLinkedInImport(payload);
    const contactInput = normalizeContactCreateInput({
      name: normalized.name,
      email: normalized.email,
      phone: normalized.phone,
      photo_url: normalized.photo_url,
      how_we_met: normalized.how_we_met,
      tags: normalized.tags,
      notes: normalized.notes,
      custom_fields: JSON.parse(normalized.custom_fields),
      contact_frequency: normalized.contact_frequency,
    });

    const importContact = db.transaction(() => {
      let existing: ExistingContact | undefined;

      if (contactInput.email) {
        existing = db
          .prepare('SELECT id, name, email, custom_fields FROM contacts WHERE lower(email) = lower(?)')
          .get(contactInput.email) as ExistingContact | undefined;
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
        return {
          imported: false as const,
          duplicate: true as const,
          contact: { id: existing.id, name: existing.name },
        };
      }

      const result = db.prepare(`
        INSERT INTO contacts (
          name, email, phone, photo_url, how_we_met,
          tags, notes, custom_fields, contact_frequency
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        contactInput.name,
        contactInput.email,
        contactInput.phone,
        contactInput.photo_url,
        contactInput.how_we_met,
        contactInput.tags,
        contactInput.notes,
        contactInput.custom_fields,
        contactInput.contact_frequency
      );

      return {
        imported: true as const,
        duplicate: false as const,
        contact: { id: Number(result.lastInsertRowid), name: contactInput.name },
      };
    });
    const guarded = withDatabaseMutationLock(backupDirectory, () => {
      if (request.headers.get(AUTHENTICATED_BY_HEADER) === 'bearer') {
        let attempt;
        try {
          attempt = consumeScopedImportAttempt(db);
        } catch {
          throw new IntegrationImportProtectionError();
        }
        if (!attempt.allowed) return { kind: 'limited' as const, attempt };
      }
      return { kind: 'result' as const, result: importContact.immediate() };
    });
    if (guarded.kind === 'limited') {
      logWarning('integration.import_limited', {
        request_id: getRequestId(request.headers) || undefined,
        operation: 'linkedin_import',
        status_code: 429,
      });
      return NextResponse.json({
        error: 'The integration import limit has been reached. Try again later.',
        retryAfterSeconds: guarded.attempt.retryAfterSeconds,
      }, {
        status: 429,
        headers: { 'Retry-After': String(guarded.attempt.retryAfterSeconds) },
      });
    }
    return NextResponse.json(
      guarded.result,
      { status: guarded.result.imported ? 201 : 200 }
    );
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseMaintenanceBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof IntegrationImportProtectionError) {
      logRouteError(
        'integration.import_protection_failed',
        error,
        request,
        '/api/import/linkedin',
        503
      );
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    logRouteError('linkedin.import_failed', error, request, '/api/import/linkedin', 400);
    const message = error instanceof Error ? error.message : 'Failed to import LinkedIn contact';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
