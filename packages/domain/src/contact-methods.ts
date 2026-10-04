import { isSyncUuid } from './sync.ts';

export const MAX_CONTACT_METHODS = 256;
export const MAX_CONTACT_METHOD_BYTES = 384 * 1024;
export type ContactMethodKind = 'email' | 'phone' | 'profile';
export type ContactMethod = {
  id: string; kind: ContactMethodKind; value: string; label: string | null; country: string | null;
  preferred: boolean; source: 'manual' | 'legacy'; source_value: string | null; user_override: boolean;
};
export type ContactMethodDraft = Pick<ContactMethod, 'id' | 'kind' | 'value' | 'label' | 'country' | 'preferred'>;
export class ContactMethodError extends Error {}
function fail(message: string): never { throw new ContactMethodError(message); }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, limit: number, label: string, optional = false): string | null {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) return fail(`${label} must be valid text, up to ${limit} characters.`);
  return value.trim();
}
function draft(value: unknown): ContactMethodDraft {
  if (!object(value) || !isSyncUuid(value.id) || !['email', 'phone', 'profile'].includes(String(value.kind)) || typeof value.preferred !== 'boolean') return fail('Invalid contact method identity or type.');
  const kind = value.kind as ContactMethodKind, raw = text(value.value, kind === 'email' ? 320 : kind === 'phone' ? 100 : 2048, 'Contact value')!;
  if (kind === 'email' && !/^[^\s@]+@[^\s@]+$/u.test(raw)) return fail('Enter a valid email address.');
  if (kind === 'profile') {
    try { const url = new URL(raw); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
    catch { return fail('Enter a full HTTP or HTTPS profile URL without credentials.'); }
  }
  const country = text(value.country, 2, 'Phone country', true)?.toUpperCase() ?? null;
  if (country && (kind !== 'phone' || !/^[A-Z]{2}$/u.test(country))) return fail('Phone country must be a two-letter country code.');
  return { id: value.id, kind, value: raw, label: text(value.label, 80, 'Label', true), country, preferred: value.preferred };
}
function list(value: unknown): unknown[] {
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > MAX_CONTACT_METHOD_BYTES) return fail('Contact methods are too large.');
    try { value = JSON.parse(value); } catch { return fail('Contact methods must contain valid JSON.'); }
  }
  if (!Array.isArray(value) || value.length > MAX_CONTACT_METHODS) return fail(`Use at most ${MAX_CONTACT_METHODS} contact methods.`);
  return value;
}
function validateList(methods: ContactMethod[]) {
  const ids = new Set<string>(), preferred = new Set<string>();
  for (const method of methods) {
    if (ids.has(method.id)) return fail('Each method must have its own identity.'); ids.add(method.id);
    if (method.preferred && preferred.has(method.kind)) return fail('Choose only one preferred method of each type.');
    if (method.preferred) preferred.add(method.kind);
  }
  if (new TextEncoder().encode(JSON.stringify(methods)).byteLength > MAX_CONTACT_METHOD_BYTES) return fail('Contact methods are too large.');
  return methods;
}
export function readContactMethods(value: unknown): ContactMethod[] {
  if (value === undefined) return []; // Earlier protocol versions and opening forms.
  return validateList(list(value).map((raw) => {
    const item = draft(raw);
    if (!object(raw) || !['manual', 'legacy'].includes(String(raw.source)) || typeof raw.user_override !== 'boolean') return fail('Invalid contact method provenance.');
    const sourceValue = raw.source_value === null ? null : text(raw.source_value, item.kind === 'profile' ? 2048 : item.kind === 'email' ? 320 : 100, 'Original value');
    if (raw.source === 'manual' && (sourceValue !== null || !raw.user_override) || raw.source === 'legacy' && sourceValue === null) return fail('Invalid original contact value.');
    return { ...item, source: raw.source as ContactMethod['source'], source_value: sourceValue === null ? null : raw.source_value as string, user_override: raw.user_override };
  }));
}
/** User input supplies fields only. Provenance is inherited from the guarded original row. */
export function normalizeUserContactMethods(value: unknown, previous: unknown = '[]'): string {
  const existing = new Map(readContactMethods(previous).map((item) => [item.id, item]));
  const methods = validateList(list(value).map((raw): ContactMethod => {
    const input = draft(raw), original = existing.get(input.id);
    if (original && original.kind !== input.kind) return fail('Add a new method to change its type.');
    return { ...input, source: original?.source ?? 'manual', source_value: original?.source_value ?? null,
      user_override: !original || original.user_override || input.value !== original.value };
  })).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(methods);
}
/** Matching never rewrites the displayed value or guesses a local phone's country. */
export function contactMethodIdentity(method: Pick<ContactMethod, 'kind' | 'value' | 'country'>) {
  const raw = method.value.trim().normalize('NFC');
  const value = method.kind === 'email' ? raw.toLowerCase() : method.kind === 'phone' && /^\+?[0-9 ()\-.]+$/u.test(raw)
    ? raw.replace(/[ ()\-.]/gu, '') : method.kind === 'profile' ? new URL(raw).href : raw;
  return `${method.kind}:${method.kind === 'phone' && !value.startsWith('+') ? method.country ?? 'unknown' : ''}:${value}`;
}
export function contactMethodHref(method: Pick<ContactMethod, 'kind' | 'value'>) {
  return method.kind === 'email' ? `mailto:${encodeURIComponent(method.value)}` : method.kind === 'phone' ? `tel:${encodeURIComponent(method.value)}` : method.value;
}
export function mergeContactMethods(collections: unknown[]): string {
  const ids = new Map<string, ContactMethod>(), preferred = new Set<string>();
  for (const collection of collections) for (const method of readContactMethods(collection)) {
    const existing = ids.get(method.id);
    if (existing) {
      if (existing.kind !== method.kind || existing.value !== method.value) return fail('Two methods share an identity. Review them before merging these people.');
      continue;
    }
    const chosen = method.preferred && !preferred.has(method.kind);
    if (chosen) preferred.add(method.kind);
    ids.set(method.id, { ...method, preferred: chosen });
  }
  return JSON.stringify(validateList([...ids.values()]).sort((a, b) => a.id.localeCompare(b.id)));
}

