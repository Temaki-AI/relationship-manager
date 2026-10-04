import { isSyncUuid } from './sync.ts';
import { ProviderSourceError, readAppliedProviderFields, readProviderFacts, type GoogleContactMethod, type ProviderSource } from './provider-sources.ts';
export type ProviderRuleMode = 'keep' | 'follow';
export type ProviderRuleIssue = null | 'missing' | 'ambiguous' | 'invalid' | 'capacity';
export type ProviderNameRule = { mode: ProviderRuleMode; overridden: boolean; last_applied: string | null; issue: ProviderRuleIssue };
export type ProviderMethodRule = ProviderNameRule & { id: string; kind: 'email' | 'phone'; slot: GoogleContactMethod | null };
export type ProviderFieldRules = { name: ProviderNameRule; methods: ProviderMethodRule[] };
export type SavedProviderRules = { source_public_id: string; revision: number; fields: ProviderFieldRules };
const BASE_KEYS = ['mode', 'overridden', 'last_applied', 'issue'];
function fail(): never { throw new ProviderSourceError('Invalid or oversized source field settings.'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) return fail(); return row;
}
function base(value: Record<string, unknown>, limit: number): ProviderNameRule {
  if (!['keep', 'follow'].includes(String(value.mode)) || typeof value.overridden !== 'boolean'
    || ![null, 'missing', 'ambiguous', 'invalid', 'capacity'].includes(value.issue as ProviderRuleIssue)
    || value.last_applied !== null && (typeof value.last_applied !== 'string' || !value.last_applied.trim() || value.last_applied.length > limit || /[\u0000-\u001f\u007f]/u.test(value.last_applied))) return fail();
  return value as ProviderNameRule;
}
export function readProviderRules(value: unknown): ProviderFieldRules {
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > 128 * 1024) return fail();
    try { value = JSON.parse(value); } catch { return fail(); }
  }
  const row = object(value, ['name', 'methods']), name = base(object(row.name, BASE_KEYS), 200), ids = new Set<string>();
  if (!Array.isArray(row.methods) || row.methods.length > 256) return fail();
  const methods = row.methods.map((value): ProviderMethodRule => {
    const method = object(value, [...BASE_KEYS, 'id', 'kind', 'slot']);
    if (!isSyncUuid(method.id) || ids.has(method.id) || !['email', 'phone'].includes(String(method.kind))) return fail(); ids.add(method.id);
    base(method, method.kind === 'email' ? 320 : 100);
    if (method.slot !== null) {
      const facts = readProviderFacts({ sourceId: 'rule', resourceName: 'people/rule', etag: null, name: null, company: null, title: null, location: null,
        emails: method.kind === 'email' ? [method.slot] : [], phones: method.kind === 'phone' ? [method.slot] : [] });
      method.slot = (method.kind === 'email' ? facts.emails : facts.phones)[0];
    }
    return method as ProviderMethodRule;
  });
  const result = { name, methods }; if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 128 * 1024) return fail(); return result;
}
export function defaultProviderRules(source: ProviderSource): ProviderFieldRules {
  const audit = readAppliedProviderFields(source.applied_fields), original = readProviderFacts(source.original_facts);
  return { name: { mode: 'keep', overridden: false, last_applied: audit.name, issue: null }, methods: audit.methods.map((item) => {
    const candidates = (item.method.kind === 'email' ? original.emails : original.phones).filter((slot) => slot.value === item.source_value);
    return { id: item.method.id, kind: item.method.kind as 'email' | 'phone', mode: 'keep', overridden: false, last_applied: item.method.value, issue: null, slot: candidates.length === 1 ? candidates[0] : null };
  }) };
}
