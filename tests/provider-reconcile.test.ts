import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProviderMethods } from '../packages/domain/src/provider-import.ts';
import { defaultProviderRules, readProviderRules } from '../packages/domain/src/provider-rules.ts';
import { reconcileProviderFields } from '../packages/domain/src/provider-reconcile.ts';
import { normalizeUserContactMethods, readContactMethods } from '../packages/domain/src/contact-methods.ts';
import type { GoogleContactFacts, ProviderSource } from '../packages/domain/src/provider-sources.ts';
function fixture() {
  const facts: GoogleContactFacts = { sourceId: 'a', resourceName: 'people/a', etag: null, name: 'Ana', company: null, title: null, location: null,
    emails: [{ value: 'ana@example.test', label: 'work', primary: true, canonical: null }], phones: [{ value: '+351912345678', label: 'mobile', primary: true, canonical: '+351912345678' }] };
  const applied = applyProviderMethods(facts, { emails: [0], phones: [0] }, '[]', () => crypto.randomUUID());
  const fields = defaultProviderRules({ original_facts: JSON.stringify(facts), applied_fields: JSON.stringify({ name: 'Ana', methods: applied.applied }) } as ProviderSource);
  return { facts, methods: applied.methods, fields };
}
test('following changes accepted values while preserving identities, preferences, labels and provenance', () => {
  const { facts, fields, methods } = fixture(); fields.name.mode = 'follow'; fields.methods.forEach((rule) => rule.mode = 'follow');
  const custom = normalizeUserContactMethods(readContactMethods(methods).map((method) => ({ ...method, label: 'My label', preferred: false })), methods);
  facts.name = 'Ana updated'; facts.emails[0].value = 'new@example.test'; facts.phones[0].canonical = '+351912000000'; facts.phones[0].value = '+351 912 000 000';
  const next = reconcileProviderFields(fields, 'Ana', custom, facts);
  assert.equal(next.name, 'Ana updated'); assert.equal(next.email, null); assert.equal(next.phone, null);
  const result = readContactMethods(next.methods); assert.deepEqual(result.map((m) => m.id), readContactMethods(custom).map((m) => m.id));
  assert.ok(result.every((m) => m.label === 'My label' && !m.preferred)); assert.equal(result.find((m) => m.kind === 'email')!.value, 'new@example.test');
  assert.ok(next.fields.methods.every((rule) => !rule.overridden && rule.issue === null));
});
test('keep and sticky overrides preserve values even when the user returns to a former source value', () => {
  const { facts, fields, methods } = fixture(); fields.methods[0].mode = 'follow'; fields.methods[0].overridden = true;
  facts.name = 'Changed'; facts.emails[0].value = 'changed@example.test';
  const next = reconcileProviderFields(fields, 'Ana', methods, facts); assert.equal(next.name, 'Ana'); assert.equal(next.methods, methods); assert.equal(next.fields.methods[0].overridden, true);
});
test('missing, ambiguous and invalid source methods retain data and never use array position or primary preference as identity', () => {
  const { facts, fields, methods } = fixture(); fields.methods.forEach((rule) => rule.mode = 'follow');
  facts.emails = [{ ...facts.emails[0], value: 'first@example.test' }, { ...facts.emails[0], value: 'second@example.test', primary: false }];
  facts.phones[0] = { ...facts.phones[0], value: 'call me', canonical: null };
  const next = reconcileProviderFields(fields, 'Ana', methods, facts);
  assert.equal(next.methods, methods); assert.equal(next.fields.methods.find((rule) => rule.kind === 'email')!.issue, 'ambiguous'); assert.equal(next.fields.methods.find((rule) => rule.kind === 'phone')!.issue, 'invalid');
  facts.emails = []; assert.equal(reconcileProviderFields(fields, 'Ana', methods, facts).fields.methods.find((rule) => rule.kind === 'email')!.issue, 'missing');
});
test('removed methods are protected while missing source records retain the person and resume unchanged followed fields after reappearance', () => {
  const { facts, fields, methods } = fixture(); fields.name.mode = 'follow'; fields.methods.forEach((rule) => rule.mode = 'follow');
  const removed = normalizeUserContactMethods(readContactMethods(methods).filter((method) => method.kind !== 'email'), methods);
  const absent = reconcileProviderFields(fields, 'Ana', removed, null); assert.equal(absent.name, 'Ana'); assert.equal(absent.methods, removed);
  assert.equal(absent.fields.methods.find((rule) => rule.kind === 'email')!.overridden, true);
  facts.name = 'New Ana'; facts.phones[0].value = facts.phones[0].canonical = '+351912000000';
  const returned = reconcileProviderFields(absent.fields, absent.name, absent.methods, facts); assert.equal(returned.name, 'New Ana'); assert.equal(readContactMethods(returned.methods).length, 1);
});
test('field rule decoding rejects extra keys, repeated identifiers and oversized collections', () => {
  const { fields } = fixture(); assert.throws(() => readProviderRules({ ...fields, extra: true })); assert.throws(() => readProviderRules({ ...fields, methods: [fields.methods[0], fields.methods[0]] }));
  assert.throws(() => readProviderRules({ ...fields, name: { ...fields.name, overridden: 'true' } }));
});