export function replacePrimaryContactMethods(previous: unknown, values: { email?: string | null; phone?: string | null }, createId: () => string) {
  let methods = readContactMethods(previous);
  for (const kind of ['email', 'phone'] as const) {
    if (!(kind in values)) continue;
    const value = values[kind], preferred = methods.find((item) => item.kind === kind && item.preferred);
    if (preferred) methods = value ? methods.map((item) => item.id === preferred.id ? { ...item, value } : item) : methods.filter((item) => item.id !== preferred.id);
    else if (value) methods.push({ id: createId(), kind, value, label: null, country: null, preferred: true, source: 'manual', source_value: null, user_override: true });
  }
  return normalizeUserContactMethods(methods, previous);
}
/** Review applies only the original draft's changes; newly merged/web methods stay attached. */
export function reviewContactMethodsPatch(previous: unknown, proposed: unknown, current: unknown) {
  const original = readContactMethods(previous), proposedMethods = readContactMethods(proposed), currentMethods = readContactMethods(current);
  const result = new Map(currentMethods.map((item) => [item.id, item]));
  const mappedIds = new Map<string, string>(), claimedIds = new Set(original.filter((item) => result.has(item.id)).map((item) => item.id));
  // An older cache generated legacy method IDs independently. Explicit review
  // can attach its unmodified original value to one unambiguous current method.
  for (const item of original) {
    if (result.has(item.id) || item.source !== 'legacy' || item.user_override || item.source_value !== item.value) continue;
    const matches = currentMethods.filter((method) => contactMethodIdentity(method) === contactMethodIdentity(item));
    if (matches.length === 1 && !claimedIds.has(matches[0].id)) { mappedIds.set(item.id, matches[0].id); claimedIds.add(matches[0].id); }
  }
  const remap = (item: ContactMethod) => ({ ...item, id: mappedIds.get(item.id) ?? item.id });
  const base = new Map(original.map(remap).map((item) => [item.id, item])), phone = new Map(proposedMethods.map(remap).map((item) => [item.id, item]));
  for (const id of base.keys()) if (!phone.has(id)) result.delete(id);
  for (const [id, item] of phone) {
    const old = base.get(id), keys = ['kind', 'value', 'label', 'country', 'preferred'] as const;
    if (!old || keys.some((key) => item[key] !== old[key])) {
      const changed = old ? Object.fromEntries(keys.filter((key) => item[key] !== old[key]).map((key) => [key, item[key]])) : item;
      const merged = { ...(result.get(id) ?? item), ...changed } as ContactMethod;
      if (merged.preferred && (!old || !result.has(id) || item.preferred !== old.preferred)) for (const [otherId, other] of result) if (other.kind === item.kind && otherId !== id) result.set(otherId, { ...other, preferred: false });
      result.set(id, merged);
    }
  }
  return normalizeUserContactMethods([...result.values()], current);
}
export function describeContactMethods(value: unknown) {
  return readContactMethods(value).map((item) => `${item.label ?? item.kind}: ${item.value}${item.preferred ? ' (preferred)' : ''}`).join('\n') || '(none)';
}
