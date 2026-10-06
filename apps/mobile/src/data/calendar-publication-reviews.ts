import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { accountScope, type NativeAccount } from '../../../../packages/domain/src/devices';
import { isSyncUuid } from '../../../../packages/domain/src/sync';
import { readAppleCalendarFacts } from '../../../../packages/domain/src/apple-calendar';
import { publicationPlanSnapshot, readCalendarPublicationReview } from '../../../../packages/domain/src/calendar-reservations';
import { contextForEditing } from './context';
import type { AppleCalendarReceipt } from './apple-calendar';
import { currentCalendarEpoch, requireCalendarAccount, requestCalendarStatus, readCalendarReservationEnvelope, NativeCalendarReservationError } from './calendar-reservations';

type DB = SQLiteDatabase;
type Options = { fetcher?: typeof fetch; isCurrent?: () => boolean };
export type LocalCalendarPublicationReview = {
  id: string; receipt_id: string; account_scope: string; device_id: string; epoch: string; plan_id: string;
  private_revision: number; request_json: string; attempted: number; status: 'pending' | 'confirmed' | 'held' | 'superseded';
  server_revision: number | null; server_status: string | null; server_creation_epoch: string | null; last_error: string | null;
};
export const latestCalendarPublicationReview = (db: DB, id: string) => db.getFirstAsync<LocalCalendarPublicationReview>(
  'SELECT * FROM apple_calendar_publication_reviews WHERE receipt_id = ? ORDER BY rowid DESC LIMIT 1', id);
