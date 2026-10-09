import { defaultProviderRules, readProviderRules } from '@/packages/domain/src/provider-rules';
import { reconcileProviderFields } from '@/packages/domain/src/provider-reconcile';
import { providerSourceProjection, readProviderFacts } from '@/packages/domain/src/provider-sources';
import { maintenanceGuard, removeGuard } from './recovery-storage';
import { providerWriteGuard, type GoogleAccessGrant } from './provider-connections';
import type { ProviderLinkRow, ProviderRuleRow } from './provider-field-controls';
import type { GoogleContactRun } from './google-contact-downloads';
type DB = CloudflareEnv['DB'];

/** Each source and its checkpoint commit together; redelivery resumes after the last committed source. */
export async function reconcileGoogleContactLinks(db: DB, run: GoogleContactRun, lease: string, grant: GoogleAccessGrant,
  guardFor: (token: string) => ReturnType<DB['prepare']>) {
  const links = (await db.prepare(`SELECT l.* FROM contact_provider_links l JOIN provider_connections c
    ON c.account_id = l.account_key AND c.workspace_id = l.workspace_id
    WHERE c.id = ? AND l.provider = 'google' AND l.workspace_id = ? AND l.id > ? ORDER BY l.id LIMIT 5`)
    .bind(run.connection_id, run.workspace_id, run.reconcile_after).all<ProviderLinkRow>()).results;
  for (const link of links) {
    const person = await db.prepare('SELECT name, contact_methods FROM contacts WHERE workspace_id = ? AND id = ?')
      .bind(run.workspace_id, link.contact_id).first<{ name: string; contact_methods: string }>();
    const rule = await db.prepare('SELECT * FROM provider_field_rules WHERE workspace_id = ? AND source_link_id = ?')
      .bind(run.workspace_id, link.id).first<ProviderRuleRow>();
    const index = await db.prepare('SELECT facts FROM provider_contact_index WHERE connection_id = ? AND generation = ? AND source_id = ?')
      .bind(run.connection_id, run.generation, link.external_id).first<{ facts: string }>();
    const facts = index ? readProviderFacts(index.facts) : null;
    const previous = rule ? readProviderRules(rule.fields) : defaultProviderRules(providerSourceProjection(link));
    const next = person ? reconcileProviderFields(previous, person.name, person.contact_methods, facts) : null;
    const status = facts ? 'available' : 'unavailable', now = new Date().toISOString(), token = crypto.randomUUID();
    const changedFacts = status !== link.status || facts && (index!.facts !== link.observed_facts || facts.resourceName !== link.resource_name);
    const fields = next ? JSON.stringify(next.fields) : null;
    const guards = () => [guardFor(token), providerWriteGuard(db, grant, token + '-grant'),
      maintenanceGuard(db, token + '-generation', 'EXISTS (SELECT 1 FROM provider_contact_resources WHERE connection_id = ? AND active_generation = ?)', [run.connection_id, run.generation]),
      maintenanceGuard(db, token + '-source', `NOT EXISTS (SELECT 1 FROM contact_provider_links WHERE workspace_id = ? AND id = ?)
        OR (EXISTS (SELECT 1 FROM contact_provider_links WHERE workspace_id = ? AND id = ? AND contact_id = ? AND revision = ?)
          AND ${rule ? 'EXISTS (SELECT 1 FROM provider_field_rules WHERE workspace_id = ? AND source_link_id = ? AND revision = ?)' : 'NOT EXISTS (SELECT 1 FROM provider_field_rules WHERE workspace_id = ? AND source_link_id = ?)'}
          AND EXISTS (SELECT 1 FROM contacts WHERE workspace_id = ? AND id = ? AND name IS ? AND contact_methods IS ?))`,
        [run.workspace_id, link.id, run.workspace_id, link.id, link.contact_id, link.revision, run.workspace_id, link.id, ...(rule ? [rule.revision] : []), run.workspace_id, link.contact_id, person?.name ?? null, person?.contact_methods ?? null])];
    const checkpoint = (skipped: boolean) => db.prepare(`UPDATE provider_contact_runs SET reconcile_after = ?, reconciled = reconciled + 1,
      reconcile_skipped = reconcile_skipped + ?, issue = CASE WHEN reconcile_skipped + ? > 0 THEN 'source_capacity' ELSE NULL END,
      revision = revision + 1, failures = 0, next_attempt_at = 0, lease_until = ?, updated_at = ? WHERE id = ? AND lease_token = ?`)
      .bind(link.id, Number(skipped), Number(skipped), Date.now() + 45_000, now, run.id, lease);
    const cleanup = () => [removeGuard(db, token), removeGuard(db, token + '-grant'), removeGuard(db, token + '-generation'), removeGuard(db, token + '-source')];
    try {
      await db.batch([...guards(),
        ...(fields && fields !== rule?.fields ? [db.prepare(`INSERT INTO provider_field_rules (workspace_id, source_link_id, fields, updated_at)
          SELECT ?, id, ?, ? FROM contact_provider_links WHERE workspace_id = ? AND id = ?
          ON CONFLICT(workspace_id, source_link_id) DO UPDATE SET fields = excluded.fields, revision = provider_field_rules.revision + 1, updated_at = excluded.updated_at`)
          .bind(run.workspace_id, fields, now, run.workspace_id, link.id)] : []),
        ...(next && person && (next.name !== person.name || next.methods !== person.contact_methods) ? [db.prepare(`UPDATE contacts SET name = ?, contact_methods = ?, email = ?, phone = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND EXISTS (SELECT 1 FROM contact_provider_links WHERE workspace_id = ? AND id = ? AND contact_id = ?)`)
          .bind(next.name, next.methods, next.email, next.phone, now, run.workspace_id, link.contact_id, run.workspace_id, link.id, link.contact_id)] : []),
        ...(changedFacts ? [db.prepare(`UPDATE contact_provider_links SET observed_facts = ?, resource_name = ?, status = ?, observed_at = ?, updated_at = ?, revision = revision + 1 WHERE workspace_id = ? AND id = ?`)
          .bind(index?.facts ?? link.observed_facts, facts?.resourceName ?? link.resource_name, status, now, now, run.workspace_id, link.id)] : []),
        checkpoint(false), ...cleanup()]);
    } catch (error) {
      // Oversized source growth must not block every other person in the account. Keep the last usable source and CRM values.
      if (!/PROVIDER_(LINK|RULE)_LIMIT/.test(String(error))) throw error;
      await db.batch([...guards(), checkpoint(true), ...cleanup()]); run.reconcile_skipped++;
    }
    run.revision++; run.reconcile_after = link.id; run.reconciled++;
  }
  if (links.length === 5) return { status: 'active', advanced: true, retryAfter: 0 };
  const token = crypto.randomUUID();
  await db.batch([guardFor(token), providerWriteGuard(db, grant, token + '-grant'),
    db.prepare(`UPDATE provider_contact_runs SET status = 'complete', revision = revision + 1, lease_token = NULL, lease_until = NULL,
      issue = CASE WHEN reconcile_skipped > 0 THEN 'source_capacity' ELSE NULL END, updated_at = ? WHERE id = ?`).bind(new Date().toISOString(), run.id),
    removeGuard(db, token), removeGuard(db, token + '-grant')]);
  run.revision++; return { status: 'complete', advanced: true, retryAfter: 0 };
}
