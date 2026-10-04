import { normalizeContactCreateInput, normalizeDateField, type NormalizedContactInput } from './contact-input.ts';
import { parseCSV, parseImportedGiftIdeasValue, parseImportedTagsValue } from './csv.ts';
import { normalizeVCardContact, parseVCards } from './vcard.ts';

export const MAX_CLOUD_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_CLOUD_IMPORT_ROWS = 5000;
export type ImportContact = NormalizedContactInput & { last_contacted: string | null };
export type ImportPreviewRow = { row_number: number; name: string; email: string | null; phone: string | null; birthday: string | null; payload: string | null; state: 'pending' | 'invalid'; message: string | null };

const fields: Record<string, string> = {
  'contact methods': 'contact_methods', contact_methods: 'contact_methods',
  name: 'name', nickname: 'nickname', email: 'email', phone: 'phone', birthday: 'birthday',
  'birthday alert (days before)': 'birthday_reminder_days', 'birthday alert': 'birthday_reminder_days', birthday_reminder_days: 'birthday_reminder_days',
  'how we met': 'how_we_met', how_we_met: 'how_we_met', tags: 'tags', notes: 'notes',
  'gift ideas': 'gift_ideas', gift_ideas: 'gift_ideas', 'last contacted': 'last_contacted', last_contacted: 'last_contacted',
  'contact frequency (days)': 'contact_frequency', contact_frequency: 'contact_frequency',
  'custom fields': 'custom_fields', custom_fields: 'custom_fields', 'photo url': 'photo_url', photo_url: 'photo_url',
};

export function parseImportPreview(text: string, format: 'csv' | 'vcard', importedAt: string): ImportPreviewRow[] {
  let inputs: Array<{ label: string; read: () => ImportContact }>;
  if (format === 'vcard') {
    inputs = parseVCards(text).map((card) => ({ label: card.name || card.emails[0] || 'Unnamed contact', read: () => {
      const contact = normalizeVCardContact(card, importedAt);
      return { ...contact, last_contacted: normalizeDateField(contact.last_contacted, 'Last contacted') };
    } }));
  } else {
    const records = parseCSV(text);
    const headers = (records[0] || []).map((header) => fields[header.replace(/^\uFEFF/, '').trim().toLowerCase()]);
    if (!headers.includes('name')) throw new Error('CSV must include a Name column.');
    inputs = records.slice(1).map((values) => ({ label: values[headers.indexOf('name')] || 'Unnamed contact', read: () => {
      const row: Record<string, unknown> = {};
      headers.forEach((field, index) => { if (field) row[field] = values[index] || ''; });
      if (!row.contact_methods) delete row.contact_methods;
      const tags = parseImportedTagsValue(String(row.tags || ''));
      const gifts = parseImportedGiftIdeasValue(String(row.gift_ideas || ''));
      if (row.custom_fields) {
        try {
          const customFields = JSON.parse(String(row.custom_fields));
          if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) {
            throw new Error('Custom fields must be an object.');
          }
          row.custom_fields = customFields;
        } catch {
          throw new Error('Custom fields must contain a valid JSON object.');
        }
      }
      const normalized = normalizeContactCreateInput({ ...row, tags: tags ? JSON.parse(tags) : [], gift_ideas: gifts ? JSON.parse(gifts) : [],
        contact_frequency: row.contact_frequency || undefined, birthday_reminder_days: row.birthday_reminder_days || undefined });
      return { ...normalized, last_contacted: normalizeDateField(row.last_contacted, 'Last contacted') };
    } }));
  }
  if (!inputs.length) throw new Error('The file contains no contacts.');
  if (inputs.length > MAX_CLOUD_IMPORT_ROWS) throw new Error(`Import up to ${MAX_CLOUD_IMPORT_ROWS.toLocaleString()} contacts at a time.`);
  return inputs.map((input, index) => {
    try {
      const contact = input.read();
      return { row_number: index + 1, name: contact.name, email: contact.email, phone: contact.phone, birthday: contact.birthday,
        payload: JSON.stringify(contact), state: 'pending', message: null };
    } catch (error) {
      return { row_number: index + 1, name: input.label.slice(0, 200), email: null, phone: null, birthday: null, payload: null,
        state: 'invalid', message: error instanceof Error ? error.message.slice(0, 500) : 'Invalid contact.' };
    }
  });
}
