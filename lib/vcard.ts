import type { Contact } from './db.ts';
import {
  normalizeContactCreateInput,
  normalizeWebUrl,
  type NormalizedContactInput,
} from './contact-input.ts';
import { parseEmbeddedContactPhoto } from './contact-photo.ts';
import { MAX_TAG_LENGTH, MAX_TAGS_PER_CONTACT } from './tag-validation.ts';

export class VCardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VCardValidationError';
  }
}

export type ParsedVCardContact = {
  name: string | null;
  nickname: string | null;
  emails: string[];
  phones: string[];
  birthday: string | null;
  birthdayText: string | null;
  birthdayReminderDays: number | null;
  notes: string | null;
  organization: string | null;
  title: string | null;
  location: string | null;
  categories: string[];
  photoUrl: string | null;
  socialLinks: Record<string, string>;
  howWeMet: string | null;
  giftIdeas: string[];
  lastContacted: string | null;
  contactFrequency: number | null;
  customFields: Record<string, unknown> | null;
};

type VCardProperty = {
  name: string;
  params: Record<string, string[]>;
  value: string;
};

function splitEscaped(value: string, separator: string): string[] {
  const values: string[] = [];
  let current = '';
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      current += `\\${character}`;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === separator) {
      values.push(current);
      current = '';
    } else {
      current += character;
    }
  }

  if (escaped) current += '\\';
  values.push(current);
  return values;
}

function decodeEscapedValue(value: string): string {
  let decoded = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== '\\' || index === value.length - 1) {
      decoded += character;
      continue;
    }

    const next = value[++index];
    decoded += next === 'n' || next === 'N' ? '\n' : next;
  }
  return decoded;
}

function decodeQuotedPrintable(value: string): string {
  const chunks: Buffer[] = [];
  let plain = '';

  const flushPlain = () => {
    if (!plain) return;
    chunks.push(Buffer.from(plain, 'utf8'));
    plain = '';
  };

  for (let index = 0; index < value.length; index++) {
    if (value[index] === '=' && /^[a-f0-9]{2}$/i.test(value.slice(index + 1, index + 3))) {
      flushPlain();
      chunks.push(Buffer.from([Number.parseInt(value.slice(index + 1, index + 3), 16)]));
      index += 2;
    } else {
      plain += value[index];
    }
  }
  flushPlain();
  return Buffer.concat(chunks).toString('utf8');
}

function findValueSeparator(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') quoted = !quoted;
    if (line[index] === ':' && !quoted) return index;
  }
  return -1;
}

