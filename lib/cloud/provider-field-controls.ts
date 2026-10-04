import { readContactMethods, normalizeUserContactMethods } from '@/packages/domain/src/contact-methods';
import { applyProviderMethods, providerMethodDraft } from '@/packages/domain/src/provider-import';
import { defaultProviderRules, readProviderRules, type ProviderFieldRules, type SavedProviderRules } from '@/packages/domain/src/provider-rules';
import { reconcileProviderFields } from '@/packages/domain/src/provider-reconcile';
import { providerSourceProjection, readAppliedProviderFields, readProviderFacts, ProviderSourceError, type ProviderSource } from '@/packages/domain/src/provider-sources';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { EDITABLE_CONTACT_FIELDS, getContactEditRevision, getExpectedContactRevision } from '@/lib/contact-revision';
import type { Contact } from '@/lib/db';
import { requireProviderOwner, type ConnectionActor } from './provider-connections';
import { maintenanceGuard, removeGuard } from './recovery-storage';
type DB = CloudflareEnv['DB'];
export type ProviderRuleRow = { id: number; workspace_id: string; source_link_id: number; fields: string; revision: number; updated_at: string };
export type ProviderLinkRow = ProviderSource & { id: number; workspace_id: string; contact_id: number };

export async function savedProviderRules(db: DB, workspaceId: string, links: ProviderLinkRow[]): Promise<SavedProviderRules[]> {
  const rows = links.length ? (await db.prepare('SELECT * FROM provider_field_rules WHERE workspace_id = ? AND source_link_id IN (SELECT value FROM json_each(?))')
    .bind(workspaceId, JSON.stringify(links.map((link) => link.id))).all<ProviderRuleRow>()).results : [];
  return links.map((link) => { const row = rows.find((row: ProviderRuleRow) => row.source_link_id === link.id);
    return { source_public_id: link.public_id, revision: row?.revision ?? 0, fields: row ? readProviderRules(row.fields) : defaultProviderRules(providerSourceProjection(link)) };
  });
}
export function suspendMergedProviderRules(db: DB, workspaceId: string, contactIds: number[]) {
  return db.prepare(`UPDATE provider_field_rules SET fields = json_set(fields,
    '$.name.mode', CASE WHEN json_extract(fields, '$.name.mode') = 'follow' THEN 'keep' ELSE json_extract(fields, '$.name.mode') END,
    '$.name.overridden', json(CASE WHEN json_extract(fields, '$.name.mode') = 'follow' OR json_extract(fields, '$.name.overridden') = 1 THEN 'true' ELSE 'false' END),
    '$.methods', json((SELECT json_group_array(json(CASE WHEN json_extract(f.value, '$.mode') = 'follow' THEN json_set(f.value, '$.mode', 'keep', '$.overridden', json('true')) ELSE f.value END)) FROM json_each(fields, '$.methods') f))),
    revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?
    AND source_link_id IN (SELECT id FROM contact_provider_links WHERE workspace_id = ? AND contact_id IN (SELECT value FROM json_each(?)))
    AND (json_extract(fields, '$.name.mode') = 'follow' OR EXISTS (SELECT 1 FROM json_each(fields, '$.methods') WHERE json_extract(value, '$.mode') = 'follow'))`)
    .bind(workspaceId, workspaceId, JSON.stringify(contactIds));
}
function indexes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((index) => !Number.isInteger(index) || index < 0 || index > 99) || new Set(value).size !== value.length) throw new ProviderSourceError('Choose each source field only once.');
  return value;
}
export async function changeProviderFields(db: DB, actor: ConnectionActor, contactId: number, sourceId: string, body: Record<string, unknown>) {
  await requireProviderOwner(db, actor);
  const allowed = ['action', 'expected_epoch', 'expected_revision', 'expected_policy_revision', 'expected_edit_revision', 'name_mode', 'methods', 'field', 'method_id', 'source_index', 'emails', 'phones', 'follow'];
  if (Object.keys(body).some((key) => !allowed.includes(key)) || !isSyncUuid(sourceId) || !isSyncUuid(body.expected_epoch)
    || !Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 1
    || !Number.isSafeInteger(body.expected_policy_revision) || Number(body.expected_policy_revision) < 0
    || !['settings', 'reset', 'accept'].includes(String(body.action))) throw new ProviderSourceError('Refresh these source field choices before saving.');
  const link = await db.prepare('SELECT * FROM contact_provider_links WHERE workspace_id = ? AND contact_id = ? AND public_id = ?').bind(actor.workspaceId, contactId, sourceId).first<ProviderLinkRow>();
  const contact = await db.prepare('SELECT * FROM contacts WHERE workspace_id = ? AND id = ?').bind(actor.workspaceId, contactId).first<Contact>();
  if (!link || !contact) throw new ProviderSourceError('The person or source is no longer available.', 404);
  if (link.revision !== body.expected_revision || getContactEditRevision(contact) !== getExpectedContactRevision(body)) throw new ProviderSourceError('This person or source changed. Refresh while keeping your choices.', 409);
  const previous = await db.prepare('SELECT * FROM provider_field_rules WHERE workspace_id = ? AND source_link_id = ?').bind(actor.workspaceId, link.id).first<ProviderRuleRow>();
  if ((previous?.revision ?? 0) !== body.expected_policy_revision) throw new ProviderSourceError('These source field choices changed. Refresh before saving.', 409);
  let fields: ProviderFieldRules = previous ? readProviderRules(previous.fields) : defaultProviderRules(providerSourceProjection(link));
  const facts = readProviderFacts(link.observed_facts), audit = readAppliedProviderFields(link.applied_fields);
  let name = contact.name, methods = contact.contact_methods, applied = link.applied_fields;
  if (body.action === 'settings') {
    if (body.name_mode !== undefined) { if (!['keep', 'follow'].includes(String(body.name_mode))) throw new ProviderSourceError('Choose whether to keep or follow the source name.'); fields.name.mode = body.name_mode as 'keep' | 'follow'; }
    if (body.methods !== undefined) {
      if (!Array.isArray(body.methods) || body.methods.length > 256) throw new ProviderSourceError('Use valid method choices.');
      const ids = new Set<string>();
      for (const item of body.methods) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 || !isSyncUuid(item.id) || ids.has(item.id) || !['keep', 'follow'].includes(item.mode)) throw new ProviderSourceError('Choose each method setting only once.');
        ids.add(item.id); const rule = fields.methods.find((rule) => rule.id === item.id);
        if (!rule) throw new ProviderSourceError('Only fields accepted from this source can follow it.'); rule.mode = item.mode;
      }
    }
    const reconciled = reconcileProviderFields(fields, name, methods, link.status === 'available' ? facts : null);
    fields = reconciled.fields; name = reconciled.name; methods = reconciled.methods;
  } else if (body.action === 'reset') {
    if (body.field === 'name') {
      if (!facts.name) throw new ProviderSourceError('The saved source has no name to use.'); name = facts.name;
      fields.name = { ...fields.name, overridden: false, last_applied: name, issue: null };
    } else if (body.field === 'method') {
      const rule = fields.methods.find((rule) => rule.id === body.method_id);
      if (!rule || !Number.isInteger(body.source_index) || Number(body.source_index) < 0 || Number(body.source_index) > 99) throw new ProviderSourceError('Choose a saved source method to use.');
      const draft = providerMethodDraft(facts, rule.kind, Number(body.source_index), rule.id), current = readContactMethods(methods);
      const existing = current.find((method) => method.id === rule.id);
      const original = audit.methods.find((item) => item.method.id === rule.id)!.method;
      const restored = existing ? { ...existing, value: draft.value } : { ...original, value: draft.value, preferred: false };
      methods = normalizeUserContactMethods([...current.filter((method) => method.id !== rule.id), restored], methods);
      rule.last_applied = readContactMethods(methods).find((method) => method.id === rule.id)!.value; rule.overridden = false; rule.issue = null;
      rule.slot = (rule.kind === 'email' ? facts.emails : facts.phones)[Number(body.source_index)];
    } else throw new ProviderSourceError('Choose a source field to reset.');
  } else {
    if (body.follow !== undefined && typeof body.follow !== 'boolean') throw new ProviderSourceError('Use a valid field update choice.');
    const selection = { emails: indexes(body.emails), phones: indexes(body.phones) }, accepted = applyProviderMethods(facts, selection, methods, () => crypto.randomUUID());
    methods = accepted.methods;
    const newAudit = [...audit.methods];
    for (const item of accepted.applied) {
      if (!newAudit.some((original) => original.method.id === item.method.id)) newAudit.push(item);
      const rule = fields.methods.find((rule) => rule.id === item.method.id), kind = item.method.kind as 'email' | 'phone';
      const chosen = (kind === 'email' ? selection.emails : selection.phones).find((index) => (kind === 'email' ? facts.emails : facts.phones)[index].value === item.source_value)!;
      const approved = { id: item.method.id, kind, mode: body.follow === true ? 'follow' as const : 'keep' as const, overridden: false, issue: null,
        last_applied: item.method.value, slot: (kind === 'email' ? facts.emails : facts.phones)[chosen] };
      if (rule) Object.assign(rule, approved); else fields.methods.push(approved);
    }
    applied = JSON.stringify({ ...audit, methods: newAudit }); readAppliedProviderFields(applied);
  }
  const fieldsJson = JSON.stringify(readProviderRules(fields)), final = readContactMethods(methods), now = new Date().toISOString(), guard = crypto.randomUUID();
  const statements = [maintenanceGuard(db, guard, `EXISTS (SELECT 1 FROM workspace_sync_state s JOIN workspaces w ON w.id = s.workspace_id
      JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = ? AND m.role = 'owner'
      WHERE s.workspace_id = ? AND s.epoch = ? AND s.paused = 0 AND w.lifecycle = 'active')
      AND EXISTS (SELECT 1 FROM contact_provider_links WHERE workspace_id = ? AND id = ? AND contact_id = ? AND revision = ?)
      AND ${previous ? 'EXISTS (SELECT 1 FROM provider_field_rules WHERE workspace_id = ? AND source_link_id = ? AND revision = ?)' : 'NOT EXISTS (SELECT 1 FROM provider_field_rules WHERE workspace_id = ? AND source_link_id = ?)'}
      AND EXISTS (SELECT 1 FROM contacts WHERE workspace_id = ? AND id = ? AND ${EDITABLE_CONTACT_FIELDS.map((key) => `${key} IS ?`).join(' AND ')})`,
    [actor.userId, actor.workspaceId, body.expected_epoch, actor.workspaceId, link.id, contactId, link.revision, actor.workspaceId, link.id, ...(previous ? [previous.revision] : []), actor.workspaceId, contactId, ...EDITABLE_CONTACT_FIELDS.map((key) => contact[key] ?? null)]),
    ...(applied !== link.applied_fields ? [db.prepare('UPDATE contact_provider_links SET applied_fields = ?, revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND id = ?').bind(applied, now, actor.workspaceId, link.id)] : []),
    db.prepare(`INSERT INTO provider_field_rules (workspace_id, source_link_id, fields, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, source_link_id) DO UPDATE SET fields = excluded.fields, revision = provider_field_rules.revision + 1, updated_at = excluded.updated_at`).bind(actor.workspaceId, link.id, fieldsJson, now),
    ...(name !== contact.name || methods !== contact.contact_methods ? [db.prepare('UPDATE contacts SET name = ?, contact_methods = ?, email = ?, phone = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .bind(name, methods, final.find((method) => method.kind === 'email' && method.preferred)?.value ?? null, final.find((method) => method.kind === 'phone' && method.preferred)?.value ?? null, now, actor.workspaceId, contactId)] : []),
    removeGuard(db, guard)];
  await db.batch(statements); return { success: true };
}
