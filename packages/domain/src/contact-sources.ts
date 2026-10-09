import { isSyncUuid } from './sync.ts';

export const SOURCE_FIELD_LABELS = { name: 'Name', headline: 'Headline', company: 'Company', location: 'Location', title: 'Position', email: 'Email', connected_on: 'Connection date in export' } as const;
export type SourceField = keyof typeof SOURCE_FIELD_LABELS;
export type SourceFact = { original_value: string | null; observed_value: string | null; applied_value: string | null };
export type SourceFacts = Partial<Record<SourceField, SourceFact>>;
export type ContactSource = {
  public_id: string; provider: 'linkedin'; account_key: string; external_id: string; profile_url: string;
  origin: 'user_provided'; fields: string; revision: number; observed_at: string; created_at: string; updated_at: string;
};
export const SOURCE_PROJECTION_COLUMNS = ['public_id', 'provider', 'account_key', 'external_id', 'profile_url', 'origin', 'fields', 'revision', 'observed_at', 'created_at', 'updated_at'] as const;
export class ContactSourceError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'ContactSourceError'; this.status = status; }
}
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, key: SourceField): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new ContactSourceError(`${SOURCE_FIELD_LABELS[key]} must be text.`);
  const result = value.trim();
  if (/[\u0000-\u001f\u007f]/u.test(result) || result.length > (key === 'name' ? 200 : key === 'email' ? 320 : 500)) throw new ContactSourceError(`Invalid ${SOURCE_FIELD_LABELS[key].toLowerCase()}.`);
  return result || null;
}
/** Only a person profile URL is identity evidence. Do not retain tracking URLs or credentials. */
export function linkedinProfileIdentity(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value.trim())) throw new ContactSourceError('Enter a LinkedIn person profile URL.');
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/iu.test(value) ? value.trim() : `https://${value.trim()}`); }
  catch { throw new ContactSourceError('Enter a LinkedIn person profile URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !['linkedin.com', 'www.linkedin.com', 'm.linkedin.com'].includes(url.hostname.toLowerCase())) throw new ContactSourceError('Enter a LinkedIn person profile URL.');
  const match = /^\/in\/([^/]+)\/?$/u.exec(url.pathname);
  if (!match) throw new ContactSourceError('Enter a LinkedIn person profile URL, such as linkedin.com/in/ana.');
  let slug: string;
  try { slug = decodeURIComponent(match[1]).normalize('NFC').toLowerCase(); } catch { throw new ContactSourceError('Invalid LinkedIn profile URL.'); }
  if (!slug || /[\s/\\?#\u0000-\u001f\u007f]/u.test(slug) || slug.length > 500) throw new ContactSourceError('Invalid LinkedIn profile URL.');
  return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
}
export function normalizeSourceObservations(value: unknown): Partial<Record<SourceField, string | null>> {
  if (!object(value) || Object.keys(value).some((key) => !Object.hasOwn(SOURCE_FIELD_LABELS, key))) throw new ContactSourceError('Unsupported source fields.');
  return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, text(value, key as SourceField)]));
}
export function readSourceFacts(value: unknown): SourceFacts {
  if (typeof value !== 'string' || value.length > 16384) throw new ContactSourceError('Invalid source facts.');
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new ContactSourceError('Invalid source facts.'); }
  if (!object(parsed) || Object.keys(parsed).some((key) => !Object.hasOwn(SOURCE_FIELD_LABELS, key))) throw new ContactSourceError('Invalid source facts.');
  for (const [key, fact] of Object.entries(parsed)) {
    if (!object(fact) || Object.keys(fact).length !== 3 || !['original_value', 'observed_value', 'applied_value'].every((field) => field in fact)) throw new ContactSourceError('Invalid source facts.');
    for (const field of ['original_value', 'observed_value', 'applied_value']) if (text(fact[field], key as SourceField) !== fact[field]) throw new ContactSourceError('Invalid source facts.');
  }
  return parsed as SourceFacts;
}
/** Retain the first observation and last explicitly applied value on every refresh. */
export function observeSourceFacts(previous: string, observations: Partial<Record<SourceField, string | null>>) {
  const facts = readSourceFacts(previous);
  for (const [key, value] of Object.entries(observations)) {
    const field = key as SourceField;
    facts[field] = { original_value: facts[field] ? facts[field]!.original_value : value, observed_value: value, applied_value: facts[field]?.applied_value ?? null };
  }
  return JSON.stringify(facts);
}
export function readContactSources(value: unknown): ContactSource[] {
  if (value === undefined) return []; // Older servers and receipts have no source projection.
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 131072) throw new ContactSourceError('Invalid contact sources.');
  let rows: unknown; try { rows = JSON.parse(value); } catch { throw new ContactSourceError('Invalid contact sources.'); }
  if (!Array.isArray(rows) || rows.length > 32) throw new ContactSourceError('Invalid contact sources.');
  const ids = new Set<string>();
  for (const row of rows) {
    if (!object(row) || Object.keys(row).length !== SOURCE_PROJECTION_COLUMNS.length || Object.keys(row).some((key) => !SOURCE_PROJECTION_COLUMNS.some((field) => field === key))
      || !isSyncUuid(row.public_id) || ids.has(row.public_id) || row.provider !== 'linkedin' || row.account_key !== 'user_provided'
      || row.origin !== 'user_provided' || typeof row.profile_url !== 'string' || linkedinProfileIdentity(row.profile_url) !== row.profile_url || row.external_id !== row.profile_url
      || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || ['observed_at', 'created_at', 'updated_at'].some((key) => typeof row[key] !== 'string' || !Number.isFinite(Date.parse(String(row[key]))))) throw new ContactSourceError('Invalid contact sources.');
    readSourceFacts(row.fields); ids.add(row.public_id);
  }
  return rows as ContactSource[];
}
