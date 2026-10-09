import { ContactSourceError, linkedinProfileIdentity, normalizeSourceObservations, type SourceField } from '../packages/domain/src/contact-sources.ts';
export const MAX_LINKEDIN_EXPORT_BYTES = 2 * 1024 * 1024;
export const MAX_LINKEDIN_EXPORT_ROWS = 5000;
export type LinkedInExportFields = Partial<Record<SourceField, string | null>>;
export type LinkedInExportRow = { row: number; profile_url: string | null; fields: LinkedInExportFields; issue: string | null; duplicates: number[]; duplicate_count: number };

/** Strict quoted CSV parsing with bounded records; never accepts a ZIP or another archive category. */
function records(text: string) {
  const result: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  function finishField() { row.push(field); field = ''; closed = false; if (row.length > 20) throw new ContactSourceError('Connections.csv has too many columns.'); }
  function finishRow() { finishField(); if (row.some((value) => value.trim())) result.push(row); row = [];
    if (result.length > MAX_LINKEDIN_EXPORT_ROWS + 11) throw new ContactSourceError('Review at most 5,000 connections per file. Split a larger Connections.csv.'); }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; } else field += char;
    } else if (char === ',') finishField();
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[i + 1] === '\n') i++; finishRow(); }
    else if (char === '"') { if (field) throw new ContactSourceError('Connections.csv contains a misplaced quote.'); quoted = true; }
    else { if (closed) throw new ContactSourceError('Connections.csv contains text after a closing quote.'); field += char; }
    if (field.length > 4096) throw new ContactSourceError('A Connections.csv field is too large.');
  }
  if (quoted) throw new ContactSourceError('Connections.csv contains an unfinished quoted field.');
  if (field || row.length) finishRow(); return result;
}
const headers: Record<string, string> = { 'first name': 'first', 'last name': 'last', url: 'url', 'public profile url': 'url', 'email address': 'email', company: 'company', position: 'title', 'connected on': 'connected_on' };
export function parseLinkedInExport(text: string): LinkedInExportRow[] {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_LINKEDIN_EXPORT_BYTES) throw new ContactSourceError('Connections.csv is limited to 2 MiB.');
  const all = records(text.replace(/^\uFEFF/u, ''));
  const headerIndex = all.slice(0, 11).findIndex((row) => row.some((value) => value.trim().toLowerCase() === 'first name') && row.some((value) => value.trim().toLowerCase() === 'last name'));
  if (headerIndex < 0) throw new ContactSourceError('Choose LinkedIn Connections.csv, including its header. ZIP archives and other LinkedIn files are not supported here.');
  const columns = all[headerIndex].map((value) => headers[value.trim().toLowerCase()]);
  if (columns.some((value) => !value) || new Set(columns).size !== columns.length || ['first', 'last', 'email', 'company', 'title', 'connected_on'].some((value) => !columns.includes(value))) throw new ContactSourceError('Connections.csv has unsupported, missing or repeated columns.');
  if (all.length - headerIndex - 1 > MAX_LINKEDIN_EXPORT_ROWS) throw new ContactSourceError('Review at most 5,000 connections per file. Split a larger Connections.csv.');
  const parsed = all.slice(headerIndex + 1).map((values, index): LinkedInExportRow => {
    const result: LinkedInExportRow = { row: index + 1, profile_url: null, fields: {}, issue: null, duplicates: [], duplicate_count: 0 };
    try {
      if (values.length !== columns.length) throw new ContactSourceError('The row has a different number of fields from its header.');
      const data = Object.fromEntries(columns.map((key, index) => [key, values[index].trim()]));
      result.fields = normalizeSourceObservations({ name: [data.first, data.last].filter(Boolean).join(' '), email: data.email || null,
        company: data.company || null, title: data.title || null, connected_on: data.connected_on || null });
      if (!result.fields.name) throw new ContactSourceError('A connection name is required.');
      if (data.url) result.profile_url = linkedinProfileIdentity(data.url);
    } catch (err) { result.issue = err instanceof Error ? err.message : 'This row cannot be reviewed.'; }
    return result;
  });
  const byUrl = new Map<string, number[]>();
  for (const row of parsed) if (row.profile_url && !row.issue) { const list = byUrl.get(row.profile_url) ?? []; list.push(row.row); byUrl.set(row.profile_url, list); }
  for (const row of parsed) if (row.profile_url) { const list = byUrl.get(row.profile_url) ?? []; row.duplicate_count = Math.max(0, list.length - 1); row.duplicates = list.slice(0, 11).filter((value) => value !== row.row).slice(0, 10); }
  return parsed;
}
