import { suspendMergedProviderRules } from './provider-field-controls';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { buildMergedContact, ContactMergeError, planContactConnectionMerge,
  validateContactMergeIds, validateContactMergeSelection,
  type StoredContactChildLink, type StoredContactRelationship } from '@/lib/contact-merge';
import type { Contact } from '@/lib/db';
import { CloudRecoveryError } from '@/lib/cloud/recovery-contract';
import { createCloudBackup, pruneCloudBackups, recoveryGuard, releaseBackupPin,
  maintenanceGuard, removeGuard } from '@/lib/cloud/recovery-storage';
import { readCloudObject } from '@/lib/cloud/request';
import { parsePositiveInteger } from '@/lib/relationship-validation';
import { RequestBodyError } from '@/lib/request-body';
import { fingerprintIdempotencyInput, IdempotencyError, requireIdempotencyKey } from '@/lib/idempotency';
import { readContactMergeAliases } from '@/packages/domain/src/contact-aliases';
import { MAX_SYNC_RECORD_BYTES } from '@/packages/domain/src/sync';

type DB = CloudflareEnv['DB'];

type CloudContact = Contact & { public_id: string; merge_aliases: string };
async function selectedContacts(db: DB, workspaceId: string, ids: number[]): Promise<CloudContact[]> {
  const result = await db.prepare(`SELECT * FROM contacts WHERE workspace_id = ?
    AND id IN (SELECT value FROM json_each(?)) ORDER BY id`)
    .bind(workspaceId, JSON.stringify(ids)).all<CloudContact>();
  return result.results;
}

async function affectedConnections(db: DB, workspaceId: string, ids: number[]) {
  const selected = JSON.stringify(ids);
  const [relationships, children] = await db.batch([
    db.prepare(`SELECT id, contact_id, related_contact_id FROM contact_relationships
      WHERE workspace_id = ? AND (contact_id IN (SELECT value FROM json_each(?))
        OR related_contact_id IN (SELECT value FROM json_each(?))) ORDER BY id`)
      .bind(workspaceId, selected, selected),
    db.prepare(`SELECT id, contact_id, linked_contact_id FROM contact_children
      WHERE workspace_id = ? AND (contact_id IN (SELECT value FROM json_each(?))
        OR linked_contact_id IN (SELECT value FROM json_each(?))) ORDER BY id`)
      .bind(workspaceId, selected, selected),
  ]);
  return { relationships: relationships.results as StoredContactRelationship[],
    children: children.results as StoredContactChildLink[] };
}

const ACTIVITY_TABLES = ['interactions', 'reminders', 'relationship_facts', 'plans'] as const;

