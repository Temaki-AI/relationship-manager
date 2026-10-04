import type { SQLiteDatabase } from 'expo-sqlite';
import { readDeviceContactFacts, type DeviceContactFacts } from '../../../../packages/domain/src/device-contact-facts';
import { defaultDeviceRules, observeDeviceMethod, readDeviceRules, reconcileDeviceFields, type DeviceFieldRules } from '../../../../packages/domain/src/device-contact-rules';
import { readAppliedProviderFields, ProviderSourceError } from '../../../../packages/domain/src/provider-sources';
import { normalizeUserContactMethods, readContactMethods } from '../../../../packages/domain/src/contact-methods';
import { getContactForEditing } from './contacts';
import { deviceImportContactRevision } from './device-contacts';
import { enqueueDeviceSource, installationId, type LocalDeviceSource } from './device-source-sync';
import { enqueueSyncIntent } from './sync-queue';
import { signalSyncChange } from './sync-signals';
export type DeviceContactPolicy = { source_id: string; contact_id: string; enabled: number; fields: string; epoch: string | null;
  revision: number; state: string; reason: string | null; last_attempt_at: string | null; last_success_at: string | null; updated_at: string };
export type DeviceReadResult = { state: 'available'; facts: DeviceContactFacts } | { state: 'access_lost' | 'unavailable' | 'error'; reason?: string };
export type DeviceReadIntent = { source: LocalDeviceSource; policy: DeviceContactPolicy; accountScope: string; installation: string; epoch: string | null };
async function epoch(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v3'");
  return row ? (JSON.parse(row.value) as { epoch: string }).epoch : null;
}
async function scope(db: SQLiteDatabase) { return (await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'account-scope'"))?.value ?? ''; }
async function ensurePolicy(db: SQLiteDatabase, source: LocalDeviceSource) {
  await db.runAsync(`INSERT OR IGNORE INTO device_contact_policies (source_id, contact_id, fields, epoch, updated_at) VALUES (?, ?, ?, ?, ?)`, source.id, source.contact_id,
    JSON.stringify(defaultDeviceRules(source)), await epoch(db), new Date().toISOString());
  const policy = (await db.getFirstAsync<DeviceContactPolicy>('SELECT * FROM device_contact_policies WHERE source_id = ?', source.id))!;
  // Explicit later imports may add accepted methods; keep existing choices for existing IDs.
  const current = readDeviceRules(policy.fields), defaults = defaultDeviceRules(source), allowed = new Set(defaults.methods.map((rule) => rule.id));
  const fields = readDeviceRules({ name: current.name, methods: [...current.methods.filter((rule) => allowed.has(rule.id)), ...defaults.methods.filter((rule) => !current.methods.some((item) => item.id === rule.id))] });
  if (JSON.stringify(fields) !== policy.fields) {
    await db.runAsync('UPDATE device_contact_policies SET fields = ?, revision = revision + 1, updated_at = ? WHERE source_id = ?', JSON.stringify(fields), new Date().toISOString(), source.id);
    return (await db.getFirstAsync<DeviceContactPolicy>('SELECT * FROM device_contact_policies WHERE source_id = ?', source.id))!;
  }
  return policy;
}
export async function devicePolicyReview(db: SQLiteDatabase, sourceId: string) {
  let result!: { source: LocalDeviceSource; policy: DeviceContactPolicy; fields: DeviceFieldRules; person: NonNullable<Awaited<ReturnType<typeof getContactForEditing>>>; personRevision: string };
  await db.withExclusiveTransactionAsync(async (tx) => {
    const source = await tx.getFirstAsync<LocalDeviceSource>('SELECT * FROM device_contact_links WHERE id = ?', sourceId);
    if (!source || !source.installation_id || source.installation_id !== await installationId(tx)) throw new ProviderSourceError('Choose this contact on its original phone before setting recurring reads.');
    const person = await getContactForEditing(tx, source.contact_id); if (!person || person.id !== source.contact_id) throw new ProviderSourceError('This relationship changed. Reopen its profile.');
    const policy = await ensurePolicy(tx, source);
    result = { source, policy, fields: readDeviceRules(policy.fields), person, personRevision: deviceImportContactRevision(person) };
  }); return result;
}
export type DevicePolicyChoice = { expected_policy_revision: number; expected_source_revision: number; expected_person: string; enabled: boolean;
  name: 'keep' | 'follow'; methods: { id: string; mode: 'keep' | 'follow'; slot_index?: number }[]; reset: string[] };
/** Field resets apply only the displayed observation; consent never grants write-back or imports new people. */
export async function changeDevicePolicy(db: SQLiteDatabase, sourceId: string, choice: DevicePolicyChoice) {
  if (typeof choice.enabled !== 'boolean' || !['keep', 'follow'].includes(choice.name) || !Array.isArray(choice.methods) || !Array.isArray(choice.reset)
    || new Set(choice.methods.map((item) => item.id)).size !== choice.methods.length || new Set(choice.reset).size !== choice.reset.length) throw new ProviderSourceError('Review the selected iPhone field choices.');
  await db.withExclusiveTransactionAsync(async (tx) => {
    const source = await tx.getFirstAsync<LocalDeviceSource>('SELECT * FROM device_contact_links WHERE id = ?', sourceId);
    if (!source || source.installation_id !== await installationId(tx)) throw new ProviderSourceError('This source belongs to another phone.');
    const person = await getContactForEditing(tx, source.contact_id), current = await ensurePolicy(tx, source);
    if (!person || person.id !== source.contact_id || deviceImportContactRevision(person) !== choice.expected_person
      || current.revision !== choice.expected_policy_revision || source.revision !== choice.expected_source_revision) throw new ProviderSourceError('This person, source or setting changed. Refresh while keeping your choices.');
    const fields = readDeviceRules(current.fields), facts = readDeviceContactFacts(source.observed_facts), methods = readContactMethods(person.contact_methods);
    if (choice.methods.length !== fields.methods.length || choice.methods.some((item) => !['keep', 'follow'].includes(item.mode) || !fields.methods.some((rule) => rule.id === item.id))
      || choice.reset.some((key) => key !== 'name' && !fields.methods.some((rule) => rule.id === key))) throw new ProviderSourceError('Choose only accepted source fields.');
    let name = person.name; const reset = new Set(choice.reset);
    fields.name.mode = choice.name;
    if (reset.has('name')) { if (!facts.name) throw new ProviderSourceError('The selected source has no name to use.'); name = facts.name; fields.name.last_applied = name; fields.name.overridden = false; fields.name.issue = null; }
    if (choice.enabled && choice.name === 'follow' && (fields.name.overridden || fields.name.last_applied !== name)) throw new ProviderSourceError('Confirm Use iPhone value to replace the current name and resume following it.');
    for (const rule of fields.methods) {
      const selected = choice.methods.find((item) => item.id === rule.id)!;
      rule.mode = selected.mode;
      const method = methods.find((item) => item.id === rule.id && item.kind === rule.kind);
      if (selected.slot_index !== undefined) {
        const slots = rule.kind === 'email' ? facts.emails : facts.phones, slot = slots[selected.slot_index];
        if (!Number.isSafeInteger(selected.slot_index) || !slot || !reset.has(rule.id)) throw new ProviderSourceError('Confirm Use iPhone value when choosing another source field.');
        rule.slot = slot;
      }
      if (reset.has(rule.id)) {
        const observation = observeDeviceMethod(rule, facts);
        if (!method || observation.index === null) throw new ProviderSourceError('That source field is missing or ambiguous. Choose the contact again to review it.');
        // Explicit reset uses the same validated reconciliation path, retaining labels and preference.
        const only = reconcileDeviceFields({ name: { ...fields.name, mode: 'keep' }, methods: [{ ...rule, mode: 'follow', overridden: false, last_applied: method.value }] }, name, JSON.stringify(methods), facts);
        if (only.fields.methods[0].issue) throw new ProviderSourceError('The source value cannot be applied. Review it manually.');
        Object.assign(method, readContactMethods(only.methods).find((item) => item.id === rule.id)); Object.assign(rule, only.fields.methods[0], { mode: choice.methods.find((item) => item.id === rule.id)!.mode });
      }
      if (choice.enabled && rule.mode === 'follow' && (rule.overridden || !method || method.value !== rule.last_applied)) throw new ProviderSourceError('Confirm Use iPhone value to replace the correction and resume following it.');
    }
    // A field may follow only one local device source. Keep mode changes remain available.
    const other = await tx.getAllAsync<{ fields: string }>('SELECT fields FROM device_contact_policies WHERE contact_id = ? AND source_id != ? AND enabled = 1', person.id, sourceId);
    if (choice.enabled && other.some((row) => { const rules = readDeviceRules(row.fields); return fields.name.mode === 'follow' && rules.name.mode === 'follow'
      || fields.methods.some((rule) => rule.mode === 'follow' && rules.methods.some((other) => other.id === rule.id && other.mode === 'follow')); })) throw new ProviderSourceError('Another iPhone source follows one of these fields. Keep that field there before choosing this source.');
    const now = new Date().toISOString();
    await tx.runAsync(`UPDATE device_contact_policies SET enabled = ?, fields = ?, epoch = ?, revision = revision + 1,
      state = 'idle', reason = NULL, updated_at = ? WHERE source_id = ?`, choice.enabled ? 1 : 0, JSON.stringify(readDeviceRules(fields)), await epoch(tx), now, sourceId);
    const normalized = normalizeUserContactMethods(methods, person.contact_methods);
    await savePersonPatch(tx, person, name, JSON.stringify(readContactMethods(person.contact_methods)) === JSON.stringify(readContactMethods(normalized)) ? person.contact_methods : normalized, now);
    if (reset.has('name')) {
      const audit = readAppliedProviderFields(source.applied_fields);
      if (audit.name === null) {
        await tx.runAsync('UPDATE device_contact_links SET applied_fields = ?, revision = revision + 1, updated_at = ? WHERE id = ?', JSON.stringify({ ...audit, name }), now, sourceId);
        if (source.shared) await enqueueDeviceSource(tx, (await tx.getFirstAsync<LocalDeviceSource>('SELECT * FROM device_contact_links WHERE id = ?', sourceId))!, 'publish');
      }
    }
  }); signalSyncChange(db);
}
async function savePersonPatch(tx: SQLiteDatabase, person: NonNullable<Awaited<ReturnType<typeof getContactForEditing>>>, name: string, methods: string, now: string) {
  const patch = { ...(person.name !== name ? { name } : {}), ...(person.contact_methods !== methods ? { contact_methods: methods } : {}) };
  if (!Object.keys(patch).length) return;
  const parsed = readContactMethods(methods);
  await tx.runAsync(`UPDATE contacts SET name = ?, contact_methods = ?, email = ?, phone = ?, updated_at = ?, sync_state = CASE WHEN EXISTS
    (SELECT 1 FROM sync_queue WHERE entity_type = 'contact' AND entity_id = ? AND status = 'conflict') THEN 'conflict' ELSE 'pending' END WHERE id = ?`, name, methods,
    parsed.find((method) => method.kind === 'email' && method.preferred)?.value ?? null, parsed.find((method) => method.kind === 'phone' && method.preferred)?.value ?? null, now, person.id, person.id);
  await enqueueSyncIntent(tx, 'contact', person.id, 'update', patch, now, { revision: person.remote_revision,
    values: Object.fromEntries(Object.keys(patch).map((key) => [key, person[key as keyof typeof person] ?? null])) });
}
export async function holdDevicePoliciesForEpoch(db: SQLiteDatabase, currentEpoch: string) {
  await db.runAsync("UPDATE device_contact_policies SET enabled = 0, state = 'needs_review', reason = 'restored', revision = revision + 1 WHERE epoch IS NOT NULL AND epoch != ? AND (enabled = 1 OR reason IS NOT 'restored')", currentEpoch);
}
export async function nextDeviceReads(db: SQLiteDatabase, forceSource?: string) {
  const installation = await installationId(db); if (!installation) return [];
  let result: DeviceReadIntent[] = [];
  await db.withExclusiveTransactionAsync(async (tx) => {
    const currentEpoch = await epoch(tx); if (currentEpoch) await holdDevicePoliciesForEpoch(tx, currentEpoch);
    const policies = await tx.getAllAsync<DeviceContactPolicy>(`SELECT policy.* FROM device_contact_policies policy JOIN device_contact_links source ON source.id = policy.source_id
      JOIN contacts person ON person.id = source.contact_id WHERE policy.enabled = 1 AND source.installation_id = ? AND person.deleted_at IS NULL
      ${forceSource ? 'AND policy.source_id = ?' : 'AND (policy.last_attempt_at IS NULL OR policy.last_attempt_at < ?)'}
      ORDER BY COALESCE(policy.last_attempt_at, ''), policy.source_id LIMIT 20`, installation, forceSource ?? new Date(Date.now() - 60 * 60_000).toISOString());
    const accountScope = await scope(tx);
    result = [];
    for (const policy of policies) {
      const source = (await tx.getFirstAsync<LocalDeviceSource>('SELECT * FROM device_contact_links WHERE id = ?', policy.source_id))!;
      if (policy.contact_id !== source.contact_id || await tx.getFirstAsync(`SELECT id FROM sync_queue WHERE entity_type = 'contact' AND (entity_id = ? OR entity_id IN
        (SELECT id FROM contact_aliases WHERE canonical_id = ?)) LIMIT 1`, source.contact_id, source.contact_id)
        || await tx.getFirstAsync('SELECT id FROM device_source_queue WHERE source_id = ? LIMIT 1', source.id)) continue;
      result.push({ source, policy, accountScope, installation, epoch: currentEpoch });
    }
  }); return result;
}
/** CAS fences a read finishing after account/permission settings, unlink, merge, edits or restore. */
export async function commitDeviceRead(db: SQLiteDatabase, intent: DeviceReadIntent, value: DeviceReadResult, isCurrent: () => boolean = () => true) {
  let changed = false;
  await db.withExclusiveTransactionAsync(async (tx) => {
    if (!isCurrent() || await scope(tx) !== intent.accountScope || await installationId(tx) !== intent.installation || await epoch(tx) !== intent.epoch) return;
    const source = await tx.getFirstAsync<LocalDeviceSource>('SELECT * FROM device_contact_links WHERE id = ? AND revision = ? AND contact_id = ?', intent.source.id, intent.source.revision, intent.source.contact_id);
    const policy = await tx.getFirstAsync<DeviceContactPolicy>('SELECT * FROM device_contact_policies WHERE source_id = ? AND revision = ? AND enabled = 1', intent.source.id, intent.policy.revision);
    const person = source ? await getContactForEditing(tx, source.contact_id) : null;
    if (!source || !policy || !person || person.id !== source.contact_id || await tx.getFirstAsync(`SELECT id FROM sync_queue WHERE entity_type = 'contact' AND (entity_id = ? OR entity_id IN
      (SELECT id FROM contact_aliases WHERE canonical_id = ?)) LIMIT 1`, person.id, person.id)
      || await tx.getFirstAsync('SELECT id FROM device_source_queue WHERE source_id = ? LIMIT 1', source.id)) return;
    const now = new Date().toISOString();
    if (value.state !== 'available') {
      await tx.runAsync('UPDATE device_contact_policies SET state = ?, reason = ?, last_attempt_at = ?, revision = revision + 1, updated_at = ? WHERE source_id = ?', value.state, value.reason ?? value.state, now, now, source.id);
      changed = true; return;
    }
    const facts = readDeviceContactFacts(value.facts);
    if (facts.device_id !== source.device_contact_id) throw new ProviderSourceError('The contact read returned another source identity.');
    const reconciled = reconcileDeviceFields(readDeviceRules(policy.fields), person.name, person.contact_methods, facts), observed = JSON.stringify(facts);
    const fields = JSON.stringify(reconciled.fields);
    await tx.runAsync("UPDATE device_contact_policies SET fields = ?, state = 'available', reason = NULL, last_attempt_at = ?, last_success_at = ?, revision = revision + 1, updated_at = ? WHERE source_id = ?", fields, now, now, now, source.id);
    await savePersonPatch(tx, person, reconciled.name, reconciled.methods, now);
    if (observed !== source.observed_facts) {
      await tx.runAsync('UPDATE device_contact_links SET observed_facts = ?, observed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?', observed, now, now, source.id);
      const collection = await tx.getAllAsync<LocalDeviceSource>('SELECT * FROM device_contact_links WHERE contact_id = ?', person.id);
      if (collection.length > 32 || new TextEncoder().encode(JSON.stringify(collection)).byteLength > 131072) throw new ProviderSourceError('This person has reached the saved iPhone source limit.');
      if (source.shared) await enqueueDeviceSource(tx, collection.find((row) => row.id === source.id)!, 'publish');
    }
    changed = true;
  }); if (changed) signalSyncChange(db); return changed;
}
