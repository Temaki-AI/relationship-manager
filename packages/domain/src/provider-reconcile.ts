import { contactMethodIdentity, normalizeUserContactMethods, readContactMethods } from './contact-methods.ts';
import { providerMethodDraft } from './provider-import.ts';
import { readProviderRules, type ProviderFieldRules, type ProviderMethodRule } from './provider-rules.ts';
import type { GoogleContactFacts, GoogleContactMethod } from './provider-sources.ts';
function identity(kind: 'email' | 'phone', slot: GoogleContactMethod) {
  const value = kind === 'phone' && slot.canonical && /^\+[1-9]\d{1,14}$/.test(slot.canonical) ? slot.canonical : slot.value;
  return contactMethodIdentity({ kind, value, country: null });
}
export function observeProviderMethod(rule: ProviderMethodRule, facts: GoogleContactFacts) {
  const collection = rule.kind === 'email' ? facts.emails : facts.phones;
  if (!rule.slot) return { index: null, issue: 'ambiguous' as const };
  const exact = collection.map((slot, index) => ({ slot, index })).filter(({ slot }) => identity(rule.kind, slot) === identity(rule.kind, rule.slot!));
  if (exact.length === 1) return { index: exact[0].index, issue: null };
  if (exact.length > 1) return { index: null, issue: 'ambiguous' as const };
  const labeled = collection.map((slot, index) => ({ slot, index })).filter(({ slot }) => slot.label === rule.slot!.label);
  if (labeled.length === 1) return { index: labeled[0].index, issue: null };
  return { index: null, issue: labeled.length > 1 ? 'ambiguous' as const : 'missing' as const };
}
/** Provider updates change approved values only; labels, preferred flags and private fields belong to the user. */
export function reconcileProviderFields(previous: ProviderFieldRules, name: string, methodsJson: string, facts: GoogleContactFacts | null) {
  const fields = readProviderRules(JSON.stringify(previous)), methods = readContactMethods(methodsJson).map((method) => ({ ...method }));
  let nextName = name, changedMethods = false;
  if (fields.name.mode === 'follow' && fields.name.last_applied !== name) fields.name.overridden = true;
  fields.name.issue = facts?.name ? null : 'missing';
  if (fields.name.mode === 'follow' && !fields.name.overridden && facts?.name) { nextName = facts.name; fields.name.last_applied = nextName; }
  for (const rule of fields.methods) {
    const method = methods.find((method) => method.id === rule.id && method.kind === rule.kind);
    if (rule.mode === 'follow' && (!method || method.value !== rule.last_applied)) rule.overridden = true;
    if (!facts) { rule.issue = 'missing'; continue; }
    const observation = observeProviderMethod(rule, facts); rule.issue = observation.issue;
    if (observation.index === null) continue;
    rule.slot = (rule.kind === 'email' ? facts.emails : facts.phones)[observation.index];
    if (rule.mode !== 'follow' || rule.overridden || !method) continue;
    try {
      const draft = providerMethodDraft(facts, rule.kind, observation.index, method.id);
      if (rule.kind === 'phone' && !/^\+?[0-9 ()\-.]+$/u.test(draft.value)) { rule.issue = 'invalid'; continue; }
      const value = readContactMethods(normalizeUserContactMethods([{ ...method, value: draft.value }], methodsJson))[0].value;
      if (method.value !== value) { method.value = value; changedMethods = true; }
      rule.last_applied = value;
    } catch { rule.issue = 'invalid'; }
  }
  const finalMethods = changedMethods ? normalizeUserContactMethods(methods, methodsJson) : methodsJson;
  return { fields: readProviderRules(JSON.stringify(fields)), name: nextName, methods: finalMethods,
    email: methods.find((method) => method.kind === 'email' && method.preferred)?.value ?? null,
    phone: methods.find((method) => method.kind === 'phone' && method.preferred)?.value ?? null };
}