async function replayCloudMerge(db: DB, workspaceId: string, requestKey: string, fingerprint: string,
  primaryId: number, duplicateIds: number[]) {
  const receipt = await db.prepare(`SELECT fingerprint, owner_token, resource_id, created_at FROM mutation_receipts
    WHERE workspace_id = ? AND scope = 'contact_merge' AND request_key = ?`)
    .bind(workspaceId, requestKey)
    .first<{ fingerprint: string; owner_token: string; resource_id: number | null; created_at: string }>();
  if (!receipt) return null;
  if (receipt.fingerprint !== fingerprint) {
    throw new IdempotencyError('This Idempotency-Key was already used for a different merge request.', 409);
  }
  if (receipt.resource_id !== primaryId) {
    throw new IdempotencyError('The original merge result is no longer available. Refresh the review.', 409);
  }
  const [contactResult, duplicateResult, backupResult] = await db.batch([
    db.prepare('SELECT * FROM contacts WHERE workspace_id = ? AND id = ?').bind(workspaceId, primaryId),
    db.prepare(`SELECT id FROM contacts WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(workspaceId, JSON.stringify(duplicateIds)),
    db.prepare(`SELECT filename FROM cloud_backup_files WHERE workspace_id = ? AND filename = ? AND state = 'ready'`)
      .bind(workspaceId, receipt.owner_token),
  ]);
  const contact = contactResult.results[0] as Contact | undefined;
  if (!contact || duplicateResult.results.length > 0) {
    throw new IdempotencyError('The merged profiles changed after the original request. Refresh the review.', 409);
  }
  return { contact, mergedContactIds: duplicateIds, moved: null,
    recoveryPoint: backupResult.results.length > 0
      ? { filename: receipt.owner_token, createdAt: receipt.created_at }
      : null,
    replayed: true };
}

export async function mergeCloudDuplicateContacts(workspaceId: string, primaryId: number, duplicateIds: number[],
  expectedRevision: number, requestKey: string) {
  const { DB } = getCloudflareContext().env;
  const normalizedIds = validateContactMergeIds(primaryId, duplicateIds);
  const fingerprint = fingerprintIdempotencyInput({ primaryId, duplicateIds: normalizedIds, expectedRevision });
  const replay = await replayCloudMerge(DB, workspaceId, requestKey, fingerprint, primaryId, normalizedIds);
  if (replay) return replay;
  const selectedIds = [primaryId, ...normalizedIds];
  const state = await DB.prepare('SELECT recovery_revision FROM workspaces WHERE id = ?')
    .bind(workspaceId).first<{ recovery_revision: number }>();
  if (!state || state.recovery_revision !== expectedRevision) {
    throw new ContactMergeError('Your people changed since this review. Refresh before merging.', 'stale');
  }
  validateContactMergeSelection(primaryId, normalizedIds, await selectedContacts(DB, workspaceId, selectedIds));
  const duplicateJson = JSON.stringify(normalizedIds);
  const delivery = await DB.prepare(`SELECT 1 FROM birthday_email_deliveries WHERE workspace_id = ?
    AND contact_id IN (SELECT value FROM json_each(?)) LIMIT 1`).bind(workspaceId, duplicateJson).first();
  if (delivery) throw new ContactMergeError('Birthday email delivery history needs review before these contacts can be merged.');
  const recovery = await createCloudBackup(workspaceId, 'pre-merge');
  try {
    if (recovery.revision !== expectedRevision) {
      throw new ContactMergeError('Your people changed since this review. Refresh before merging.', 'stale');
    }
    const selected = await selectedContacts(DB, workspaceId, selectedIds);
    const { primary, duplicates } = validateContactMergeSelection(primaryId, normalizedIds, selected);
    const mergedAt = new Date().toISOString();
    const merged = buildMergedContact(primary, duplicates, mergedAt);
    const canonical = selected.find((row) => row.id === primaryId)!;
    const aliases = JSON.stringify([...new Set(selected.flatMap((row) => [
      ...readContactMergeAliases(row.merge_aliases, row.public_id), ...(row.id === primaryId ? [] : [row.public_id]),
    ]))].sort());
    try { readContactMergeAliases(aliases, canonical.public_id); }
    catch { throw new ContactMergeError('This combined profile exceeds the supported number of merged identities.'); }
    if (new TextEncoder().encode(JSON.stringify({ ...merged, photo_url: null, merge_aliases: aliases })).byteLength > MAX_SYNC_RECORD_BYTES - 2048) {
      throw new ContactMergeError('This combined profile is too large for device sync. Reduce its text before merging.');
    }
    const { relationships, children } = await affectedConnections(DB, workspaceId, selectedIds);
    const plan = planContactConnectionMerge(primaryId, normalizedIds, relationships, children);
    const relationshipDeleteJson = JSON.stringify(plan.relationshipDeletes);
    const childDeleteJson = JSON.stringify(plan.childDeletes);
    const moved = ACTIVITY_TABLES.map((table) => DB.prepare(`UPDATE ${table} SET contact_id = ?
      WHERE workspace_id = ? AND contact_id IN (SELECT value FROM json_each(?)) RETURNING id`)
      .bind(primaryId, workspaceId, duplicateJson));
    const results = await DB.batch([
      recoveryGuard(DB, workspaceId, recovery),
      maintenanceGuard(DB, `${recovery.token}-delivery`, `NOT EXISTS (
        SELECT 1 FROM birthday_email_deliveries WHERE workspace_id = ?
          AND (contact_id IN (SELECT value FROM json_each(?))
            OR child_id IN (SELECT value FROM json_each(?)))
      )`, [workspaceId, duplicateJson, childDeleteJson]),
      DB.prepare(`DELETE FROM contact_relationships WHERE workspace_id = ?
        AND id IN (SELECT value FROM json_each(?))`).bind(workspaceId, relationshipDeleteJson),
      DB.prepare(`DELETE FROM contact_children WHERE workspace_id = ?
        AND id IN (SELECT value FROM json_each(?))`).bind(workspaceId, childDeleteJson),
      DB.prepare(`UPDATE contact_relationships SET
        contact_id = CASE WHEN contact_id IN (SELECT value FROM json_each(?)) THEN ? ELSE contact_id END,
        related_contact_id = CASE WHEN related_contact_id IN (SELECT value FROM json_each(?)) THEN ? ELSE related_contact_id END
        WHERE workspace_id = ? AND (contact_id IN (SELECT value FROM json_each(?))
          OR related_contact_id IN (SELECT value FROM json_each(?)))`)
        .bind(duplicateJson, primaryId, duplicateJson, primaryId, workspaceId, duplicateJson, duplicateJson),
      DB.prepare(`UPDATE contact_children SET
        contact_id = CASE WHEN contact_id IN (SELECT value FROM json_each(?)) THEN ? ELSE contact_id END,
        linked_contact_id = CASE WHEN linked_contact_id IN (SELECT value FROM json_each(?)) THEN ? ELSE linked_contact_id END,
        updated_at = ?
        WHERE workspace_id = ? AND (contact_id IN (SELECT value FROM json_each(?))
          OR linked_contact_id IN (SELECT value FROM json_each(?)))`)
        .bind(duplicateJson, primaryId, duplicateJson, primaryId, mergedAt, workspaceId, duplicateJson, duplicateJson),
      DB.prepare(`INSERT OR IGNORE INTO contact_group_members (workspace_id, contact_id, group_id)
        SELECT workspace_id, ?, group_id FROM contact_group_members
        WHERE workspace_id = ? AND contact_id IN (SELECT value FROM json_each(?)) RETURNING group_id`)
        .bind(primaryId, workspaceId, duplicateJson),
      DB.prepare(`DELETE FROM contact_group_members WHERE workspace_id = ?
        AND contact_id IN (SELECT value FROM json_each(?))`).bind(workspaceId, duplicateJson),
      ...moved,
      DB.prepare(`INSERT INTO daily_snoozes
        (id, workspace_id, contact_id, reminder_id, until_date, created_at, updated_at)
        SELECT substr(id, 1, instr(id, '-')) || CAST(? AS INTEGER), workspace_id, ?, NULL, until_date, created_at, ?
        FROM daily_snoozes WHERE workspace_id = ? AND reminder_id IS NULL
          AND contact_id IN (SELECT value FROM json_each(?))
        ON CONFLICT(workspace_id, id) DO UPDATE SET
          until_date = MAX(daily_snoozes.until_date, excluded.until_date), updated_at = excluded.updated_at`)
        .bind(primaryId, primaryId, mergedAt, workspaceId, duplicateJson),
      DB.prepare(`DELETE FROM daily_snoozes WHERE workspace_id = ? AND reminder_id IS NULL
        AND contact_id IN (SELECT value FROM json_each(?))`).bind(workspaceId, duplicateJson),
      DB.prepare(`UPDATE daily_snoozes SET contact_id = ? WHERE workspace_id = ? AND reminder_id IS NOT NULL
        AND contact_id IN (SELECT value FROM json_each(?))`).bind(primaryId, workspaceId, duplicateJson),
      DB.prepare(`UPDATE contact_import_rows SET contact_id = ? WHERE workspace_id = ?
        AND contact_id IN (SELECT value FROM json_each(?))`).bind(primaryId, workspaceId, duplicateJson),
      DB.prepare(`UPDATE birthday_email_scan_state SET contact_id = NULL WHERE workspace_id = ?
        AND contact_id IN (SELECT value FROM json_each(?))`).bind(workspaceId, duplicateJson),
      suspendMergedProviderRules(DB, workspaceId, [primaryId, ...duplicateIds]),
      DB.prepare(`UPDATE contacts SET name = ?, nickname = ?, email = ?, phone = ?, photo_url = ?,
        birthday = ?, birthday_reminder_days = ?, how_we_met = ?, tags = ?, notes = ?, gift_ideas = ?,
        custom_fields = ?, last_contacted = ?, contact_frequency = ?, updated_at = ?, contact_methods = ?
        WHERE workspace_id = ? AND id = ?`)
        .bind(merged.name, merged.nickname, merged.email, merged.phone, merged.photo_url,
          merged.birthday, merged.birthday_reminder_days, merged.how_we_met, merged.tags, merged.notes,
          merged.gift_ideas, merged.custom_fields, merged.last_contacted, merged.contact_frequency,
          mergedAt, merged.contact_methods ?? '[]', workspaceId, primaryId),
      DB.prepare(`UPDATE contact_source_links SET contact_id = ? WHERE workspace_id = ? AND contact_id IN (SELECT value FROM json_each(?))`)
        .bind(primaryId, workspaceId, duplicateJson),
      DB.prepare(`UPDATE contact_provider_links SET contact_id = ? WHERE workspace_id = ? AND contact_id IN (SELECT value FROM json_each(?))`)
        .bind(primaryId, workspaceId, duplicateJson),
      DB.prepare(`UPDATE contact_device_links SET contact_id = ? WHERE workspace_id = ? AND contact_id IN (SELECT value FROM json_each(?))`)
        .bind(primaryId, workspaceId, duplicateJson),
      DB.prepare(`DELETE FROM calendar_event_people WHERE workspace_id = ? AND contact_id IN (SELECT value FROM json_each(?))
        AND (EXISTS (SELECT 1 FROM calendar_event_people primary_link WHERE primary_link.workspace_id = ? AND primary_link.event_id = calendar_event_people.event_id AND primary_link.contact_id = ?)
          OR id != (SELECT MIN(link.id) FROM calendar_event_people link WHERE link.workspace_id = ? AND link.event_id = calendar_event_people.event_id AND link.contact_id IN (SELECT value FROM json_each(?))))`)
        .bind(workspaceId, duplicateJson, workspaceId, primaryId, workspaceId, duplicateJson),
      DB.prepare(`UPDATE calendar_event_people SET contact_id = ? WHERE workspace_id = ? AND contact_id IN (SELECT value FROM json_each(?))`).bind(primaryId, workspaceId, duplicateJson),
      DB.prepare(`DELETE FROM contacts WHERE workspace_id = ?
        AND id IN (SELECT value FROM json_each(?)) RETURNING id`).bind(workspaceId, duplicateJson),
      // Register retired IDs after deletion, then flatten inherited aliases onto the survivor.
      DB.prepare('UPDATE contacts SET merge_aliases = ? WHERE workspace_id = ? AND id = ?').bind(aliases, workspaceId, primaryId),
      DB.prepare(`INSERT INTO mutation_receipts
        (workspace_id, scope, request_key, fingerprint, owner_token, resource_id, created_at)
        VALUES (?, 'contact_merge', ?, ?, ?, ?, ?)`)
        .bind(workspaceId, requestKey, fingerprint, recovery.backup.filename, primaryId, recovery.backup.createdAt),
      removeGuard(DB, recovery.token), removeGuard(DB, `${recovery.token}-delivery`),
    ]);
    const deleted = results.at(-5)?.results.length ?? 0;
    if (deleted !== normalizedIds.length) {
      throw new Error('Duplicate merge committed an unexpected contact count. Inspect the recovery point.');
    }
    const contact = await DB.prepare('SELECT * FROM contacts WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, primaryId).first<Contact>();
    await releaseBackupPin(workspaceId, recovery.token, DB);
    try { await pruneCloudBackups(workspaceId); }
    catch (error) { console.error('cloud.backup.retention_pending', { errorName: error instanceof Error ? error.name : 'unknown' }); }
    return { contact, mergedContactIds: normalizedIds,
      moved: { interactions: results[8].results.length, reminders: results[9].results.length,
        facts: results[10].results.length, plans: results[11].results.length,
        groups: results[6].results.length, relationships: plan.relationshipCount,
        children: plan.childCount },
      recoveryPoint: { filename: recovery.backup.filename, createdAt: recovery.backup.createdAt },
      replayed: false };
  } finally {
    await releaseBackupPin(workspaceId, recovery.token, DB);
  }
}

export async function handleCloudDuplicateMerge(request: Request, workspaceId: string): Promise<Response> {
  try {
    const body = await readCloudObject(request);
    const primaryId = parsePositiveInteger(body.primaryId);
    const rawIds = Array.isArray(body.duplicateIds) ? body.duplicateIds : [];
    const duplicateIds = rawIds.map(parsePositiveInteger);
    const expectedRevision = body.expectedRevision;
    const requestKey = requireIdempotencyKey(request.headers);
    if (!primaryId || duplicateIds.some((id) => id === null)
      || typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new ContactMergeError('Choose a valid primary contact and duplicate contacts.');
    }
    return Response.json(await mergeCloudDuplicateContacts(workspaceId, primaryId, duplicateIds as number[], expectedRevision, requestKey));
  } catch (error) {
    if (error instanceof ContactMergeError) {
      return Response.json({ error: error.message }, { status: error.code === 'not_found' ? 404 : error.code === 'not_duplicates' || error.code === 'stale' ? 409 : 400 });
    }
    if (error instanceof RequestBodyError || error instanceof CloudRecoveryError || error instanceof IdempotencyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && error.message.includes('CLOUD_RECOVERY_CONFLICT')) {
      return Response.json({ error: 'Contacts changed while the recovery point was created. Refresh and try again.' }, { status: 409 });
    }
    console.error('cloud.duplicates.merge_failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    return Response.json({ error: 'Could not safely merge contacts. The recovery point remains available.' }, { status: 503 });
  }
}
