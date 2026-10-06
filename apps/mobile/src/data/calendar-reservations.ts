import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { accountScope, type NativeAccount } from '../../../../packages/domain/src/devices';
import { isSyncUuid } from '../../../../packages/domain/src/sync';
import { publicationPlanSnapshot, type CalendarReservation } from '../../../../packages/domain/src/calendar-reservations';
import { contextForEditing } from './context';
import type { AppleCalendarReceipt } from './apple-calendar';

type DB = SQLiteDatabase;
type Options = { fetcher?: typeof fetch; isCurrent?: () => boolean };
export type LocalCalendarReservation = {
  id: string; account_scope: string; device_id: string; epoch: string; plan_id: string; plan_fingerprint: string;
  server_revision: number | null; server_status: CalendarReservation['status'] | null; reserve_request_json: string;
  attempt_request_json: string | null; request_json: string | null; result_action: 'saved' | 'canceled' | null;
  status: 'pending' | 'ready' | 'confirmed' | 'released' | 'held'; last_error: string | null;
};
export class NativeCalendarReservationError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
const locks = new WeakMap<DB, Promise<unknown>>();
function serial<T>(db: DB, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(db) ?? Promise.resolve();
  const running = previous.catch(() => {}).then(task); locks.set(db, running);
  void running.finally(() => { if (locks.get(db) === running) locks.delete(db); }).catch(() => {});
  return running;
}
export const localCalendarReservation = (db: DB, id: string) => db.getFirstAsync<LocalCalendarReservation>('SELECT * FROM apple_calendar_reservations WHERE id = ?', id);
async function currentEpoch(db: DB) {
  const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'");
  const value: unknown = row ? JSON.parse(row.value) : null;
  return value && typeof value === 'object' && 'epoch' in value && isSyncUuid(value.epoch) ? value.epoch : null;
}
async function owner(db: DB, account: NativeAccount, isCurrent: () => boolean, row?: Pick<LocalCalendarReservation, 'account_scope' | 'device_id' | 'epoch'>) {
  if (!isCurrent() || (await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'account-scope'"))?.value !== accountScope(account)) {
    throw new NativeCalendarReservationError('The active account changed. Keep the original Calendar receipt.');
  }
  if (Date.parse(account.expiresAt) <= Date.now()) throw new NativeCalendarReservationError('Sign in again before opening Calendar.', 401);
  if (row && (row.account_scope !== accountScope(account) || row.device_id !== account.deviceId || row.epoch !== await currentEpoch(db))) {
    throw new NativeCalendarReservationError('This Calendar reservation belongs to an earlier sign-in or account recovery. Verify the original event; it will not be recreated.');
  }
}
function envelope(value: unknown, epoch: string, id?: string, planId?: string): CalendarReservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeCalendarReservationError('Could not confirm the Calendar reservation.', 502);
  const v = value as Record<string, unknown>, r = v.reservation as Record<string, unknown> | null;
  if (v.version !== 1 || v.epoch !== epoch || r !== null && (!r || typeof r !== 'object'
    || !isSyncUuid(r.id) || !isSyncUuid(r.plan_id) || !isSyncUuid(r.epoch)
    || id !== undefined && r.id !== id || planId !== undefined && r.plan_id !== planId
    || !['apple-calendar', 'google-calendar'].includes(String(r.provider))
    || !['reserved', 'attempted', 'saved', 'cancelled', 'held'].includes(String(r.status))
    || typeof r.attempted !== 'boolean' || typeof r.on_this_phone !== 'boolean'
    || !Number.isSafeInteger(r.revision) || Number(r.revision) < 1
    || r.plan_fingerprint !== null && (typeof r.plan_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(r.plan_fingerprint)))) {
    throw new NativeCalendarReservationError('Could not confirm the Calendar reservation.', 502);
  }
  return r as CalendarReservation | null;
}
async function request(account: NativeAccount, fetcher: typeof fetch, isCurrent: () => boolean, body?: string, query?: URLSearchParams) {
  if (!isCurrent()) throw new NativeCalendarReservationError('The active account changed.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetcher(`${account.origin}/api/v1/calendar-reservations${query ? '?' + query.toString() : ''}`, {
      method: body ? 'POST' : 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${account.token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body,
    });
    const text = await response.text();
    if (!isCurrent()) throw new NativeCalendarReservationError('The active account changed.');
    if (!response.ok) throw new NativeCalendarReservationError(response.status === 404 || response.status === 501
      ? 'Shared Calendar publication is not available on this server yet. Your draft and original receipt are retained.'
      : response.status === 401 || response.status === 403 ? 'Sign in with the original account before continuing Calendar.'
        : response.status === 409 ? 'The plan or its shared Calendar receipt changed. Sync your account and review the original receipt.'
          : 'Could not confirm the shared Calendar receipt. Keep your draft and reconnect.', response.status);
    if (new TextEncoder().encode(text).byteLength > 16 * 1024) throw new NativeCalendarReservationError('Could not confirm the Calendar reservation.', 502);
    try { return JSON.parse(text) as unknown; } catch { throw new NativeCalendarReservationError('Could not confirm the Calendar reservation.', 502); }
  } catch (error) {
    if (error instanceof NativeCalendarReservationError) throw error;
    throw new NativeCalendarReservationError('Reconnect to confirm this Calendar reservation. Your draft and original receipt are retained.', 503);
  } finally { clearTimeout(timer); }
}
function body(row: LocalCalendarReservation, action: 'reserve' | 'attempt' | 'release' | 'result', result?: 'saved' | 'canceled') {
  return JSON.stringify({ action, operation_id: row.id, plan_id: row.plan_id, expected_epoch: row.epoch,
    expected_revision: action === 'reserve' ? null : row.server_revision, expected_plan_fingerprint: row.plan_fingerprint,
    ...(action === 'result' ? { result_action: result } : {}) });
}
async function send(db: DB, account: NativeAccount, row: LocalCalendarReservation, options: Options) {
  if (!row.request_json) return row;
  const isCurrent = options.isCurrent ?? (() => true);
  try {
    await owner(db, account, isCurrent, row);
    const input = JSON.parse(row.request_json) as { action: string; expected_revision: number | null; result_action?: string };
    const result = envelope(await request(account, options.fetcher ?? fetch, isCurrent, row.request_json), row.epoch, row.id, row.plan_id);
    if (!result || result.provider !== 'apple-calendar' || !result.on_this_phone || result.epoch !== row.epoch || result.plan_fingerprint !== row.plan_fingerprint
      || input.action === 'attempt' && (result.status !== 'attempted' || !result.attempted || result.revision !== Number(input.expected_revision) + 1)
      || input.action === 'release' && (result.status !== 'cancelled' || result.attempted)
      || input.action === 'result' && (result.status !== (input.result_action === 'saved' ? 'saved' : 'cancelled') || !result.attempted)
      || input.action === 'reserve' && (result.status !== 'reserved' || result.attempted)) {
      throw new NativeCalendarReservationError('Keep the original Calendar receipt. This event cannot be opened again.');
    }
    await db.withExclusiveTransactionAsync(async (tx) => {
      await owner(tx, account, isCurrent, row); const fresh = await localCalendarReservation(tx, row.id);
      if (!fresh || fresh.request_json !== row.request_json || fresh.server_revision !== row.server_revision) throw new NativeCalendarReservationError('The Calendar review changed.');
      await tx.runAsync('UPDATE apple_calendar_reservations SET server_revision = ?, server_status = ?, request_json = NULL, status = ?, last_error = NULL, updated_at = ? WHERE id = ?',
        result.revision, result.status, result.status === 'saved' ? 'confirmed' : result.status === 'cancelled' ? 'released' : 'ready', new Date().toISOString(), row.id);
    });
    return (await localCalendarReservation(db, row.id))!;
  } catch (error) {
    // A lost response retains the exact request. Recovery/session changes hold it,
    // and a subsequent foreground never opens the system editor.
    if (isCurrent() && (await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'account-scope'"))?.value === row.account_scope) {
      await db.runAsync('UPDATE apple_calendar_reservations SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND request_json = ?',
        error instanceof NativeCalendarReservationError && [400, 401, 403, 409, 423].includes(error.status) ? 'held' : 'pending',
        error instanceof NativeCalendarReservationError ? String(error.status) : 'local_write', new Date().toISOString(), row.id, row.request_json);
    }
    throw error;
  }
}
export function syncCalendarReservations(db: DB, account: NativeAccount, options: Options = {}) {
  return serial(db, async () => {
    const isCurrent = options.isCurrent ?? (() => true); await owner(db, account, isCurrent);
    let confirmed = 0;
    const rows = await db.getAllAsync<LocalCalendarReservation>("SELECT * FROM apple_calendar_reservations WHERE request_json IS NOT NULL AND status = 'pending' ORDER BY rowid LIMIT 8");
    for (const row of rows) { await send(db, account, row, options); confirmed++; }
    return { confirmed };
  });
}
export function authorizeCalendarEditor(db: DB, account: NativeAccount, receipt: AppleCalendarReceipt, options: Options = {}) {
  return serial(db, async () => {
    const isCurrent = options.isCurrent ?? (() => true); await owner(db, account, isCurrent);
    let row = await localCalendarReservation(db, receipt.id);
    if (!row) {
      await db.withExclusiveTransactionAsync(async (tx) => {
        await owner(tx, account, isCurrent);
        const epoch = await currentEpoch(tx), plan = await contextForEditing(tx, 'plan', receipt.plan_id);
        const fresh = await tx.getFirstAsync<AppleCalendarReceipt>('SELECT * FROM apple_calendar_receipts WHERE id = ?', receipt.id);
        if (!epoch || epoch !== receipt.epoch || !plan || plan.completed_at || !fresh || fresh.revision !== receipt.revision || fresh.attempted || fresh.status !== 'prepared') {
          throw new NativeCalendarReservationError('Sync the plan and refresh its Calendar draft before opening the editor.');
        }
        const fingerprint = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(publicationPlanSnapshot({
          public_id: plan.id, contact_public_id: plan.contact_id, type: String(plan.type), planned_date: String(plan.planned_date),
          summary: plan.summary as string | null, notes: plan.notes as string | null, completed_at: plan.completed_at as string | null,
        })))).toLowerCase();
        const initial = { id: receipt.id, plan_id: receipt.plan_id, epoch, plan_fingerprint: fingerprint, server_revision: null } as LocalCalendarReservation;
        const request = body(initial, 'reserve');
        await tx.runAsync(`INSERT INTO apple_calendar_reservations (id, account_scope, device_id, epoch, plan_id, plan_fingerprint,
          reserve_request_json, request_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          receipt.id, accountScope(account), account.deviceId, epoch, receipt.plan_id, fingerprint, request, request, new Date().toISOString());
      });
      row = (await localCalendarReservation(db, receipt.id))!;
    }
    await owner(db, account, isCurrent, row);
    if (row.request_json) row = await send(db, account, row, options);
    if (row.server_status === 'reserved') {
      const request = body(row, 'attempt');
      await db.withExclusiveTransactionAsync(async (tx) => {
        await owner(tx, account, isCurrent, row!);
        await tx.runAsync("UPDATE apple_calendar_reservations SET attempt_request_json = ?, request_json = ?, status = 'pending', updated_at = ? WHERE id = ? AND request_json IS NULL AND server_status = 'reserved' AND server_revision = ?",
          request, request, new Date().toISOString(), row!.id, row!.server_revision);
      });
      row = await send(db, account, (await localCalendarReservation(db, row.id))!, options);
    } else if (row.server_status === 'attempted' && row.attempt_request_json) {
      // Only an explicit user action can resume this authorization, while the
      // private local receipt still proves that no editor was attempted.
      const result = envelope(await request(account, options.fetcher ?? fetch, isCurrent, row.attempt_request_json), row.epoch, row.id, row.plan_id);
      if (!result || result.status !== 'attempted' || !result.attempted || !result.on_this_phone || result.revision !== row.server_revision || result.plan_fingerprint !== row.plan_fingerprint) {
        throw new NativeCalendarReservationError('The original Calendar reservation changed. Keep its receipt.');
      }
    }
    if (row.server_status !== 'attempted' || row.status !== 'ready') throw new NativeCalendarReservationError('The original Calendar reservation needs review. The editor has not been reopened.');
    await owner(db, account, isCurrent, row); return row;
  });
}
// Called in the same SQLite transaction as the originating editor result. It
// never includes EventKit IDs, event facts, private CRM notes or invitees.
export async function queueCalendarEditorResult(db: DB, id: string, result: 'saved' | 'canceled') {
  const row = await localCalendarReservation(db, id);
  if (!row || row.server_status !== 'attempted' || row.request_json || row.result_action) throw new NativeCalendarReservationError('The original Calendar publication receipt is unavailable.');
  await db.runAsync("UPDATE apple_calendar_reservations SET request_json = ?, result_action = ?, status = 'pending', updated_at = ? WHERE id = ?", body(row, 'result', result), result, new Date().toISOString(), id);
}
export function releaseCalendarReservation(db: DB, account: NativeAccount, id: string, options: Options = {}) {
  return serial(db, async () => {
    let row = await localCalendarReservation(db, id); if (!row) return;
    const isCurrent = options.isCurrent ?? (() => true); await owner(db, account, isCurrent, row);
    if (row.request_json) row = await send(db, account, row, options);
    if (row.server_status === 'cancelled' && row.status === 'released') return;
    if (!['reserved', 'held'].includes(row.server_status ?? '') || row.attempt_request_json || row.result_action) {
      throw new NativeCalendarReservationError('This Calendar publication may have reached an editor. Keep its original receipt instead of discarding it.');
    }
    await db.withExclusiveTransactionAsync(async (tx) => {
      await owner(tx, account, isCurrent, row!);
      await tx.runAsync("UPDATE apple_calendar_reservations SET request_json = ?, status = 'pending', updated_at = ? WHERE id = ? AND request_json IS NULL", body(row!, 'release'), new Date().toISOString(), id);
    });
    await send(db, account, (await localCalendarReservation(db, id))!, options);
  });
}
export async function readSharedCalendarReservation(db: DB, account: NativeAccount, planId: string, options: Options = {}) {
  const isCurrent = options.isCurrent ?? (() => true); await owner(db, account, isCurrent);
  const epoch = await currentEpoch(db); if (!epoch || !isSyncUuid(planId)) throw new NativeCalendarReservationError('Sync this saved plan before reviewing shared Calendar status.');
  const result = envelope(await request(account, options.fetcher ?? fetch, isCurrent, undefined, new URLSearchParams({ epoch, plan_id: planId })), epoch, undefined, planId);
  await owner(db, account, isCurrent); if (await currentEpoch(db) !== epoch) throw new NativeCalendarReservationError('Account data changed. Refresh this Calendar review.');
  return result;
}
export { currentEpoch as currentCalendarEpoch, owner as requireCalendarAccount, request as requestCalendarStatus, envelope as readCalendarReservationEnvelope };
