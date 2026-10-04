import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { accountScope, type NativeAccount } from '../../../../packages/domain/src/devices';
import { CalendarLinkError, calendarLinksFingerprintInput, readCalendarLinkMutation, readCalendarLinkAcknowledgement } from '../../../../packages/domain/src/calendar-event-links';
import { calendarContextIds, readSyncV4Record } from '../../../../packages/domain/src/sync-v4-client';
import { readSyncCursor } from '../../../../packages/domain/src/sync-client';
import { applyRemoteCalendarEvent, projectCalendarEvent, type NativeCalendarEvent } from './calendar-events';
import { signalSyncChange } from './sync-signals';

export type CalendarLinkQueueRow = {
  id: string; event_id: string; epoch: string; base_fingerprint: string; contact_ids: string; plan_ids: string;
  request_json: string | null; status: 'pending' | 'conflict'; last_error_code: string | null; attempts: number; created_at: string;
};
export type CalendarLinkReview = {
  eventId: string; event: NativeCalendarEvent | null; epoch: string | null; currentFingerprint: string | null;
  queue: CalendarLinkQueueRow | null; contactIds: string[]; planIds: string[];
};
export type CalendarLinkChoice = { id: string; label: string; detail: string | null; unavailable: boolean; linkedElsewhere: boolean };
const fingerprint = async (record: unknown) => (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(calendarLinksFingerprintInput(record)))).toLowerCase();
const queueFor = (db: SQLiteDatabase, id: string) => db.getFirstAsync<CalendarLinkQueueRow>('SELECT * FROM calendar_event_link_queue WHERE event_id = ?', id);
async function epoch(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'sync-cursor-v4'");
  return row ? readSyncCursor(JSON.parse(row.value)).epoch : null;
}
async function accountCheck(db: SQLiteDatabase, account: NativeAccount, isCurrent: () => boolean) {
  if (!isCurrent() || (await db.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = 'account-scope'"))?.value !== accountScope(account)) {
    throw new CalendarLinkError('The active account changed. These choices were not saved to another account.', 409, 'account_changed');
  }
}
async function review(db: SQLiteDatabase, id: string): Promise<CalendarLinkReview> {
  const raw = await db.getFirstAsync<{ record_json: string }>('SELECT record_json FROM calendar_events WHERE id = ?', id), queue = await queueFor(db, id);
  const record = raw ? readSyncV4Record(JSON.parse(raw.record_json)) : null;
  return { eventId: id, event: raw ? await projectCalendarEvent(db, raw.record_json, false) : null, epoch: await epoch(db),
    currentFingerprint: record ? await fingerprint(record) : null, queue,
    contactIds: queue ? calendarContextIds(queue.contact_ids) : record ? calendarContextIds(record.data!.contact_ids) : [],
    planIds: queue ? calendarContextIds(queue.plan_ids) : record ? calendarContextIds(record.data!.plan_ids) : [] };
}
export async function getCalendarLinkReview(db: SQLiteDatabase, id: string) {
  let result: CalendarLinkReview | null = null;
  await db.withExclusiveTransactionAsync(async (tx) => { result = await review(tx, id); });
  return result!;
}
export async function holdCalendarLinksForEpoch(db: SQLiteDatabase, current: string) {
  await db.runAsync("UPDATE calendar_event_link_queue SET status = 'conflict', last_error_code = 'epoch_changed' WHERE epoch != ?", current);
}
async function targets(db: SQLiteDatabase, eventId: string, contactIds: string[], planIds: string[]) {
  const people = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) n FROM contacts WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))', JSON.stringify(contactIds));
  const plans = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM plans p JOIN contacts c ON c.id = p.contact_id
    WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL AND p.id IN (SELECT value FROM json_each(?))`, JSON.stringify(planIds));
  if (people?.n !== contactIds.length || plans?.n !== planIds.length) throw new CalendarLinkError('A selected person or plan is unavailable or merged. Remove it and review the current choices.', 409, 'target_changed');
  if (await db.getFirstAsync(`SELECT 1 FROM calendar_events e, json_each(json_extract(e.record_json, '$.data.plan_ids')) link
      WHERE e.id != ? AND link.value IN (SELECT value FROM json_each(?))
      UNION ALL SELECT 1 FROM calendar_event_link_queue q, json_each(q.plan_ids) link WHERE q.event_id != ? AND link.value IN (SELECT value FROM json_each(?)) LIMIT 1`,
  eventId, JSON.stringify(planIds), eventId, JSON.stringify(planIds))) throw new CalendarLinkError('A selected plan is linked or queued for another meeting. Review that link first.', 409, 'plan_linked');
}

/** The caller must explicitly review the current digest and queue identity before replacing a held intent. */
export async function saveCalendarLinks(db: SQLiteDatabase, account: NativeAccount, base: {
  eventId: string; epoch: string; fingerprint: string; queueId: string | null;
}, contactIds: string[], planIds: string[], isCurrent: () => boolean = () => true) {
  const mutation = readCalendarLinkMutation({ version: 1, operationId: Crypto.randomUUID(), epoch: base.epoch,
    eventId: base.eventId, baseFingerprint: base.fingerprint, contactIds, planIds });
  await db.withExclusiveTransactionAsync(async (tx) => {
    await accountCheck(tx, account, isCurrent);
    const current = await review(tx, base.eventId);
    if ((current.queue?.id ?? null) !== base.queueId || current.epoch !== base.epoch || current.currentFingerprint !== base.fingerprint || !current.event) {
      throw new CalendarLinkError('The saved meeting or queued choices changed. Review the current meeting without losing your choices.', 409, 'review_changed');
    }
    if (current.queue?.request_json && current.queue.status === 'pending') throw new CalendarLinkError('The previous request is still unconfirmed. Retry it unchanged before editing.', 409, 'operation_pending');
    await targets(tx, base.eventId, contactIds, planIds);
    await accountCheck(tx, account, isCurrent);
    if (current.queue) await tx.runAsync('DELETE FROM calendar_event_link_queue WHERE id = ?', current.queue.id);
    await tx.runAsync(`INSERT INTO calendar_event_link_queue (id, event_id, epoch, base_fingerprint, contact_ids, plan_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, mutation.operationId, mutation.eventId, mutation.epoch, mutation.baseFingerprint,
    JSON.stringify(contactIds), JSON.stringify(planIds), new Date().toISOString());
  });
  signalSyncChange(db);
  return mutation.operationId;
}
export async function discardCalendarLinkReview(db: SQLiteDatabase, account: NativeAccount, queueId: string, isCurrent: () => boolean = () => true) {
  await db.withExclusiveTransactionAsync(async (tx) => {
    await accountCheck(tx, account, isCurrent);
    const row = await tx.getFirstAsync<CalendarLinkQueueRow>('SELECT * FROM calendar_event_link_queue WHERE id = ?', queueId);
    if (!row || row.status !== 'conflict') throw new CalendarLinkError('Only a held, definite conflict can be discarded. Retry an unconfirmed request unchanged.', 409, 'review_changed');
    await tx.runAsync("DELETE FROM calendar_event_link_queue WHERE id = ? AND status = 'conflict'", queueId);
  });
  signalSyncChange(db);
}
export const calendarLinkSyncReviews = (db: SQLiteDatabase) => db.getAllAsync<CalendarLinkQueueRow>("SELECT * FROM calendar_event_link_queue WHERE status = 'conflict' ORDER BY created_at, id LIMIT 100");

