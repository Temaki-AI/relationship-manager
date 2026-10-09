import { isSyncUuid } from './sync.ts';
import { readContactMethods, type ContactMethod } from './contact-methods.ts';

export type GoogleContactMethod = { value: string; label: string | null; primary: boolean; canonical: string | null };
export type GoogleContactFacts = { sourceId: string; resourceName: string; etag: string | null; name: string | null;
  emails: GoogleContactMethod[]; phones: GoogleContactMethod[]; company: string | null; title: string | null; location: string | null };
export type AppliedProviderFields = { name: string | null; methods: { method: ContactMethod; source_value: string }[] };
export type ProviderSource = { public_id: string; provider: 'google'; account_key: string; account_email: string; external_id: string; resource_name: string;
  original_facts: string; observed_facts: string; applied_fields: string; status: 'available' | 'unavailable'; revision: number;
  observed_at: string; created_at: string; updated_at: string };
export const PROVIDER_SOURCE_COLUMNS = ['public_id', 'provider', 'account_key', 'account_email', 'external_id', 'resource_name', 'original_facts',
  'observed_facts', 'applied_fields', 'status', 'revision', 'observed_at', 'created_at', 'updated_at'] as const;
export class ProviderSourceError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'ProviderSourceError'; this.status = status; }
}
function fail(): never { throw new ProviderSourceError('Invalid or oversized provider source details.'); }
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const result = value as Record<string, unknown>;
  if (keys && (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))) return fail();
  return result;
}
function json(value: unknown, maximum: number) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > maximum) return fail();
  try { return JSON.parse(value); } catch { return fail(); }
}
function text(value: unknown, maximum: number, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) return fail();
  return value;
}
function resourceName(value: unknown) {
  const result = text(value, 255)!; if (!/^people\/[A-Za-z0-9_-]+$/.test(result)) return fail(); return result;
}
export function readProviderFacts(value: unknown): GoogleContactFacts {
  if (typeof value === 'string') value = json(value, 24 * 1024);
  const row = object(value, ['sourceId', 'resourceName', 'etag', 'name', 'emails', 'phones', 'company', 'title', 'location']);
  const sourceId = text(row.sourceId, 255)!; if (!/^[A-Za-z0-9_-]+$/.test(sourceId)) return fail();
  const methods = (kind: 'emails' | 'phones') => {
    const collection = row[kind]; if (!Array.isArray(collection) || collection.length > 100) return fail();
    return collection.map((raw): GoogleContactMethod => {
      const item = object(raw, ['value', 'label', 'primary', 'canonical']);
      if (typeof item.primary !== 'boolean' || kind === 'emails' && item.canonical !== null) return fail();
      return { value: text(item.value, kind === 'emails' ? 320 : 200)!, label: text(item.label, 100, true), primary: item.primary, canonical: text(item.canonical, 32, true) };
    });
  };
  const result: GoogleContactFacts = { sourceId, resourceName: resourceName(row.resourceName), etag: text(row.etag, 512, true), name: text(row.name, 200, true),
    emails: methods('emails'), phones: methods('phones'), company: text(row.company, 500, true), title: text(row.title, 500, true), location: text(row.location, 500, true) };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 24 * 1024) return fail();
  return result;
}
export function readAppliedProviderFields(value: unknown): AppliedProviderFields {
  const row = object(json(value, 64 * 1024), ['name', 'methods']);
  if (!Array.isArray(row.methods) || row.methods.length > 256) return fail();
  const ids = new Set<string>();
  const methods = row.methods.map((raw) => {
    const item = object(raw, ['method', 'source_value']), method = readContactMethods([item.method])[0];
    if (!['email', 'phone'].includes(method.kind) || ids.has(method.id)) return fail(); ids.add(method.id);
    return { method, source_value: text(item.source_value, method.kind === 'email' ? 320 : 200)! };
  });
  return { name: text(row.name, 200, true), methods };
}
export function readProviderSources(value: unknown): ProviderSource[] {
  if (value === undefined) return [];
  const rows = json(value, 128 * 1024);
  if (!Array.isArray(rows) || rows.length > 32) return fail();
  const ids = new Set<string>(), identities = new Set<string>();
  return rows.map((raw) => {
    const row = object(raw, PROVIDER_SOURCE_COLUMNS);
    if (!isSyncUuid(row.public_id) || row.provider !== 'google' || !['available', 'unavailable'].includes(String(row.status))
      || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) return fail();
    const account = text(row.account_key, 255)!; if (!/^[A-Za-z0-9_-]+$/.test(account)) return fail();
    const email = text(row.account_email, 320)!; if (!/^[^\s@]+@[^\s@]+$/.test(email)) return fail();
    const original = readProviderFacts(row.original_facts), observed = readProviderFacts(row.observed_facts);
    if (original.sourceId !== row.external_id || observed.sourceId !== row.external_id || observed.resourceName !== row.resource_name) return fail();
    readAppliedProviderFields(row.applied_fields);
    for (const key of ['observed_at', 'created_at', 'updated_at'] as const) if (typeof row[key] !== 'string' || row[key].length > 80 || !Number.isFinite(Date.parse(row[key]))) return fail();
    const identity = JSON.stringify([account, row.external_id]); if (ids.has(row.public_id) || identities.has(identity)) return fail();
    ids.add(row.public_id); identities.add(identity);
    return row as ProviderSource;
  });
}
export function providerSourceProjection(row: Record<string, unknown>): ProviderSource {
  return readProviderSources(JSON.stringify([Object.fromEntries(PROVIDER_SOURCE_COLUMNS.map((key) => [key, row[key]]))]))[0];
}