function parseProperty(line: string): VCardProperty | null {
  const separator = findValueSeparator(line);
  if (separator < 1) return null;

  const descriptor = line.slice(0, separator);
  const pieces = descriptor.split(';');
  const name = pieces.shift()?.split('.').pop()?.toUpperCase();
  if (!name) return null;

  const params: Record<string, string[]> = {};
  for (const piece of pieces) {
    const equals = piece.indexOf('=');
    const key = (equals >= 0 ? piece.slice(0, equals) : 'TYPE').toUpperCase();
    const rawValue = equals >= 0 ? piece.slice(equals + 1) : piece;
    params[key] = rawValue
      .replace(/^"|"$/g, '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  let value = line.slice(separator + 1);
  if (params.ENCODING?.some((encoding) => encoding.toUpperCase() === 'QUOTED-PRINTABLE')) {
    value = decodeQuotedPrintable(value);
  }
  return { name, params, value };
}

function normalizeBirthday(value: string): { birthday: string | null; birthdayText: string | null } {
  const decoded = decodeEscapedValue(value).trim();
  const compact = decoded.match(/^(\d{4})(\d{2})(\d{2})$/);
  const birthday = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}`
    : /^\d{4}-\d{2}-\d{2}$/.test(decoded) ? decoded : null;
  return { birthday, birthdayText: birthday ? null : decoded || null };
}

function inferSocialNetwork(url: string, typeValues: string[]): string {
  const explicit = typeValues.find((value) => !['PREF', 'HOME', 'WORK', 'OTHER'].includes(value.toUpperCase()));
  if (explicit) return explicit.toLowerCase().replace(/[^a-z0-9-]/g, '');
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes('linkedin.com')) return 'linkedin';
    if (hostname.includes('instagram.com')) return 'instagram';
    if (hostname.includes('facebook.com')) return 'facebook';
    if (hostname === 'x.com' || hostname.includes('twitter.com')) return 'twitter';
  } catch {
    // URL validation happens before this helper is called.
  }
  return 'website';
}

function buildNameFromStructuredValue(value: string): string | null {
  const [family, given, additional, prefix, suffix] = splitEscaped(value, ';')
    .map(decodeEscapedValue);
  const name = [prefix, given, additional, family, suffix].filter(Boolean).join(' ').trim();
  return name || null;
}

function buildContact(properties: VCardProperty[]): ParsedVCardContact {
  let name: string | null = null;
  let nickname: string | null = null;
  let structuredName: string | null = null;
  const emails: string[] = [];
  const phones: string[] = [];
  let birthday: string | null = null;
  let birthdayText: string | null = null;
  let birthdayReminderDays: number | null = null;
  const notes: string[] = [];
  let organization: string | null = null;
  let title: string | null = null;
  let location: string | null = null;
  const categories: string[] = [];
  let photoUrl: string | null = null;
  const socialLinks: Record<string, string> = {};
  let howWeMet: string | null = null;
  const giftIdeas: string[] = [];
  let lastContacted: string | null = null;
  let contactFrequency: number | null = null;
  let customFields: Record<string, unknown> | null = null;

  for (const property of properties) {
    const decoded = decodeEscapedValue(property.value).trim();

    if (property.name === 'FN') name = decoded || name;
    if (property.name === 'NICKNAME') nickname = splitEscaped(property.value, ',').map(decodeEscapedValue)[0]?.trim() || null;
    if (property.name === 'N') structuredName = buildNameFromStructuredValue(property.value);
    if (property.name === 'EMAIL') {
      const email = decoded.replace(/^mailto:/i, '').trim().toLowerCase();
      if (email && !emails.includes(email)) emails.push(email);
    }
    if (property.name === 'TEL') {
      const phone = decoded.replace(/^tel:/i, '').trim();
      if (phone && !phones.includes(phone)) phones.push(phone);
    }
    if (property.name === 'BDAY') {
      ({ birthday, birthdayText } = normalizeBirthday(property.value));
    }
    if (property.name === 'X-BONDS-BIRTHDAY-REMINDER-DAYS') {
      const parsed = Number(decoded);
      birthdayReminderDays = Number.isInteger(parsed) && parsed >= 0 && parsed <= 365 ? parsed : null;
    }
    if (property.name === 'NOTE' && decoded) notes.push(decoded);
    if (property.name === 'ORG') {
      organization = splitEscaped(property.value, ';').map(decodeEscapedValue).filter(Boolean).join(' / ') || null;
    }
    if (property.name === 'TITLE') title = decoded || null;
    if (property.name === 'ADR') {
      const addressParts = splitEscaped(property.value, ';').map(decodeEscapedValue).filter(Boolean);
      location = addressParts.join(', ') || null;
    }
    if (property.name === 'CATEGORIES') {
      categories.push(...splitEscaped(property.value, ',').map(decodeEscapedValue).map((item) => item.trim()).filter(Boolean));
    }
    if (property.name === 'PHOTO') {
      const base64Encoded = property.params.ENCODING?.some((encoding) => (
        encoding.toUpperCase() === 'B' || encoding.toUpperCase() === 'BASE64'
      ));
      const rawType = property.params.TYPE?.[0]?.toLowerCase();
      const mimeType = rawType === 'jpg' || rawType === 'jpeg'
        ? 'image/jpeg'
        : rawType === 'png'
          ? 'image/png'
          : rawType === 'webp'
            ? 'image/webp'
            : null;
      const embeddedPhoto = base64Encoded && mimeType
        ? `data:${mimeType};base64,${property.value.trim()}`
        : null;
      const remotePhoto = decoded.length <= 2_048 ? normalizeWebUrl(decoded) : null;
      photoUrl = (embeddedPhoto && parseEmbeddedContactPhoto(embeddedPhoto) ? embeddedPhoto : null)
        || remotePhoto
        || photoUrl;
    }
    if (property.name === 'URL' || property.name === 'X-SOCIALPROFILE') {
      const url = normalizeWebUrl(decoded);
      if (url) {
        const network = inferSocialNetwork(url, property.params.TYPE || []);
        socialLinks[network] = url;
      }
    }
    if (property.name === 'X-BONDS-HOW-WE-MET') howWeMet = decoded || null;
    if (property.name === 'X-BONDS-GIFT-IDEAS') {
      giftIdeas.push(...splitEscaped(property.value, ',').map(decodeEscapedValue).filter(Boolean));
    }
    if (property.name === 'X-BONDS-LAST-CONTACTED') lastContacted = decoded || null;
    if (property.name === 'X-BONDS-CONTACT-FREQUENCY') {
      const parsed = Number(decoded);
      contactFrequency = Number.isInteger(parsed) && parsed > 0 && parsed <= 3_650 ? parsed : null;
    }
    if (property.name === 'X-BONDS-CUSTOM-FIELDS') {
      try {
        const parsed: unknown = JSON.parse(decoded);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          customFields = parsed as Record<string, unknown>;
        }
      } catch {
        // Invalid vendor fields should not prevent importing an otherwise valid contact.
      }
    }
  }

  return {
    name: name || structuredName,
    nickname,
    emails,
    phones,
    birthday,
    birthdayText,
    birthdayReminderDays,
    notes: notes.length > 0 ? notes.join('\n\n') : null,
    organization,
    title,
    location,
    categories: Array.from(new Set(categories)),
    photoUrl,
    socialLinks,
    howWeMet,
    giftIdeas: Array.from(new Set(giftIdeas)),
    lastContacted,
    contactFrequency,
    customFields,
  };
}

export function parseVCards(text: string): ParsedVCardContact[] {
  const physicalLines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines: string[] = [];
  for (const physicalLine of physicalLines) {
    const previous = lines[lines.length - 1];
    if (previous !== undefined && /^[ \t]/.test(physicalLine)) {
      lines[lines.length - 1] += physicalLine.slice(1);
      continue;
    }
    const previousDescriptor = previous?.slice(0, previous.indexOf(':')).toUpperCase() || '';
    if (
      previous !== undefined
      && previous.endsWith('=')
      && previousDescriptor.includes('ENCODING=QUOTED-PRINTABLE')
    ) {
      lines[lines.length - 1] = `${previous.slice(0, -1)}${physicalLine}`;
      continue;
    }
    lines.push(physicalLine);
  }
  const contacts: ParsedVCardContact[] = [];
  let properties: VCardProperty[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.toUpperCase() === 'BEGIN:VCARD') {
      if (properties) throw new VCardValidationError('Nested vCards are not supported.');
      properties = [];
      continue;
    }
    if (line.toUpperCase() === 'END:VCARD') {
      if (!properties) throw new VCardValidationError('vCard ended without a matching BEGIN.');
      contacts.push(buildContact(properties));
      properties = null;
      continue;
    }
    if (properties) {
      const property = parseProperty(line);
      if (property) properties.push(property);
    }
  }

  if (properties) throw new VCardValidationError('vCard is missing its END marker.');
  if (contacts.length === 0) throw new VCardValidationError('No vCard contacts were found.');
  return contacts;
}

export function normalizeVCardContact(
  contact: ParsedVCardContact,
  importedAt = new Date().toISOString()
): NormalizedContactInput & { last_contacted: string | null } {
  const displayName = contact.name
    || contact.organization
    || contact.emails[0]
    || contact.phones[0]
    || null;
  if (!displayName) throw new VCardValidationError('vCard contact has no usable identity.');

  const customFields: Record<string, unknown> = contact.customFields
    ? { ...contact.customFields }
    : { import: { source: 'vcard', imported_at: importedAt } };
  if (contact.organization) customFields.company = contact.organization;
  if (contact.title) customFields.job_title = contact.title;
  if (contact.location) customFields.location = contact.location;
  if (Object.keys(contact.socialLinks).length > 0) customFields.social = contact.socialLinks;

  const vcardDetails: Record<string, unknown> = {};
  if (contact.emails.length > 1) vcardDetails.additional_emails = contact.emails.slice(1);
  if (contact.phones.length > 1) vcardDetails.additional_phones = contact.phones.slice(1);
  if (contact.birthdayText) vcardDetails.birthday_text = contact.birthdayText;
  if (Object.keys(vcardDetails).length > 0) customFields.vcard = vcardDetails;

  const importedTags: string[] = [];
  const seenTags = new Set<string>();
  for (const category of contact.categories) {
    const tag = category
      .replace(/,/gu, ' / ')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .trim()
      .replace(/\s+/gu, ' ')
      .slice(0, MAX_TAG_LENGTH)
      .trim();
    const key = tag.toLowerCase();
    if (!tag || seenTags.has(key)) continue;
    seenTags.add(key);
    importedTags.push(tag);
    if (importedTags.length === MAX_TAGS_PER_CONTACT) break;
  }

  const normalized = normalizeContactCreateInput({
    name: displayName,
    nickname: contact.nickname,
    email: contact.emails[0] || null,
    phone: contact.phones[0] || null,
    photo_url: contact.photoUrl,
    birthday: contact.birthday,
    birthday_reminder_days: contact.birthdayReminderDays ?? 7,
    how_we_met: contact.howWeMet,
    tags: importedTags,
    notes: contact.notes,
    gift_ideas: contact.giftIdeas,
    custom_fields: customFields,
    contact_frequency: contact.contactFrequency || 30,
  });

  return { ...normalized, last_contacted: contact.lastContacted };
}

function escapeVCardValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function foldVCardLine(line: string): string {
  const lines: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const character of line) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    const limit = lines.length === 0 ? 75 : 74;
    if (current && currentBytes + characterBytes > limit) {
      lines.push(lines.length === 0 ? current : ` ${current}`);
      current = character;
      currentBytes = characterBytes;
    } else {
      current += character;
      currentBytes += characterBytes;
    }
  }
  lines.push(lines.length === 0 ? current : ` ${current}`);
  return lines.join('\r\n');
}

function parseStoredStringList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseStoredCustomFields(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function serializeContactToVCard(contact: Contact): string {
    const customFields = parseStoredCustomFields(contact.custom_fields);
    const vcardDetails = customFields.vcard && typeof customFields.vcard === 'object'
      ? customFields.vcard as Record<string, unknown>
      : {};
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `UID:bonds-${contact.id}`,
      `FN:${escapeVCardValue(contact.name)}`,
      `N:${escapeVCardValue(contact.name)};;;;`,
    ];

    if (contact.email) lines.push(`EMAIL;TYPE=INTERNET:${escapeVCardValue(contact.email)}`);
    if (contact.nickname) lines.push(`NICKNAME:${escapeVCardValue(contact.nickname)}`);
    if (contact.phone) lines.push(`TEL;TYPE=CELL:${escapeVCardValue(contact.phone)}`);
    const embeddedPhoto = parseEmbeddedContactPhoto(contact.photo_url);
    if (embeddedPhoto) {
      const photoType = embeddedPhoto.mimeType === 'image/jpeg'
        ? 'JPEG'
        : embeddedPhoto.mimeType === 'image/png' ? 'PNG' : 'WEBP';
      lines.push(`PHOTO;ENCODING=b;TYPE=${photoType}:${embeddedPhoto.base64}`);
    } else if (contact.photo_url && normalizeWebUrl(contact.photo_url) === contact.photo_url) {
      lines.push(`PHOTO;VALUE=URI:${escapeVCardValue(contact.photo_url)}`);
    }
    const additionalEmails = Array.isArray(vcardDetails.additional_emails)
      ? vcardDetails.additional_emails.filter((value): value is string => typeof value === 'string')
      : [];
    const seenEmails = new Set(contact.email ? [contact.email.trim().toLowerCase()] : []);
    for (const email of additionalEmails) {
      const normalized = email.trim().toLowerCase();
      if (!normalized || seenEmails.has(normalized)) continue;
      seenEmails.add(normalized);
      lines.push(`EMAIL;TYPE=OTHER:${escapeVCardValue(email.trim())}`);
    }
    const additionalPhones = Array.isArray(vcardDetails.additional_phones)
      ? vcardDetails.additional_phones.filter((value): value is string => typeof value === 'string')
      : [];
    const seenPhones = new Set(contact.phone ? [contact.phone.replace(/\D/g, '')] : []);
    for (const phone of additionalPhones) {
      const normalized = phone.replace(/\D/g, '');
      if (!normalized || seenPhones.has(normalized)) continue;
      seenPhones.add(normalized);
      lines.push(`TEL;TYPE=OTHER:${escapeVCardValue(phone.trim())}`);
    }
    if (contact.birthday) lines.push(`BDAY:${contact.birthday}`);
    lines.push(`X-BONDS-BIRTHDAY-REMINDER-DAYS:${contact.birthday_reminder_days}`);
    if (contact.notes) lines.push(`NOTE:${escapeVCardValue(contact.notes)}`);
    if (contact.how_we_met) lines.push(`X-BONDS-HOW-WE-MET:${escapeVCardValue(contact.how_we_met)}`);
    if (contact.last_contacted) lines.push(`X-BONDS-LAST-CONTACTED:${contact.last_contacted}`);
    lines.push(`X-BONDS-CONTACT-FREQUENCY:${contact.contact_frequency}`);
    if (contact.custom_fields) lines.push(`X-BONDS-CUSTOM-FIELDS:${escapeVCardValue(contact.custom_fields)}`);

    const tags = parseStoredStringList(contact.tags);
    if (tags.length > 0) lines.push(`CATEGORIES:${tags.map(escapeVCardValue).join(',')}`);
    const giftIdeas = parseStoredStringList(contact.gift_ideas);
    if (giftIdeas.length > 0) lines.push(`X-BONDS-GIFT-IDEAS:${giftIdeas.map(escapeVCardValue).join(',')}`);

    if (typeof customFields.company === 'string' && customFields.company) {
      lines.push(`ORG:${escapeVCardValue(customFields.company)}`);
    }
    if (typeof customFields.job_title === 'string' && customFields.job_title) {
      lines.push(`TITLE:${escapeVCardValue(customFields.job_title)}`);
    }
    if (typeof customFields.location === 'string' && customFields.location) {
      lines.push(`ADR;TYPE=HOME:;;;${escapeVCardValue(customFields.location)};;;`);
    }
    if (customFields.social && typeof customFields.social === 'object') {
      for (const [network, rawUrl] of Object.entries(customFields.social)) {
        const url = normalizeWebUrl(rawUrl);
        const safeNetwork = network.toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (url && safeNetwork) lines.push(`X-SOCIALPROFILE;TYPE=${safeNetwork}:${escapeVCardValue(url)}`);
      }
    }

    lines.push(`REV:${contact.updated_at || contact.created_at}`);
    lines.push('END:VCARD');
  return lines.map(foldVCardLine).join('\r\n');
}

export function serializeContactsToVCard(contacts: Contact[]): string {
  return `${contacts.map(serializeContactToVCard).join('\r\n')}\r\n`;
}
