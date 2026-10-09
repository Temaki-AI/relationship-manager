import { ProviderSourceError } from './provider-sources.ts';
import type { GoogleContactFacts } from './provider-sources.ts';
export type DeviceContactMethod = { source_id: string | null; value: string; label: string | null };
export type DeviceContactFacts = { device_id: string; name: string | null; emails: DeviceContactMethod[]; phones: DeviceContactMethod[] };
function text(value: unknown, limit: number, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) throw new ProviderSourceError('This device contact has invalid or oversized details.');
  return value.trim();
}
function object(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new ProviderSourceError('Invalid device contact details.');
  return value as Record<string, unknown>;
}
export function readDeviceContactFacts(value: unknown): DeviceContactFacts {
  if (typeof value === 'string') { if (new TextEncoder().encode(value).byteLength > 24576) throw new ProviderSourceError('This device contact is too large to review.'); try { value = JSON.parse(value); } catch { throw new ProviderSourceError('Invalid saved device contact details.'); } }
  const row = object(value, ['device_id', 'name', 'emails', 'phones']);
  function methods(value: unknown, limit: number) {
    if (!Array.isArray(value) || value.length > 100) throw new ProviderSourceError('This device contact has too many methods to review.');
    return value.map((item) => { const method = object(item, ['source_id', 'value', 'label']); return { source_id: text(method.source_id, 500, true), value: text(method.value, limit, false)!, label: text(method.label, 80, true) }; });
  }
  const facts = { device_id: text(row.device_id, 500, false)!, name: text(row.name, 200, true), emails: methods(row.emails, 320), phones: methods(row.phones, 100) };
  if (new TextEncoder().encode(JSON.stringify(facts)).byteLength > 24576) throw new ProviderSourceError('This device contact is too large to review.'); return facts;
}
/** Reuse method normalization without implying that an on-device value was authenticated by Google. */
export function deviceImportFacts(value: DeviceContactFacts): GoogleContactFacts {
  const facts = readDeviceContactFacts(value);
  return { sourceId: 'device', resourceName: 'people/device', etag: null, name: facts.name, company: null, title: null, location: null,
    emails: facts.emails.map((method) => ({ value: method.value, label: method.label, primary: false, canonical: null })),
    phones: facts.phones.map((method) => ({ value: method.value, label: method.label, primary: false, canonical: null })) };
}
export function selectedDeviceIndexes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((index) => !Number.isInteger(index) || index < 0 || index > 99) || new Set(value).size !== value.length) throw new ProviderSourceError('Choose each device contact field only once.');
  return [...value].sort((a, b) => a - b);
}
