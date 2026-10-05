import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { accountScope, type NativeAccount } from '../../../../packages/domain/src/devices';
import { dateInTimeZone, normalizeTimeZone } from '../../../../packages/domain/src/civil-date';
import { isSyncUuid } from '../../../../packages/domain/src/sync';
import { MAX_ACTIVE_TODAY_SNOOZES, PromptSnoozeError, isPromptKind, readPromptAcknowledgement, readPromptSnapshot, validatePromptUntil,
  type PromptKind, type PromptMutation } from '../../../../packages/domain/src/today-snoozes';
import { canonicalContactId } from './contact-aliases';
import { signalSyncChange } from './sync-signals';

type CacheRow = { kind: PromptKind; target_id: string; contact_id: string; until_date: string | null; remote_until_date: string | null };
type QueueRow = CacheRow & { id: string; base_until_date: string | null; epoch: string | null; time_zone: string;
  depends_on: string | null; request_json: string | null; status: 'pending' | 'conflict'; last_error_code: string | null };
export type SnoozedPrompt = CacheRow & { contact_name: string; reminder_title: string | null; conflict: number; pending: number };
export type PromptReview = CacheRow & { epoch: string | null; cloudKnown: boolean; queueSignature: string; conflict: boolean };
const inFlight = new WeakMap<SQLiteDatabase, Promise<{ changed: number }>>();
async function accountCheck(db: SQLiteDatabase, account: NativeAccount | null, isCurrent: () => boolean) {
  const scope = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'account-scope'");
  if (!isCurrent() || scope?.value !== (account ? accountScope(account) : 'local-only')) throw new PromptSnoozeError('The active account changed. Open Today again.', 409, 'account_changed');
}
async function currentEpoch(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'");
  const epoch = row ? (JSON.parse(row.value) as { epoch?: unknown }).epoch : null;
  return isSyncUuid(epoch) ? epoch : null;
}
async function ensureEpoch(db: SQLiteDatabase, epoch: string) {
  if (await currentEpoch(db) !== epoch) throw new PromptSnoozeError('Account data changed. Keep your choices and sync again.', 409, 'epoch_changed');
}
async function target(db: SQLiteDatabase, kind: PromptKind, targetId: string, restoring = false) {
  if (!isPromptKind(kind) || !isSyncUuid(targetId)) throw new PromptSnoozeError('Choose a valid saved prompt.');
  const row = kind === 'reminder'
    ? await db.getFirstAsync<{ contact_id: string }>(`SELECT r.contact_id FROM reminders r JOIN contacts c ON c.id = r.contact_id
      WHERE r.id = ? AND r.deleted_at IS NULL AND c.deleted_at IS NULL ${restoring ? '' : 'AND r.completed_at IS NULL'}`, targetId)
    : await db.getFirstAsync<{ contact_id: string }>(`SELECT id AS contact_id FROM contacts WHERE id = ? AND deleted_at IS NULL
      ${kind === 'birthday' && !restoring ? 'AND birthday IS NOT NULL' : ''}`, targetId);
  if (!row || await canonicalContactId(db, row.contact_id) !== row.contact_id) throw new PromptSnoozeError('This prompt’s person or reminder changed. Review the current relationship.', 409, 'target_changed');
  return row.contact_id;
}
async function overlay(db: SQLiteDatabase, kind: PromptKind, targetId: string) {
  const pending = await db.getFirstAsync<{ until_date: string | null }>('SELECT until_date FROM today_snooze_queue WHERE kind = ? AND target_id = ? ORDER BY rowid DESC LIMIT 1', kind, targetId);
  await db.runAsync('UPDATE today_snoozes SET until_date = CASE WHEN ? THEN ? ELSE remote_until_date END WHERE kind = ? AND target_id = ?',
    pending ? 1 : 0, pending?.until_date ?? null, kind, targetId);
}
export async function holdPromptSnoozesForEpoch(db: SQLiteDatabase, epoch: string) {
  await db.runAsync("UPDATE today_snooze_queue SET status = 'conflict', last_error_code = 'epoch_changed' WHERE epoch IS NOT NULL AND epoch != ?", epoch);
  const observed = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'today-snoozes-epoch'");
  if (observed && observed.value !== epoch) {
    await db.runAsync('UPDATE today_snoozes SET remote_until_date = NULL');
    for (const row of await db.getAllAsync<CacheRow>('SELECT * FROM today_snoozes')) await overlay(db, row.kind, row.target_id);
    await db.runAsync("DELETE FROM app_metadata WHERE key = 'today-snoozes-epoch'");
  }
}
export async function savePromptSnooze(db: SQLiteDatabase, account: NativeAccount | null, kind: PromptKind, targetId: string,
  untilDate: string | null, options: { isCurrent?: () => boolean; now?: Date; timeZone?: string } = {}) {
  const now = options.now ?? new Date(), timeZone = normalizeTimeZone(options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const isCurrent = options.isCurrent ?? (() => true); validatePromptUntil(untilDate, now, timeZone);
  await db.withExclusiveTransactionAsync(async (tx) => {
    await accountCheck(tx, account, isCurrent);
    const contactId = await target(tx, kind, targetId, untilDate === null);
    const previous = await tx.getFirstAsync<QueueRow>('SELECT * FROM today_snooze_queue WHERE kind = ? AND target_id = ? ORDER BY rowid DESC LIMIT 1', kind, targetId);
    if (await tx.getFirstAsync("SELECT id FROM today_snooze_queue WHERE kind = ? AND target_id = ? AND status = 'conflict'", kind, targetId)) {
      throw new PromptSnoozeError('Review the web and iPhone choices before changing this prompt.', 409, 'review_required');
    }
    const cached = await tx.getFirstAsync<CacheRow>('SELECT * FROM today_snoozes WHERE kind = ? AND target_id = ?', kind, targetId);
    if ((cached?.until_date ?? null) === untilDate) return;
    const today = dateInTimeZone(now, timeZone)!;
    const count = await tx.getFirstAsync<{ n: number }>('SELECT COUNT(*) n FROM today_snoozes WHERE until_date > ?', today);
    if (untilDate && !(cached?.until_date && cached.until_date > today) && count!.n >= MAX_ACTIVE_TODAY_SNOOZES) {
      throw new PromptSnoozeError('Too many snoozed prompts. Bring one back before snoozing another.', 409, 'prompt_capacity');
    }
    await tx.runAsync(`INSERT INTO today_snoozes (kind, target_id, contact_id, until_date, remote_until_date) VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(kind, target_id) DO UPDATE SET until_date = excluded.until_date`, kind, targetId, contactId, untilDate);
    if (account) await tx.runAsync(`INSERT INTO today_snooze_queue (id, kind, target_id, contact_id, until_date, base_until_date, epoch, time_zone, depends_on, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, Crypto.randomUUID(), kind, targetId, contactId, untilDate,
    previous ? previous.until_date : cached?.remote_until_date ?? null, await currentEpoch(tx), timeZone, previous?.id ?? null, now.toISOString());
    else await tx.runAsync('UPDATE today_snoozes SET remote_until_date = ? WHERE kind = ? AND target_id = ?', untilDate, kind, targetId);
    await accountCheck(tx, account, isCurrent);
  });
  signalSyncChange(db);
}
export async function listSnoozedPrompts(db: SQLiteDatabase, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Promise<SnoozedPrompt[]> {
  const today = dateInTimeZone(now, timeZone); if (!today) throw new PromptSnoozeError('Could not read today’s date.');
  return db.getAllAsync<SnoozedPrompt>(`SELECT s.*, COALESCE(c.name, 'Unavailable person') AS contact_name, r.title AS reminder_title,
    EXISTS (SELECT 1 FROM today_snooze_queue q WHERE q.kind = s.kind AND q.target_id = s.target_id AND q.status = 'conflict') AS conflict,
    EXISTS (SELECT 1 FROM today_snooze_queue q WHERE q.kind = s.kind AND q.target_id = s.target_id) AS pending
    FROM today_snoozes s LEFT JOIN contacts c ON c.id = s.contact_id LEFT JOIN reminders r ON s.kind = 'reminder' AND r.id = s.target_id
    WHERE s.until_date > ? OR EXISTS (SELECT 1 FROM today_snooze_queue q WHERE q.kind = s.kind AND q.target_id = s.target_id AND q.status = 'conflict')
    ORDER BY conflict DESC, s.until_date, s.kind, s.target_id LIMIT ?`, today, MAX_ACTIVE_TODAY_SNOOZES);
}
async function applySnapshot(db: SQLiteDatabase, account: NativeAccount, epoch: string, value: unknown, isCurrent: () => boolean) {
  const snoozes = readPromptSnapshot(value, epoch);
  await db.withExclusiveTransactionAsync(async (tx) => {
    await accountCheck(tx, account, isCurrent); await ensureEpoch(tx, epoch);
    await tx.runAsync("UPDATE today_snooze_queue SET status = 'conflict', last_error_code = 'epoch_changed' WHERE epoch IS NOT NULL AND epoch != ?", epoch);
    await tx.runAsync('UPDATE today_snoozes SET remote_until_date = NULL');
    for (const row of snoozes) await tx.runAsync(`INSERT INTO today_snoozes (kind, target_id, contact_id, until_date, remote_until_date) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(kind, target_id) DO UPDATE SET contact_id = excluded.contact_id, remote_until_date = excluded.remote_until_date`,
    row.kind, row.targetId, row.contactId, row.untilDate, row.untilDate);
    const rows = await tx.getAllAsync<CacheRow>('SELECT * FROM today_snoozes');
    for (const row of rows) await overlay(tx, row.kind, row.target_id);
    await tx.runAsync(`DELETE FROM today_snoozes WHERE until_date IS NULL AND remote_until_date IS NULL
      AND NOT EXISTS (SELECT 1 FROM today_snooze_queue q WHERE q.kind = today_snoozes.kind AND q.target_id = today_snoozes.target_id)`);
    await tx.runAsync(`INSERT INTO app_metadata (key, value, updated_at) VALUES ('today-snoozes-epoch', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, epoch, new Date().toISOString());
    await accountCheck(tx, account, isCurrent);
  });
}
async function request(account: NativeAccount, fetcher: typeof fetch, isCurrent: () => boolean, epoch: string, timeZone: string, body?: string) {
  if (!isCurrent()) throw new PromptSnoozeError('The active account changed.', 409, 'account_changed');
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const query = body ? '' : '?' + new URLSearchParams({ epoch, timeZone }).toString();
    const response = await fetcher(`${account.origin}/api/v1/today-snoozes${query}`, { method: body ? 'POST' : 'GET', credentials: 'omit', redirect: 'error',
      signal: controller.signal, headers: { Authorization: `Bearer ${account.token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body });
    const text = await response.text();
    if (!isCurrent()) throw new PromptSnoozeError('The active account changed.', 409, 'account_changed');
    if (new TextEncoder().encode(text).byteLength > 192 * 1024) throw new PromptSnoozeError('The prompt download is too large. Your choices are safe.', 502, 'invalid_snapshot');
    let value: unknown; try { value = JSON.parse(text); } catch { throw new PromptSnoozeError('Could not confirm prompt choices. Your choices are safe.', 502, 'invalid_response'); }
    if (!response.ok) {
      const error = value as { error?: string; code?: string };
      throw new PromptSnoozeError(response.status === 404 ? 'Prompt choices are saved on this iPhone. Shared prompt sync is not available yet.'
        : typeof error?.error === 'string' ? error.error : 'Unable to sync prompt choices. They remain saved on this iPhone.', response.status,
      typeof error?.code === 'string' ? error.code : `http_${response.status}`);
    }
    return value;
  } catch (error) {
    if (error instanceof PromptSnoozeError) throw error;
    throw new PromptSnoozeError('Unable to sync prompt choices. They remain saved on this iPhone.', 503, 'network');
  } finally { clearTimeout(timeout); }
}
export function syncPromptSnoozes(db: SQLiteDatabase, account: NativeAccount, options: { fetcher?: typeof fetch; isCurrent?: () => boolean; timeZone?: string } = {}) {
  const existing = inFlight.get(db); if (existing) return existing;
  const isCurrent = options.isCurrent ?? (() => true), fetcher = options.fetcher ?? fetch;
  const timeZone = normalizeTimeZone(options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const running = (async () => {
    await accountCheck(db, account, isCurrent); const epoch = await currentEpoch(db); if (!epoch) return { changed: 0 };
    await applySnapshot(db, account, epoch, await request(account, fetcher, isCurrent, epoch, timeZone), isCurrent);
    let changed = 0;
    for (let step = 0; step < 8; step++) {
      let frozen: { row: QueueRow; body: string } | null = null;
      await db.withExclusiveTransactionAsync(async (tx) => {
        await accountCheck(tx, account, isCurrent); await ensureEpoch(tx, epoch);
        const row = await tx.getFirstAsync<QueueRow>(`SELECT q.* FROM today_snooze_queue q WHERE q.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM today_snooze_queue older WHERE older.kind = q.kind AND older.target_id = q.target_id AND older.rowid < q.rowid)
          AND (q.request_json IS NOT NULL OR NOT EXISTS (SELECT 1 FROM sync_queue core WHERE core.entity_type = 'contact' AND core.entity_id = q.contact_id
            OR q.kind = 'reminder' AND core.entity_type = 'reminder' AND core.entity_id = q.target_id)) ORDER BY q.rowid LIMIT 1`);
        if (!row) return;
        if (!row.request_json) {
          try { await target(tx, row.kind, row.target_id, row.until_date === null); }
          catch { await tx.runAsync("UPDATE today_snooze_queue SET status = 'conflict', last_error_code = 'target_changed' WHERE id = ?", row.id); return; }
          if (!await tx.getFirstAsync('SELECT id FROM sync_remote_contacts WHERE id = ?', row.contact_id)) return;
        }
        const body = row.request_json ?? JSON.stringify({ version: 1, operationId: row.id, epoch, kind: row.kind,
          targetId: row.target_id, baseUntilDate: row.base_until_date, untilDate: row.until_date, timeZone: row.time_zone } satisfies PromptMutation);
        await tx.runAsync('UPDATE today_snooze_queue SET request_json = ?, epoch = ? WHERE id = ?', body, epoch, row.id);
        frozen = { row, body };
      });
      const item = frozen as { row: QueueRow; body: string } | null; if (!item) break;
      try {
        const mutation = JSON.parse(item.body) as PromptMutation;
        const until = readPromptAcknowledgement(await request(account, fetcher, isCurrent, epoch, timeZone, item.body), mutation);
        await db.withExclusiveTransactionAsync(async (tx) => {
          await accountCheck(tx, account, isCurrent); await ensureEpoch(tx, epoch);
          const current = await tx.getFirstAsync<QueueRow>('SELECT * FROM today_snooze_queue WHERE id = ?', item.row.id);
          if (!current || current.request_json !== item.body || current.status !== 'pending') throw new PromptSnoozeError('The saved choice changed while syncing. Retry shortly.', 409, 'review_changed');
          await tx.runAsync('UPDATE today_snoozes SET remote_until_date = ? WHERE kind = ? AND target_id = ?', until, current.kind, current.target_id);
          await tx.runAsync('UPDATE today_snooze_queue SET base_until_date = ?, depends_on = NULL WHERE depends_on = ? AND request_json IS NULL', until, current.id);
          await tx.runAsync('DELETE FROM today_snooze_queue WHERE id = ?', current.id);
          await overlay(tx, current.kind, current.target_id);
        }); changed++;
      } catch (error) {
        if (!(error instanceof PromptSnoozeError) || !(error.status === 409 && ['prompt_changed', 'target_changed', 'prompt_capacity', 'receipt_mismatch'].includes(error.code)
          || error.status === 400 && error.code === 'invalid_until')) throw error;
        await db.withExclusiveTransactionAsync(async (tx) => {
          await accountCheck(tx, account, isCurrent); await ensureEpoch(tx, epoch);
          await tx.runAsync("UPDATE today_snooze_queue SET status = 'conflict', last_error_code = ? WHERE id = ? AND request_json = ?", error.code, item.row.id, item.body);
        }); changed++;
      }
    }
    await applySnapshot(db, account, epoch, await request(account, fetcher, isCurrent, epoch, timeZone), isCurrent);
    return { changed };
  })();
  inFlight.set(db, running); void running.finally(() => { if (inFlight.get(db) === running) inFlight.delete(db); }).catch(() => {});
  return running;
}
const queueSignature = (rows: QueueRow[]) => JSON.stringify(rows.map((row) => [row.id, row.request_json, row.status, row.until_date]));
export async function getPromptReview(db: SQLiteDatabase, kind: PromptKind, targetId: string): Promise<PromptReview> {
  const row = await db.getFirstAsync<CacheRow>('SELECT * FROM today_snoozes WHERE kind = ? AND target_id = ?', kind, targetId);
  if (!row) throw new PromptSnoozeError('This saved prompt is no longer available.', 409, 'review_changed');
  const queue = await db.getAllAsync<QueueRow>('SELECT * FROM today_snooze_queue WHERE kind = ? AND target_id = ? ORDER BY rowid', kind, targetId);
  const epoch = await currentEpoch(db), observed = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'today-snoozes-epoch'");
  return { ...row, epoch, cloudKnown: epoch !== null && observed?.value === epoch, queueSignature: queueSignature(queue), conflict: queue.some((item) => item.status === 'conflict') };
}
export async function resolvePromptReview(db: SQLiteDatabase, account: NativeAccount, review: PromptReview, choice: 'cloud' | 'phone', isCurrent: () => boolean = () => true, replacementUntil?: string,
  options: { now?: Date; timeZone?: string } = {}) {
  const now = options.now ?? new Date(), timeZone = normalizeTimeZone(options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  await db.withExclusiveTransactionAsync(async (tx) => {
    await accountCheck(tx, account, isCurrent); const current = await getPromptReview(tx, review.kind, review.target_id);
    const observed = await tx.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'today-snoozes-epoch'");
    const queue = await tx.getAllAsync<QueueRow>('SELECT * FROM today_snooze_queue WHERE kind = ? AND target_id = ?', review.kind, review.target_id);
    if (!current.conflict || current.queueSignature !== review.queueSignature || current.epoch !== review.epoch || !current.epoch
      || observed?.value !== current.epoch || current.remote_until_date !== review.remote_until_date || current.until_date !== review.until_date
      || queue.some((item) => item.request_json && item.status === 'pending')) throw new PromptSnoozeError('The choice changed. Review it again without losing the saved iPhone choice.', 409, 'review_changed');
    const until = choice === 'phone' ? replacementUntil ?? current.until_date : current.remote_until_date;
    if (choice === 'phone') { await target(tx, current.kind, current.target_id, until === null); validatePromptUntil(until, now, timeZone); }
    await tx.runAsync('DELETE FROM today_snooze_queue WHERE kind = ? AND target_id = ?', current.kind, current.target_id);
    await tx.runAsync('UPDATE today_snoozes SET until_date = ? WHERE kind = ? AND target_id = ?', until, current.kind, current.target_id);
    if (choice === 'phone' && until !== current.remote_until_date) await tx.runAsync(`INSERT INTO today_snooze_queue (id, kind, target_id, contact_id, until_date, base_until_date, epoch, time_zone, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, Crypto.randomUUID(), current.kind, current.target_id, current.contact_id, until,
    current.remote_until_date, current.epoch, timeZone, now.toISOString());
    await accountCheck(tx, account, isCurrent);
  }); signalSyncChange(db);
}