export async function calendarLinkChoices(db: SQLiteDatabase, eventId: string, kind: 'person' | 'plan', search = '', after = 0, selected: string[] = []) {
  if (search.length > 200 || /[\u0000-\u001f\u007f]/u.test(search) || !Number.isSafeInteger(after) || after < 0) throw new CalendarLinkError('Use a shorter search or restart this directory.');
  calendarContextIds(JSON.stringify(selected));
  const select = kind === 'person'
    ? `SELECT c.id, c.name label, COALESCE(NULLIF(c.email, ''), NULLIF(c.phone, '')) detail, 0 unavailable, 0 linkedElsewhere FROM contacts c WHERE c.deleted_at IS NULL`
    : `SELECT p.id, COALESCE(NULLIF(p.summary, ''), 'Plan') label, c.name || ' · ' || COALESCE(p.planned_date, 'No date') || CASE WHEN p.completed_at IS NULL THEN '' ELSE ' · Completed' END detail,
        0 unavailable, (EXISTS (SELECT 1 FROM calendar_events e, json_each(json_extract(e.record_json, '$.data.plan_ids')) link WHERE e.id != ? AND link.value = p.id)
        OR EXISTS (SELECT 1 FROM calendar_event_link_queue q, json_each(q.plan_ids) link WHERE q.event_id != ? AND link.value = p.id)) linkedElsewhere
        FROM plans p JOIN contacts c ON c.id = p.contact_id AND c.deleted_at IS NULL WHERE p.deleted_at IS NULL`;
  const binds = kind === 'person' ? [] : [eventId, eventId];
  const match = kind === 'person'
    ? ` AND (instr(lower(c.name), lower(?)) > 0 OR instr(lower(COALESCE(c.email, '')), lower(?)) > 0 OR instr(lower(COALESCE(c.phone, '')), lower(?)) > 0 OR EXISTS (SELECT 1 FROM json_each(c.contact_methods) WHERE instr(lower(json_extract(value, '$.value')), lower(?)) > 0))`
    : ` AND (instr(lower(COALESCE(p.summary, '')), lower(?)) > 0 OR instr(lower(c.name), lower(?)) > 0 OR instr(COALESCE(p.planned_date, ''), ?) > 0)`;
  const rows = await db.getAllAsync<CalendarLinkChoice>(select + match + ` ORDER BY ${kind === 'person' ? 'c.name' : 'p.planned_date'} COLLATE NOCASE, ${kind === 'person' ? 'c.id' : 'p.id'} LIMIT 51 OFFSET ?`,
    ...binds, ...Array.from({ length: kind === 'person' ? 4 : 3 }, () => search.trim()), after);
  const saved = await db.getAllAsync<CalendarLinkChoice>(select + ` AND ${kind === 'person' ? 'c.id' : 'p.id'} IN (SELECT value FROM json_each(?))`, ...binds, JSON.stringify(selected));
  return { choices: rows.slice(0, 50), more: rows.length > 50, selected: selected.map((id) => saved.find((item) => item.id === id)
    ?? { id, label: kind === 'person' ? 'Unavailable person' : 'Unavailable plan', detail: null, unavailable: true, linkedElsewhere: false }) };
}