const queues = new WeakMap<DB, Promise<unknown>>();
function serial<T>(db: DB, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(db) ?? Promise.resolve(), running = previous.catch(() => {}).then(task); queues.set(db, running);
  void running.finally(() => { if (queues.get(db) === running) queues.delete(db); }).catch(() => {}); return running;
}
async function planFingerprint(db: DB, planId: string) {
  const plan = await contextForEditing(db, 'plan', planId);
  if (!plan) throw new NativeCalendarReservationError('The original plan is unavailable. Keep its event receipt.');
  return (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(publicationPlanSnapshot({
    public_id: plan.id, contact_public_id: plan.contact_id, type: String(plan.type), planned_date: String(plan.planned_date),
    summary: plan.summary as string | null, notes: plan.notes as string | null, completed_at: plan.completed_at as string | null,
  })))).toLowerCase();
}
async function privateProof(db: DB, id: string, revision: number, epoch: string) {
  const receipt = await db.getFirstAsync<AppleCalendarReceipt>('SELECT * FROM apple_calendar_receipts WHERE id = ?', id);
  if (!receipt || !receipt.attempted || receipt.status !== 'verified' || receipt.revision !== revision || receipt.read_epoch !== epoch || !receipt.facts) {
    throw new NativeCalendarReservationError('Verify the original event again before sharing its status.');
  }
  const facts = readAppleCalendarFacts(JSON.parse(receipt.facts));
  if (facts.recurring || facts.cancelled || facts.url !== (JSON.parse(receipt.request_json) as { url: string }).url) {
    throw new NativeCalendarReservationError('The original event marker is missing or the event changed. Keep its receipt.');
  }
  const pending = await db.getFirstAsync(`SELECT q.id FROM sync_queue q JOIN plans p ON p.id = ?
    WHERE q.entity_type = 'plan' AND q.entity_id = p.id OR q.entity_type = 'contact' AND q.entity_id = p.contact_id LIMIT 1`, receipt.plan_id);
  if (pending) throw new NativeCalendarReservationError('Sync the person and plan first, then verify and share the original event.');
  return { receipt, facts };
}
export function queueVerifiedCalendarPublication(db: DB, account: NativeAccount, id: string, revision: number, options: Options & { operationId?: string } = {}) {
  return serial(db, async () => {
    const isCurrent = options.isCurrent ?? (() => true); await requireCalendarAccount(db, account, isCurrent);
    const epoch = await currentCalendarEpoch(db); if (!epoch) throw new NativeCalendarReservationError('Sync your account before sharing Calendar verification.');
    const { receipt } = await privateProof(db, id, revision, epoch), operation = options.operationId ?? Crypto.randomUUID();
    if (!isSyncUuid(operation)) throw new NativeCalendarReservationError('Choose a fresh Calendar verification.');
    const response = await requestCalendarStatus(account, options.fetcher ?? fetch, isCurrent, undefined,
      new URLSearchParams({ plan_id: receipt.plan_id, epoch, operation_id: id }));
    const existing = readCalendarReservationEnvelope(response, epoch, id, receipt.plan_id), preview = response as { plan_fingerprint?: unknown };
    if (existing && existing.provider !== 'apple-calendar') throw new NativeCalendarReservationError('Review this event’s source identity before sharing its original Apple receipt.');
    if (typeof preview.plan_fingerprint !== 'string' || preview.plan_fingerprint !== await planFingerprint(db, receipt.plan_id)) {
      throw new NativeCalendarReservationError('Sync and review the current plan before sharing its Calendar verification.');
    }
    const marker = (JSON.parse(receipt.request_json) as { url: string }).url;
    const body = JSON.stringify(readCalendarPublicationReview({ action: 'reconcile', operation_id: operation, receipt_id: id, plan_id: receipt.plan_id,
      expected_epoch: epoch, expected_reservation_revision: existing?.revision ?? null, expected_plan_fingerprint: preview.plan_fingerprint, observed_marker: marker }));
    await db.withExclusiveTransactionAsync(async (tx) => {
      await requireCalendarAccount(tx, account, isCurrent);
      if (await currentCalendarEpoch(tx) !== epoch) throw new NativeCalendarReservationError('Account recovery changed. Verify the original event again.');
      await privateProof(tx, id, revision, epoch);
      if (await planFingerprint(tx, receipt.plan_id) !== preview.plan_fingerprint) throw new NativeCalendarReservationError('The plan changed during review. Keep the verified event.');
      await tx.runAsync("UPDATE apple_calendar_publication_reviews SET status = 'superseded' WHERE receipt_id = ? AND status IN ('pending', 'held')", id);
      const now = new Date().toISOString();
      await tx.runAsync(`INSERT INTO apple_calendar_publication_reviews (id, receipt_id, account_scope, device_id, epoch, plan_id,
        private_revision, request_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        operation, id, accountScope(account), account.deviceId, epoch, receipt.plan_id, revision, body, now, now);
    });
    return (await latestCalendarPublicationReview(db, id))!;
  });
}
export function syncCalendarPublicationReviews(db: DB, account: NativeAccount, options: Options = {}) {
  return serial(db, async () => {
    const isCurrent = options.isCurrent ?? (() => true); await requireCalendarAccount(db, account, isCurrent);
    const rows = await db.getAllAsync<LocalCalendarPublicationReview>("SELECT * FROM apple_calendar_publication_reviews WHERE status = 'pending' ORDER BY rowid LIMIT 8");
    let confirmed = 0;
    for (const original of rows) {
      try {
        await requireCalendarAccount(db, account, isCurrent, original);
        const input = readCalendarPublicationReview(JSON.parse(original.request_json));
        if (!original.attempted) {
          await db.withExclusiveTransactionAsync(async (tx) => {
            await requireCalendarAccount(tx, account, isCurrent, original); await privateProof(tx, original.receipt_id, original.private_revision, original.epoch);
            if (await planFingerprint(tx, original.plan_id) !== input.expected_plan_fingerprint) throw new NativeCalendarReservationError('The plan changed. Verify the original event again.');
            await tx.runAsync("UPDATE apple_calendar_publication_reviews SET attempted = 1, updated_at = ? WHERE id = ? AND status = 'pending' AND attempted = 0", new Date().toISOString(), original.id);
          });
        }
        // An unknown reply retries only the immutable metadata request. It never
        // reads Calendar, opens an editor, or changes the plan or private facts.
        const response = await requestCalendarStatus(account, options.fetcher ?? fetch, isCurrent, original.request_json);
        const result = readCalendarReservationEnvelope(response, original.epoch, original.receipt_id, original.plan_id);
        const acknowledgement = response as { review_id?: unknown; confirmed?: unknown };
        if (acknowledgement.review_id !== original.id || acknowledgement.confirmed !== true || !result || result.provider !== 'apple-calendar'
          || !result.attempted || !['saved', 'held'].includes(result.status)) throw new NativeCalendarReservationError('Keep the verified event. Its shared verification reply is unconfirmed.', 502);
        await db.withExclusiveTransactionAsync(async (tx) => {
          await requireCalendarAccount(tx, account, isCurrent, original);
          const row = await tx.getFirstAsync<LocalCalendarPublicationReview>('SELECT * FROM apple_calendar_publication_reviews WHERE id = ?', original.id);
          if (!row || row.status !== 'pending' || !row.attempted || row.request_json !== original.request_json) throw new NativeCalendarReservationError('The original Calendar verification changed.');
          await tx.runAsync("UPDATE apple_calendar_publication_reviews SET status = 'confirmed', server_revision = ?, server_status = ?, server_creation_epoch = ?, last_error = NULL, updated_at = ? WHERE id = ?",
            result.revision, result.status, result.epoch, new Date().toISOString(), original.id);
          // Retain an older outbox body verbatim. A positive fresh verification
          // acknowledges its original external event without transferring identity.
          await tx.runAsync('UPDATE apple_calendar_reservations SET server_revision = ?, server_status = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ? AND epoch = ? AND (server_revision IS NULL OR server_revision <= ?)',
            result.revision, result.status, result.status === 'saved' ? 'confirmed' : 'held', 'original_event_verified', new Date().toISOString(), original.receipt_id, result.epoch, result.revision);
        });
        confirmed++;
      } catch (error) {
        if (isCurrent() && (await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'account-scope'"))?.value === original.account_scope) {
          await db.runAsync("UPDATE apple_calendar_publication_reviews SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
            error instanceof NativeCalendarReservationError && [400, 401, 403, 409, 423].includes(error.status) ? 'held' : 'pending',
            error instanceof NativeCalendarReservationError ? String(error.status) : 'local_write', new Date().toISOString(), original.id);
        }
        throw error;
      }
    }
    return { confirmed };
  });
}
