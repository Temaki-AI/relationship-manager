import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { accountScope, type NativeAccount } from '../../../../packages/domain/src/devices';
import { isSyncUuid } from '../../../../packages/domain/src/sync';
import { appleCalendarDraft, appleCalendarUrl, appleCalendarDay, readAppleCalendarFacts, type AppleCalendarDraft, type AppleCalendarFacts } from '../../../../packages/domain/src/apple-calendar';
import { contextForEditing, type ContextRecord } from './context';
import { enqueueSyncIntent } from './sync-queue';
import { signalSyncChange } from './sync-signals';
import { authorizeCalendarEditor, localCalendarReservation, queueCalendarEditorResult, releaseCalendarReservation, syncCalendarReservations } from './calendar-reservations';
type DB = SQLiteDatabase;
export type AppleCalendarReceipt = { id: string; account_scope: string; epoch: string | null; plan_id: string; plan_fingerprint: string; request_json: string; attempted: number;
  event_id: string | null; calendar_id: string | null; status: string; issue: string | null; facts: string | null; follow_date: number; read_enabled: number; read_epoch: string | null; last_plan_date: string | null; last_read_at: string | null; revision: number };
export type AppleCalendarAdapter = {
  prepareEditor: () => Promise<void>; create: (event: ReturnType<typeof appleCalendarDraft>['event'] & { url: string }) => Promise<{ action: string; id: string | null }>;
  permission: (request: boolean) => Promise<boolean>; get: (id: string) => Promise<AppleCalendarFacts | null>;
  calendars: () => Promise<{ id: string; title: string }[]>;
  find: (calendarId: string, start: string, end: string, url: string) => Promise<AppleCalendarFacts[]>;
  edit: (id: string) => Promise<{ action: string; id: string | null }>;
};
const hash = async (value: unknown) => (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(value))).toLowerCase();
const planHash = (plan: ContextRecord | null) => hash(plan ? { id: plan.id, contact_id: plan.contact_id, type: plan.type, planned_date: plan.planned_date, summary: plan.summary, notes: plan.notes, completed_at: plan.completed_at } : null);
const receiptFor = (db: DB, id: string) => db.getFirstAsync<AppleCalendarReceipt>('SELECT * FROM apple_calendar_receipts WHERE id = ?', id);
async function epoch(db: DB) { const p = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'"); return p ? (JSON.parse(p.value) as { epoch: string }).epoch : null; }
async function owner(db: DB, account: NativeAccount, isCurrent: () => boolean) {
  if (!isCurrent() || (await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'account-scope'"))?.value !== accountScope(account)) throw new Error('The active account changed. This Calendar review stays with its original account.');
}
async function linkedEvent(db: DB, planId: string) {
  return db.getFirstAsync<{ id: string }>(`SELECT id FROM calendar_events WHERE EXISTS (SELECT 1 FROM json_each(json_extract(record_json, '$.data.plan_ids')) WHERE value = ?)
    UNION SELECT event_id AS id FROM calendar_event_link_queue WHERE EXISTS (SELECT 1 FROM json_each(plan_ids) WHERE value = ?) LIMIT 1`, planId, planId);
}
export async function appleCalendarReview(db: DB, planId: string, operationId?: string) {
  if (!isSyncUuid(planId)) throw new Error('Choose a saved plan.');
  if (operationId && !isSyncUuid(operationId)) throw new Error('Choose a saved Calendar receipt.');
  const plan = await contextForEditing(db, 'plan', planId), receipt = operationId
    ? await db.getFirstAsync<AppleCalendarReceipt>('SELECT * FROM apple_calendar_receipts WHERE plan_id = ? AND id = ?', planId, operationId)
    : await db.getFirstAsync<AppleCalendarReceipt>('SELECT * FROM apple_calendar_receipts WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', planId);
  if (operationId && !receipt) throw new Error('This Calendar receipt is not available in the active account on this phone.');
  const person = plan ? await db.getFirstAsync<{ name: string }>('SELECT name FROM contacts WHERE id = ? AND deleted_at IS NULL', plan.contact_id) : null;
  return { plan, person, receipt, publication: receipt ? await localCalendarReservation(db, receipt.id) : null,
    epoch: await epoch(db), planFingerprint: await planHash(plan), linkedEventId: (await linkedEvent(db, planId))?.id ?? null };
}
export async function holdAppleCalendarForEpoch(db: DB, current: string) {
  await db.runAsync(`UPDATE apple_calendar_receipts SET status = 'held', issue = 'epoch_changed', follow_date = 0, read_enabled = 0, revision = revision + 1
    WHERE status NOT IN ('cancelled', 'discarded') AND (status != 'held' OR issue IS NOT 'epoch_changed' OR follow_date != 0 OR read_enabled != 0)
      AND ((attempted = 0 AND epoch IS NOT ?) OR (attempted = 1 AND read_epoch IS NOT ?))`, current, current);
}
export async function prepareAppleCalendar(db: DB, account: NativeAccount, planId: string, input: { operationId: string; epoch: string | null; planFingerprint: string; draft: AppleCalendarDraft }, isCurrent = () => true) {
  await owner(db, account, isCurrent); const parsed = appleCalendarDraft(input.draft);
  if (!isSyncUuid(input.operationId)) throw new Error('Choose a new Calendar review.');
  const request = JSON.stringify({ draft: parsed.draft, url: appleCalendarUrl(planId, input.operationId) });
  await db.withExclusiveTransactionAsync(async (tx) => {
    await owner(tx, account, isCurrent);
    const old = await receiptFor(tx, input.operationId);
    if (old) { if (old.plan_id !== planId || old.account_scope !== accountScope(account) || old.request_json !== request || old.epoch !== input.epoch || old.plan_fingerprint !== input.planFingerprint) throw new Error('This operation belongs to a different Calendar review.'); return; }
    const r = await appleCalendarReview(tx, planId);
    if (!r.plan || r.plan.completed_at || r.epoch !== input.epoch || r.planFingerprint !== input.planFingerprint || r.linkedEventId) throw new Error('The plan or its linked event changed. Refresh before reviewing a new event.');
    if (r.receipt && !['cancelled', 'discarded'].includes(r.receipt.status)) throw new Error('Review the original Calendar receipt before creating another event.');
    const now = new Date().toISOString();
    await tx.runAsync('INSERT INTO apple_calendar_receipts (id, account_scope, epoch, read_epoch, plan_id, plan_fingerprint, request_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      input.operationId, accountScope(account), input.epoch, input.epoch, planId, input.planFingerprint, request, now, now);
  });
  return (await receiptFor(db, input.operationId))!;
}
export async function discardAppleCalendar(db: DB, account: NativeAccount, operationId: string, revision: number, isCurrent = () => true, fetcher: typeof fetch = fetch) {
  await owner(db, account, isCurrent); const original = await receiptFor(db, operationId);
  if (!original || original.account_scope !== accountScope(account) || original.revision !== revision || original.attempted || !['prepared', 'held', 'unknown'].includes(original.status)) {
    throw new Error('This review may have reached the Calendar editor. Verify the original event instead of discarding it.');
  }
  await releaseCalendarReservation(db, account, operationId, { isCurrent, fetcher });
  await db.withExclusiveTransactionAsync(async (tx) => {
    await owner(tx, account, isCurrent);
    const r = await receiptFor(tx, operationId);
    if (!r || r.account_scope !== accountScope(account) || r.revision !== revision || r.attempted || !['prepared', 'held', 'unknown'].includes(r.status)) throw new Error('This review may have reached the Calendar editor. Verify the original event instead of discarding it.');
    await tx.runAsync("UPDATE apple_calendar_receipts SET status = 'discarded', revision = revision + 1 WHERE id = ? AND revision = ? AND attempted = 0", operationId, revision);
  });
}
export async function openAppleCalendarEditor(db: DB, account: NativeAccount, operationId: string, revision: number, adapter: AppleCalendarAdapter, isCurrent = () => true, fetcher: typeof fetch = fetch) {
  await owner(db, account, isCurrent); const original = await receiptFor(db, operationId);
  if (!original || original.account_scope !== accountScope(account) || original.revision !== revision || original.attempted || original.status !== 'prepared') throw new Error('This editor was already attempted or the review changed. Verify its original event.');
  // Permission on older iOS is resolved before recording an editor attempt; denied access has no external event effect.
  await adapter.prepareEditor();
  await owner(db, account, isCurrent);
  const preview = await appleCalendarReview(db, original.plan_id, operationId);
  if (preview.epoch !== original.epoch || !preview.plan || preview.plan.completed_at || preview.planFingerprint !== original.plan_fingerprint
    || preview.linkedEventId || preview.receipt?.revision !== revision || preview.receipt.attempted || preview.receipt.status !== 'prepared') {
    throw new Error('The plan, account or Calendar link changed. Keep this receipt and review it again.');
  }
  await authorizeCalendarEditor(db, account, original, { isCurrent, fetcher });
  await db.withExclusiveTransactionAsync(async (tx) => {
    await owner(tx, account, isCurrent); const r = await receiptFor(tx, operationId), plan = await contextForEditing(tx, 'plan', original.plan_id);
    if (!r || r.revision !== revision || r.attempted || r.status !== 'prepared' || await epoch(tx) !== original.epoch || !plan || plan.completed_at || await planHash(plan) !== original.plan_fingerprint || await linkedEvent(tx, original.plan_id)) throw new Error('The plan, account or Calendar link changed. Keep this receipt and review it again.');
    await tx.runAsync("UPDATE apple_calendar_receipts SET attempted = 1, status = 'unknown', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND attempted = 0", new Date().toISOString(), operationId, revision);
  });
  // There is no retry of this call, even when the app quits or the native acknowledgement is lost.
  await owner(db, account, isCurrent);
  const fresh = await appleCalendarReview(db, original.plan_id);
  if (fresh.epoch !== original.epoch || fresh.receipt?.id !== operationId || fresh.receipt.revision !== revision + 1 || fresh.receipt.status !== 'unknown'
    || !fresh.plan || fresh.plan.completed_at || fresh.planFingerprint !== original.plan_fingerprint || fresh.linkedEventId || !isCurrent()) throw new Error('The plan or account changed before the editor opened. Retain the original receipt.');
  const data = JSON.parse(original.request_json) as { draft: AppleCalendarDraft; url: string };
  let result: { action: string; id: string | null };
  try { result = await adapter.create({ ...appleCalendarDraft(data.draft).event, url: data.url }); } catch { throw new Error('The Calendar editor reply is unconfirmed. Verify the original event before creating anything else.'); }
  if (!['saved', 'canceled'].includes(result.action) || result.id !== null && (typeof result.id !== 'string' || !result.id || result.id.length > 1024)) throw new Error('The Calendar result is unconfirmed. Retain the original receipt.');
  await db.withExclusiveTransactionAsync(async (tx) => {
    // An account switch cannot write to the new account. A late reply can retain its receipt in the original cache without changing CRM data.
    const bound = await tx.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'account-scope'");
    if (bound?.value !== original.account_scope) throw new Error('The original Calendar cache is unavailable.');
    const row = await receiptFor(tx, operationId); if (!row || !row.attempted || !['unknown', 'held'].includes(row.status)) return;
    const held = !isCurrent() || await epoch(tx) !== original.epoch || row.status === 'held';
    await tx.runAsync('UPDATE apple_calendar_receipts SET event_id = COALESCE(event_id, ?), status = ?, issue = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      result.action === 'saved' ? result.id : null, result.action === 'canceled' ? 'cancelled' : held ? 'held' : 'saved', held ? 'account_or_plan_changed' : result.action === 'saved' ? 'verification_needed' : null, new Date().toISOString(), operationId);
    await queueCalendarEditorResult(tx, operationId, result.action as 'saved' | 'canceled');
  });
  // The native result is already durable. A failed/lost server acknowledgement
  // is retried from the outbox, never by calling EventKit's create method again.
  try { await syncCalendarReservations(db, account, { isCurrent, fetcher }); } catch { /* Review exposes the retained pending publication receipt. */ }
  return (await receiptFor(db, operationId))!;
}
async function applyObservation(db: DB, account: NativeAccount, receipt: AppleCalendarReceipt, input: AppleCalendarFacts, policy: { explicit: boolean; follow: boolean; reads: boolean; epoch: string | null; planFingerprint?: string }, isCurrent: () => boolean) {
  const facts = readAppleCalendarFacts(input), data = JSON.parse(receipt.request_json) as { url: string }, now = new Date().toISOString();
  if (facts.url !== data.url || facts.recurring) throw new Error('The original event marker is missing, or the event now repeats. Review it in Calendar; another event will not be created.');
  if (!policy.explicit && (facts.id !== receipt.event_id || facts.calendar_id !== receipt.calendar_id)) throw new Error('The original event moved. Review its new identity before continuing date updates.');
  let changed = false;
  await db.withExclusiveTransactionAsync(async (tx) => {
    await owner(tx, account, isCurrent); const row = await receiptFor(tx, receipt.id), r = await appleCalendarReview(tx, receipt.plan_id);
    if (!row || row.revision !== receipt.revision || !row.attempted || row.account_scope !== accountScope(account) || r.epoch !== policy.epoch
      || policy.explicit && r.planFingerprint !== policy.planFingerprint || !policy.explicit && row.read_epoch !== r.epoch) throw new Error('The plan, account or Calendar receipt changed during verification.');
    let follow = policy.follow && policy.reads, issue: string | null = null;
    if (!r.plan || r.plan.completed_at || facts.cancelled || r.linkedEventId || !policy.explicit && r.plan.planned_date !== row.last_plan_date) { follow = false; issue = 'date_following_suspended'; }
    const next = appleCalendarDay(facts);
    // Record the followed date before changing the plan in this same transaction. The
    // plan trigger treats every other date change as a sticky manual/source correction.
    await tx.runAsync(`UPDATE apple_calendar_receipts SET event_id = ?, calendar_id = ?, status = ?, issue = ?, facts = ?, follow_date = ?, read_enabled = ?, read_epoch = ?, last_plan_date = ?, last_read_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`,
      facts.id, facts.calendar_id, facts.cancelled ? 'missing' : 'verified', issue, JSON.stringify(facts), Number(follow), Number(policy.reads && Boolean(r.plan && !r.plan.completed_at) && !facts.cancelled), r.epoch,
      follow ? next : (r.plan?.planned_date as string | undefined) ?? null, now, now, receipt.id, receipt.revision);
    if (follow && r.plan && r.plan.planned_date !== next) {
      await tx.runAsync(`UPDATE plans SET planned_date = ?, updated_at = ?, sync_state = CASE WHEN EXISTS (SELECT 1 FROM sync_queue WHERE entity_type = 'plan' AND entity_id = ? AND status = 'conflict') THEN 'conflict' ELSE 'pending' END WHERE id = ?`, next, now, r.plan.id, r.plan.id);
      await enqueueSyncIntent(tx, 'plan', r.plan.id, 'update', { planned_date: next }, now, { revision: r.plan.remote_revision, values: { planned_date: r.plan.planned_date as string } });
      changed = true;
    }
  });
  if (changed) signalSyncChange(db); return { receipt: (await receiptFor(db, receipt.id))!, changed };
}
export async function verifyAppleCalendar(db: DB, account: NativeAccount, operationId: string, expected: { revision: number; epoch: string | null; planFingerprint: string; follow: boolean; reads: boolean }, adapter: AppleCalendarAdapter, isCurrent = () => true, candidate?: AppleCalendarFacts) {
  await owner(db, account, isCurrent); const row = await receiptFor(db, operationId);
  if (!row || row.account_scope !== accountScope(account) || row.revision !== expected.revision || !row.attempted || ['cancelled', 'discarded'].includes(row.status)) throw new Error('Refresh the original Calendar receipt.');
  if (!await adapter.permission(true)) throw new Error('Calendar reading was not allowed. The original event and CRM notes are retained.');
  await owner(db, account, isCurrent);
  // A search result is a preview. Reread the selected event before accepting any source facts.
  const facts = candidate ? await adapter.get(candidate.id) : row.event_id ? await adapter.get(row.event_id) : null;
  if (!facts) throw new Error('The original event was not found. Choose its calendar and a date window to verify its marker; it will not be recreated.');
  if (candidate && (facts.id !== candidate.id || facts.calendar_id !== candidate.calendar_id)) throw new Error('The selected event moved during review. Search again.');
  return (await applyObservation(db, account, row, facts, { explicit: true, follow: expected.follow, reads: expected.reads, epoch: expected.epoch, planFingerprint: expected.planFingerprint }, isCurrent)).receipt;
}
export async function findAppleCalendar(db: DB, account: NativeAccount, operationId: string, calendarId: string, start: string, end: string, adapter: AppleCalendarAdapter, isCurrent = () => true) {
  await owner(db, account, isCurrent); const row = await receiptFor(db, operationId);
  if (!row || !row.attempted || row.account_scope !== accountScope(account) || ['cancelled', 'discarded'].includes(row.status) || !calendarId || calendarId.length > 1024) throw new Error('Choose the original Calendar receipt.');
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 366 * 86400000) throw new Error('Choose a valid search window lasting no more than one year.');
  if (!await adapter.permission(true)) throw new Error('Calendar reading was not allowed.');
  await owner(db, account, isCurrent);
  const url = (JSON.parse(row.request_json) as { url: string }).url, found = await adapter.find(calendarId, start, end, url);
  await owner(db, account, isCurrent);
  if (found.length > 5000) throw new Error('Too many Calendar results. Choose a smaller date window.');
  const matches = found.map(readAppleCalendarFacts).filter((facts) => facts.url === url && facts.calendar_id === calendarId);
  if (matches.length !== 1) throw new Error(matches.length ? 'Several events match this receipt. Review them in Calendar before linking one.' : 'No original event matched this calendar and window. Keep its receipt; another event will not be created.');
  return matches[0];
}
export async function editAppleCalendar(db: DB, account: NativeAccount, operationId: string, expected: { revision: number; epoch: string | null; planFingerprint: string }, adapter: AppleCalendarAdapter, isCurrent = () => true) {
  await owner(db, account, isCurrent); const row = await receiptFor(db, operationId);
  if (!row || row.account_scope !== accountScope(account) || row.revision !== expected.revision || !row.event_id || row.status !== 'verified') throw new Error('Verify the original event before opening it for editing.');
  if (!await adapter.permission(true)) throw new Error('Calendar reading was not allowed.');
  await owner(db, account, isCurrent);
  const facts = await adapter.get(row.event_id);
  if (!facts || facts.url !== (JSON.parse(row.request_json) as { url: string }).url || facts.recurring || facts.cancelled) throw new Error('The original event is missing or changed. Verify it again before editing.');
  await db.withExclusiveTransactionAsync(async (tx) => {
    await owner(tx, account, isCurrent); const fresh = await appleCalendarReview(tx, row.plan_id);
    if (fresh.receipt?.id !== operationId || fresh.receipt.revision !== expected.revision || fresh.epoch !== expected.epoch || fresh.planFingerprint !== expected.planFingerprint || !fresh.plan || fresh.plan.completed_at || fresh.linkedEventId) throw new Error('The plan, account or receipt changed during review.');
    // Suspend date following while the user controls the editor. Its reply cannot prove the resulting date.
    await tx.runAsync("UPDATE apple_calendar_receipts SET status = 'unknown', issue = 'editor_unconfirmed', read_enabled = 0, follow_date = 0, revision = revision + 1 WHERE id = ? AND revision = ?", operationId, expected.revision);
  });
  await owner(db, account, isCurrent);
  const fresh = await appleCalendarReview(db, row.plan_id);
  if (fresh.receipt?.revision !== expected.revision + 1 || fresh.receipt.status !== 'unknown' || fresh.epoch !== expected.epoch || fresh.planFingerprint !== expected.planFingerprint || fresh.linkedEventId || !isCurrent()) throw new Error('The plan or account changed before the editor opened. Keep the original event receipt.');
  let result: { action: string; id: string | null };
  try { result = await adapter.edit(facts.id); } catch { throw new Error('The editor reply is unconfirmed. Verify the original event again.'); }
  if (!['saved', 'canceled', 'deleted'].includes(result.action) || result.id !== null && (typeof result.id !== 'string' || !result.id || result.id.length > 1024)) throw new Error('The editor reply is unconfirmed. Verify the original event again.');
  const bound = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'account-scope'");
  if (bound?.value !== row.account_scope) throw new Error('The original Calendar cache is unavailable.');
  const held = !isCurrent() || await epoch(db) !== expected.epoch;
  await db.runAsync(`UPDATE apple_calendar_receipts SET event_id = ?, status = ?, issue = ?, revision = revision + 1
    WHERE id = ? AND revision = ? AND status = 'unknown'`, result.id || row.event_id, held ? 'held' : result.action === 'deleted' ? 'missing' : 'saved', held ? 'account_changed' : 'verification_needed', operationId, expected.revision + 1);
  return (await receiptFor(db, operationId))!;
}
export async function disableAppleCalendarReads(db: DB, account: NativeAccount, operationId: string, revision: number, isCurrent = () => true) {
  await owner(db, account, isCurrent);
  const saved = await db.runAsync('UPDATE apple_calendar_receipts SET read_enabled = 0, follow_date = 0, revision = revision + 1 WHERE id = ? AND account_scope = ? AND revision = ?', operationId, accountScope(account), revision);
  if (!saved.changes) throw new Error('The Calendar receipt changed. Refresh it again.');
}
export async function refreshAppleCalendarReads(db: DB, account: NativeAccount, adapter: AppleCalendarAdapter, isCurrent = () => true) {
  await owner(db, account, isCurrent); const rows = await db.getAllAsync<AppleCalendarReceipt>(`SELECT * FROM apple_calendar_receipts WHERE account_scope = ? AND read_enabled = 1
    AND (last_read_at IS NULL OR julianday(last_read_at) < julianday('now', '-15 minutes')) ORDER BY COALESCE(last_read_at, ''), id LIMIT 50`, accountScope(account));
  let changed = 0;
  if (!rows.length) return { changed };
  const permitted = await adapter.permission(false);
  for (const row of rows) {
    await owner(db, account, isCurrent);
    if (!permitted || row.read_epoch !== await epoch(db)) { await db.runAsync("UPDATE apple_calendar_receipts SET status = 'held', issue = ?, follow_date = 0, read_enabled = 0, revision = revision + 1 WHERE id = ? AND revision = ?", permitted ? 'epoch_changed' : 'permission_lost', row.id, row.revision); continue; }
    try {
      const facts = row.event_id ? await adapter.get(row.event_id) : null;
      if (!facts) { await db.runAsync("UPDATE apple_calendar_receipts SET status = 'missing', issue = 'event_missing', follow_date = 0, read_enabled = 0, revision = revision + 1 WHERE id = ? AND revision = ?", row.id, row.revision); continue; }
      const r = await applyObservation(db, account, row, facts, { explicit: false, follow: Boolean(row.follow_date), reads: true, epoch: row.read_epoch }, isCurrent); if (r.changed) changed++;
    } catch {
      await owner(db, account, isCurrent);
      await db.runAsync("UPDATE apple_calendar_receipts SET status = 'held', issue = 'verification_failed', follow_date = 0, read_enabled = 0, revision = revision + 1 WHERE id = ? AND revision = ?", row.id, row.revision);
    }
  }
  return { changed };
}
