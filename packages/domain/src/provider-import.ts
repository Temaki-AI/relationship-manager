import { contactMethodIdentity, normalizeUserContactMethods, readContactMethods, type ContactMethod } from './contact-methods.ts';
import { ProviderSourceError, readAppliedProviderFields, type GoogleContactFacts } from './provider-sources.ts';

export function providerMethodDraft(facts: GoogleContactFacts, kind: 'email' | 'phone', index: number, id: string) {
  const source = (kind === 'email' ? facts.emails : facts.phones)[index];
  if (!source) throw new ProviderSourceError('This selected source field is no longer available.', 409);
  return { id, kind, value: kind === 'phone' && source.canonical && /^\+[1-9]\d{1,14}$/.test(source.canonical) ? source.canonical : source.value,
    label: source.label, country: null, preferred: false };
}
export function applyProviderMethods(facts: GoogleContactFacts, selection: { emails: number[]; phones: number[] }, previous: unknown, createId: () => string) {
  const current = readContactMethods(previous), methods = [...current];
  const accepted = new Map<string, { method: ContactMethod; source_value: string }>();
  for (const [kind, indexes] of [['email', selection.emails], ['phone', selection.phones]] as const) for (const index of indexes) {
    const candidate = readContactMethods(normalizeUserContactMethods([providerMethodDraft(facts, kind, index, createId())]))[0];
    const existing = methods.find((method) => contactMethodIdentity(method) === contactMethodIdentity(candidate));
    const method = existing ?? candidate;
    if (!existing) methods.push(method);
    if (!accepted.has(method.id)) accepted.set(method.id, { method, source_value: (kind === 'email' ? facts.emails : facts.phones)[index].value });
  }
  for (const kind of ['email', 'phone'] as const) if (!current.some((method) => method.kind === kind) && !methods.some((method) => method.kind === kind && method.preferred)) {
    const first = methods.find((method) => method.kind === kind);
    if (first) first.preferred = true;
  }
  const normalized = normalizeUserContactMethods(methods, previous);
  const final = readContactMethods(normalized);
  const applied = [...accepted.values()].map((item) => ({ ...item, method: final.find((method) => method.id === item.method.id)! }));
  readAppliedProviderFields(JSON.stringify({ name: null, methods: applied }));
  const primary = (kind: 'email' | 'phone') => final.find((method) => method.kind === kind && method.preferred)?.value
    ?? null;
  return { methods: normalized, applied, email: primary('email'), phone: primary('phone') };
}
