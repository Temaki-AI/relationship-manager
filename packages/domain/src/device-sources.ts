import { isSyncUuid } from './sync.ts';
import { readDeviceContactFacts } from './device-contact-facts.ts';
import { ProviderSourceError, readAppliedProviderFields } from './provider-sources.ts';

export const DEVICE_SOURCE_COLUMNS = ['public_id', 'installation_id', 'external_id', 'original_facts', 'observed_facts',
  'applied_fields', 'revision', 'observed_at', 'created_at', 'updated_at'] as const;
export type DeviceSource = {
  public_id: string; installation_id: string; external_id: string; original_facts: string; observed_facts: string;
  applied_fields: string; revision: number; observed_at: string; created_at: string; updated_at: string;
};
export function readDeviceSources(value: unknown): DeviceSource[] {
  if (value === undefined) return [];
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 131072) throw new ProviderSourceError('Invalid or oversized iPhone sources.');
  let rows: unknown; try { rows = JSON.parse(value); } catch { throw new ProviderSourceError('Invalid saved iPhone sources.'); }
  if (!Array.isArray(rows) || rows.length > 32) throw new ProviderSourceError('Too many iPhone sources.');
  const ids = new Set<string>(), identities = new Set<string>();
  return rows.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== DEVICE_SOURCE_COLUMNS.length
      || DEVICE_SOURCE_COLUMNS.some((key) => !Object.hasOwn(raw, key))) throw new ProviderSourceError('Invalid iPhone source fields.');
    const row = raw as DeviceSource;
    if (!isSyncUuid(row.public_id) || !isSyncUuid(row.installation_id) || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new ProviderSourceError('Invalid iPhone source identity or revision.');
    const original = readDeviceContactFacts(row.original_facts), observed = readDeviceContactFacts(row.observed_facts);
    if (original.device_id !== row.external_id || observed.device_id !== row.external_id) throw new ProviderSourceError('The iPhone source identity changed.');
    readAppliedProviderFields(row.applied_fields);
    for (const key of ['observed_at', 'created_at', 'updated_at'] as const) if (typeof row[key] !== 'string' || row[key].length > 80 || !Number.isFinite(Date.parse(row[key]))) throw new ProviderSourceError('Invalid iPhone observation time.');
    const identity = JSON.stringify([row.installation_id, row.external_id]);
    if (ids.has(row.public_id) || identities.has(identity)) throw new ProviderSourceError('Repeated iPhone source identity.');
    ids.add(row.public_id); identities.add(identity); return row;
  });
}
export function deviceSourceProjection(row: Record<string, unknown>): DeviceSource {
  return readDeviceSources(JSON.stringify([Object.fromEntries(DEVICE_SOURCE_COLUMNS.map((key) => [key, row[key]]))]))[0];
}
export type DeviceSourceMutation = {
  operation_id: string; epoch: string; action: 'publish' | 'unlink'; source_id: string; contact_id: string;
  installation_id: string; external_id: string; expected_revision: number | null;
  original_facts?: string; observed_facts?: string; applied_fields?: string; observed_at?: string;
};
export function readDeviceSourceMutation(value: unknown): DeviceSourceMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderSourceError('Use a source mutation object.');
  const row = value as Record<string, unknown>;
  const keys = ['operation_id', 'epoch', 'action', 'source_id', 'contact_id', 'installation_id', 'external_id', 'expected_revision',
    ...(row.action === 'publish' ? ['original_facts', 'observed_facts', 'applied_fields', 'observed_at'] : [])];
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))
    || !['publish', 'unlink'].includes(String(row.action)) || ['operation_id', 'epoch', 'source_id', 'contact_id', 'installation_id'].some((key) => !isSyncUuid(row[key]))
    || typeof row.external_id !== 'string' || !row.external_id.trim() || row.external_id.length > 500 || /[\u0000-\u001f\u007f]/u.test(row.external_id)
    || row.expected_revision !== null && (!Number.isSafeInteger(row.expected_revision) || Number(row.expected_revision) < 1)
    || row.action === 'unlink' && row.expected_revision === null) throw new ProviderSourceError('Invalid source mutation identity or revision.');
  if (row.action === 'publish') {
    if (typeof row.original_facts !== 'string' || typeof row.observed_facts !== 'string') throw new ProviderSourceError('Use saved source observations.');
    if (typeof row.observed_at !== 'string' || row.observed_at.length > 80 || !Number.isFinite(Date.parse(row.observed_at))) throw new ProviderSourceError('Invalid phone observation time.');
    const original = readDeviceContactFacts(row.original_facts), observed = readDeviceContactFacts(row.observed_facts);
    if (original.device_id !== row.external_id || observed.device_id !== row.external_id) throw new ProviderSourceError('The source observation has another identity.');
    readAppliedProviderFields(row.applied_fields);
  }
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as DeviceSourceMutation;
}