/** Six-entity writes go first. Once frozen, even a removed target/event must retry its original receipt. */
export async function syncCalendarLinks(db: SQLiteDatabase, currentEpoch: string, request: (body: string) => Promise<unknown>, checkAccount: (tx: SQLiteDatabase) => Promise<void>) {
  let changed = 0;
  for (let step = 0; step < 8; step++) {
    let frozen: { row: CalendarLinkQueueRow; body: string } | null = null;
    let held = false;
    await db.withExclusiveTransactionAsync(async (tx) => {
      await checkAccount(tx); await holdCalendarLinksForEpoch(tx, currentEpoch);
      const row = await tx.getFirstAsync<CalendarLinkQueueRow>(`SELECT q.* FROM calendar_event_link_queue q WHERE status = 'pending'
        AND (request_json IS NOT NULL OR NOT EXISTS (SELECT 1 FROM sync_queue core WHERE
          core.entity_type = 'contact' AND core.entity_id IN (SELECT value FROM json_each(q.contact_ids))
          OR core.entity_type = 'plan' AND core.entity_id IN (SELECT value FROM json_each(q.plan_ids)))
        AND NOT EXISTS (SELECT 1 FROM json_each(q.contact_ids) link JOIN contacts c ON c.id = link.value AND c.deleted_at IS NULL
          LEFT JOIN sync_remote_contacts r ON r.id = c.id WHERE r.id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM json_each(q.plan_ids) link JOIN plans p ON p.id = link.value AND p.deleted_at IS NULL
          LEFT JOIN sync_remote_entities r ON r.id = p.id AND r.entity_type = 'plan' WHERE r.id IS NULL)) ORDER BY created_at, id LIMIT 1`);
      if (!row) return;
      if (row.request_json) { frozen = { row, body: row.request_json }; return; }
      const raw = await tx.getFirstAsync<{ record_json: string }>('SELECT record_json FROM calendar_events WHERE id = ?', row.event_id);
      try {
        if (!raw) throw new CalendarLinkError('The saved meeting was removed.', 409, 'event_missing');
        if (await fingerprint(JSON.parse(raw.record_json)) !== row.base_fingerprint) throw new CalendarLinkError('The meeting changed.', 409, 'event_changed');
        const contactIds = calendarContextIds(row.contact_ids), planIds = calendarContextIds(row.plan_ids);
        await targets(tx, row.event_id, contactIds, planIds);
        // An earlier local-only row must not silently masquerade as an uploaded public target.
        for (const id of contactIds) if (!await tx.getFirstAsync("SELECT 1 FROM sync_remote_contacts WHERE id = ? AND json_extract(record_json, '$.deleted') = 0", id)) return;
        for (const id of planIds) if (!await tx.getFirstAsync("SELECT 1 FROM sync_remote_entities WHERE entity_type = 'plan' AND id = ? AND json_extract(record_json, '$.deleted') = 0", id)) return;
        const body = JSON.stringify(readCalendarLinkMutation({ version: 1, operationId: row.id, epoch: row.epoch, eventId: row.event_id,
          baseFingerprint: row.base_fingerprint, contactIds, planIds }));
        await tx.runAsync('UPDATE calendar_event_link_queue SET request_json = ? WHERE id = ? AND request_json IS NULL', body, row.id);
        frozen = { row, body };
      } catch (error) {
        if (!(error instanceof CalendarLinkError) || error.status !== 409) throw error;
        await tx.runAsync("UPDATE calendar_event_link_queue SET status = 'conflict', last_error_code = ? WHERE id = ?", error.code, row.id);
        changed++; held = true;
      }
    });
    const item = frozen as { row: CalendarLinkQueueRow; body: string } | null;
    if (!item) { if (held) continue; break; }
    await db.withExclusiveTransactionAsync(async (tx) => {
      await checkAccount(tx); await tx.runAsync('UPDATE calendar_event_link_queue SET attempts = attempts + 1 WHERE id = ? AND request_json = ?', item.row.id, item.body);
    });
    try {
      const result = readCalendarLinkAcknowledgement(await request(item.body), readCalendarLinkMutation(JSON.parse(item.body)));
      await db.withExclusiveTransactionAsync(async (tx) => {
        await checkAccount(tx);
        if (await epoch(tx) !== result.epoch) throw new CalendarLinkError('Account data was restored.', 409, 'epoch_changed');
        if (!await tx.getFirstAsync("SELECT 1 FROM calendar_event_link_queue WHERE id = ? AND request_json = ? AND status = 'pending'", item.row.id, item.body)) throw new Error('These queued meeting choices changed while confirming.');
        if (result.event) await applyRemoteCalendarEvent(tx, result.event);
        else await tx.runAsync('DELETE FROM calendar_events WHERE id = ?', item.row.event_id);
        await tx.runAsync('DELETE FROM calendar_event_link_queue WHERE id = ? AND request_json = ?', item.row.id, item.body);
      }); changed++;
    } catch (error) {
      const issue = error as { status?: number; code?: string };
      const definite = [400, 409, 413].includes(issue.status ?? 0) && !['epoch_changed', 'account_changed'].includes(issue.code ?? '');
      await db.withExclusiveTransactionAsync(async (tx) => {
        await checkAccount(tx);
        await tx.runAsync('UPDATE calendar_event_link_queue SET status = ?, last_error_code = ? WHERE id = ? AND request_json = ?',
          definite ? 'conflict' : 'pending', issue.code ?? 'confirmation_unavailable', item.row.id, item.body);
      });
      if (!definite) throw error;
      changed++;
    }
  }
  return changed;
}
