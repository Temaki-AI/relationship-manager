import type { Contact } from './db.ts';
import { escapeCSVField } from './csv.ts';

export const CONTACT_CSV_HEADERS = [
  'Name',
  'Nickname',
  'Email',
  'Phone',
  'Photo URL',
  'Birthday',
  'Birthday Alert (days before)',
  'How We Met',
  'Tags',
  'Notes',
  'Gift Ideas',
  'Last Contacted',
  'Contact Frequency (days)',
  'Custom Fields',
  'Created At',
] as const;

export function serializeContactToCSVRow(contact: Contact): string {
  return [
    contact.name,
    contact.nickname || '',
    contact.email || '',
    contact.phone || '',
    contact.photo_url || '',
    contact.birthday || '',
    contact.birthday_reminder_days.toString(),
    contact.how_we_met || '',
    contact.tags || '',
    contact.notes || '',
    contact.gift_ideas || '',
    contact.last_contacted || '',
    contact.contact_frequency.toString(),
    contact.custom_fields || '',
    contact.created_at,
  ].map(escapeCSVField).join(',');
}

type TextExportStreamOptions<T> = {
  prefix?: string;
  separator: string;
  suffix?: string;
  serialize: (value: T) => string;
  onError?: (error: unknown) => void;
};

export function createTextExportStream<T>(
  values: Iterator<T>,
  options: TextExportStreamOptions<T>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let prefixPending = Boolean(options.prefix);
  let contentWritten = Boolean(options.prefix);
  let finished = false;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (finished) return;

      try {
        if (prefixPending) {
          prefixPending = false;
          controller.enqueue(encoder.encode(options.prefix));
          return;
        }

        const next = values.next();
        if (!next.done) {
          const separator = contentWritten ? options.separator : '';
          contentWritten = true;
          controller.enqueue(encoder.encode(`${separator}${options.serialize(next.value)}`));
          return;
        }

        finished = true;
        if (options.suffix) controller.enqueue(encoder.encode(options.suffix));
        controller.close();
      } catch (error) {
        finished = true;
        options.onError?.(error);
        controller.error(error);
      }
    },
    cancel() {
      finished = true;
      values.return?.();
    },
  });
}
