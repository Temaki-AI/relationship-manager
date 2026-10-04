import { contactMethodIdentity, normalizeUserContactMethods, readContactMethods } from './contact-methods.ts';
import { deviceImportFacts, readDeviceContactFacts, type DeviceContactFacts, type DeviceContactMethod } from './device-contact-facts.ts';
import { readProviderRules, type ProviderNameRule } from './provider-rules.ts';
import { readAppliedProviderFields, ProviderSourceError } from './provider-sources.ts';
import { isSyncUuid } from './sync.ts';
export type DeviceMethodRule = ProviderNameRule & { id: string; kind: 'email' | 'phone'; slot: DeviceContactMethod | null };
export type DeviceFieldRules = { name: ProviderNameRule; methods: DeviceMethodRule[] };
export function readDeviceRules(value: unknown): DeviceFieldRules {
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > 131072) throw new ProviderSourceError('iPhone field settings are too large.');
    try { value = JSON.parse(value); } catch { throw new ProviderSourceError('Invalid iPhone field settings.'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderSourceError('Invalid iPhone field settings.');
  const row = value as DeviceFieldRules;
  if (!Array.isArray(row.methods)) throw new ProviderSourceError('Invalid iPhone method settings.');
  const methods = row.methods.map((rule) => {
    if (!rule || typeof rule !== 'object' || !isSyncUuid(rule.id) || !['email', 'phone'].includes(rule.kind)) throw new ProviderSourceError('Invalid iPhone method rule.');
    if (rule.slot !== null) {
      readDeviceContactFacts({ device_id: 'rule', name: null, emails: rule.kind === 'email' ? [rule.slot] : [], phones: rule.kind === 'phone' ? [rule.slot] : [] });
    }
    return { ...rule, slot: rule.slot ? { value: rule.slot.value, label: rule.slot.label, primary: false, canonical: null } : null };
  });
  // Reuse the strict mode/baseline/issue contract without losing the OS slot identity.
  readProviderRules({ ...row, methods });
  const result = JSON.parse(JSON.stringify(row)) as DeviceFieldRules;
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 131072) throw new ProviderSourceError('iPhone field settings are too large.');
  return result;
}
export function defaultDeviceRules(source: { original_facts: string; observed_facts?: string; applied_fields: string }): DeviceFieldRules {
  const facts = readDeviceContactFacts(source.original_facts), observed = source.observed_facts ? readDeviceContactFacts(source.observed_facts) : facts, audit = readAppliedProviderFields(source.applied_fields);
  return readDeviceRules({ name: { mode: 'keep', overridden: false, last_applied: audit.name, issue: null }, methods: audit.methods.map((item) => {
    let slots = (item.method.kind === 'email' ? facts.emails : facts.phones).filter((slot) => slot.value === item.source_value);
    if (!slots.length) slots = (item.method.kind === 'email' ? observed.emails : observed.phones).filter((slot) => slot.value === item.source_value);
    return { id: item.method.id, kind: item.method.kind, mode: 'keep', overridden: false, last_applied: item.method.value, issue: null, slot: slots.length === 1 ? slots[0] : null };
  }) });
}
export function observeDeviceMethod(rule: DeviceMethodRule, facts: DeviceContactFacts) {
  const slots = rule.kind === 'email' ? facts.emails : facts.phones;
  if (!rule.slot) return { index: null, issue: 'ambiguous' as const };
  if (rule.slot.source_id !== null) {
    const matches = slots.map((slot, index) => ({ slot, index })).filter(({ slot }) => slot.source_id === rule.slot!.source_id);
    return matches.length === 1 ? { index: matches[0].index, issue: null } : { index: null, issue: matches.length ? 'ambiguous' as const : 'missing' as const };
  }
  const identity = (slot: DeviceContactMethod) => contactMethodIdentity({ kind: rule.kind, value: slot.value, country: null });
  const exact = slots.map((slot, index) => ({ slot, index })).filter(({ slot }) => identity(slot) === identity(rule.slot!));
  if (exact.length === 1) return { index: exact[0].index, issue: null };
  if (exact.length > 1 || !rule.slot.label) return { index: null, issue: exact.length ? 'ambiguous' as const : 'missing' as const };
  const labeled = slots.map((slot, index) => ({ slot, index })).filter(({ slot }) => slot.label === rule.slot!.label);
  return labeled.length === 1 ? { index: labeled[0].index, issue: null } : { index: null, issue: labeled.length ? 'ambiguous' as const : 'missing' as const };
}
/** Follow only approved field identities; source absence never deletes a CRM value. */
export function reconcileDeviceFields(previous: DeviceFieldRules, name: string, methodsJson: string, facts: DeviceContactFacts | null) {
  const fields = readDeviceRules(previous), methods = readContactMethods(methodsJson).map((method) => ({ ...method }));
  let nextName = name, changedMethods = false;
  if (fields.name.mode === 'follow' && fields.name.last_applied !== name) fields.name.overridden = true;
  fields.name.issue = facts?.name ? null : 'missing';
  if (fields.name.mode === 'follow' && !fields.name.overridden && facts?.name) { nextName = facts.name; fields.name.last_applied = nextName; }
  for (const rule of fields.methods) {
    const method = methods.find((item) => item.id === rule.id && item.kind === rule.kind);
    if (rule.mode === 'follow' && (!method || method.value !== rule.last_applied)) rule.overridden = true;
    if (!facts) { rule.issue = 'missing'; continue; }
    const observed = observeDeviceMethod(rule, facts); rule.issue = observed.issue;
    if (observed.index === null) continue;
    const slot = (rule.kind === 'email' ? facts.emails : facts.phones)[observed.index]; rule.slot = slot;
    if (rule.mode !== 'follow' || rule.overridden || !method) continue;
    try {
      const normalized = deviceImportFacts({ ...facts, emails: rule.kind === 'email' ? [slot] : [], phones: rule.kind === 'phone' ? [slot] : [] });
      const value = rule.kind === 'phone' ? normalized.phones[0].canonical ?? slot.value : slot.value;
      if (rule.kind === 'phone' && !/^\+?[0-9 ()\-.]+$/u.test(value)) { rule.issue = 'invalid'; continue; }
      normalizeUserContactMethods([{ ...method, value }], methodsJson);
      if (value !== method.value) { method.value = value; changedMethods = true; } rule.last_applied = value;
    } catch { rule.issue = 'invalid'; }
  }
  return { fields: readDeviceRules(fields), name: nextName, methods: changedMethods ? normalizeUserContactMethods(methods, methodsJson) : methodsJson };
}
