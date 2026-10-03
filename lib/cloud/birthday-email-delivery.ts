import { dateInTimeZone, nextBirthdayOccurrence } from '@/lib/civil-date';
import { emailDeliveryAvailable, isQuietHour, nextAllowedEmailTime } from '@/lib/cloud/reminder-email-delivery';

type DB = CloudflareEnv['DB'];
type Sender = { send(message: { to: string; from: string; subject: string; text: string }): Promise<{ messageId?: string }> };
type EmailEnv = CloudflareEnv & { EMAIL?: Sender; EMAIL_FROM?: string };
type ScanRow = {
  workspace_id: string; user_id: string; time_zone: string; contact_id: number;
  birthday: string; birthday_reminder_days: number;
};
type ChildScanRow = ScanRow & { child_id: number };
type DeliveryRow = ScanRow & { id: number; child_id: number | null; linked_contact_id: number | null; occurrence: string; email: string;
  quiet_start_hour: number; quiet_end_hour: number };
type Claimed = { id: number; attempts: number };

const SCAN_LIMIT = 2_000;
const CANDIDATE_LIMIT = 500;
const MAX_EMAILS_PER_RUN = 8;
const MAX_EVENTS_PER_EMAIL = 20;
export const CHILD_BIRTHDAY_LEAD_DAYS = 7;

function birthdayStillDue(row: DeliveryRow, now: Date): boolean {
  if (row.child_id !== null && row.linked_contact_id !== null) return false;
  const today = dateInTimeZone(now, row.time_zone);
  const occurrence = today && nextBirthdayOccurrence(row.birthday, today);
  return Boolean(occurrence && occurrence.occurrence === row.occurrence
    && occurrence.daysUntil <= row.birthday_reminder_days);
}

async function scanChildBirthdays(db: DB, now: Date) {
  const cursor = await db.prepare(`SELECT workspace_id, user_id, child_id
    FROM child_birthday_email_scan_state WHERE id = 1`)
    .first<{ workspace_id: string | null; user_id: string | null; child_id: number | null }>();
  const query = `SELECT p.workspace_id, p.user_id, p.time_zone, child.id AS child_id,
      child.contact_id, child.birthday, ${CHILD_BIRTHDAY_LEAD_DAYS} AS birthday_reminder_days
    FROM reminder_email_preferences p
    JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = p.user_id
    JOIN user u ON u.id = p.user_id
    JOIN workspaces w ON w.id = p.workspace_id
    JOIN contact_children child ON child.workspace_id = p.workspace_id
    JOIN contacts c ON c.workspace_id = child.workspace_id AND c.id = child.contact_id
    WHERE p.enabled = 1 AND p.enabled_at IS NOT NULL AND u.email_verified = 1
      AND w.lifecycle = 'active' AND child.birthday IS NOT NULL AND child.linked_contact_id IS NULL
      AND (p.workspace_id > ? OR (p.workspace_id = ? AND p.user_id > ?)
        OR (p.workspace_id = ? AND p.user_id = ? AND child.id > ?))
    ORDER BY p.workspace_id, p.user_id, child.id LIMIT ?`;
  const read = (workspaceId: string, userId: string, childId: number) => db.prepare(query)
    .bind(workspaceId, workspaceId, userId, workspaceId, userId, childId, SCAN_LIMIT).all<ChildScanRow>();
  let scan = await read(cursor?.workspace_id || '', cursor?.user_id || '', cursor?.child_id || 0);
  if (!scan.results.length && cursor?.workspace_id) scan = await read('', '', 0);
  if (!scan.results.length) return { scanned: 0, queued: 0 };

  const due = [];
  for (const row of scan.results as ChildScanRow[]) {
    const today = dateInTimeZone(now, row.time_zone);
    const occurrence = today && nextBirthdayOccurrence(row.birthday, today);
    if (occurrence && occurrence.daysUntil <= CHILD_BIRTHDAY_LEAD_DAYS) {
      due.push({ workspaceId: row.workspace_id, userId: row.user_id,
        childId: row.child_id, contactId: row.contact_id, occurrence: occurrence.occurrence });
    }
  }
  let queued = 0;
  if (due.length) {
    const insert = await db.prepare(`INSERT OR IGNORE INTO birthday_email_deliveries
      (workspace_id, user_id, contact_id, child_id, occurrence, next_attempt_at)
      SELECT json_extract(j.value, '$.workspaceId'), json_extract(j.value, '$.userId'),
        json_extract(j.value, '$.contactId'), json_extract(j.value, '$.childId'), json_extract(j.value, '$.occurrence'), ?
      FROM json_each(?) j
      JOIN reminder_email_preferences p ON p.workspace_id = json_extract(j.value, '$.workspaceId')
        AND p.user_id = json_extract(j.value, '$.userId') AND p.enabled = 1
      JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = p.user_id
      JOIN user u ON u.id = p.user_id AND u.email_verified = 1
      JOIN workspaces w ON w.id = p.workspace_id AND w.lifecycle = 'active'
      JOIN contact_children child ON child.id = json_extract(j.value, '$.childId')
        AND child.workspace_id = p.workspace_id
        AND child.contact_id = json_extract(j.value, '$.contactId')
        AND child.birthday IS NOT NULL AND child.linked_contact_id IS NULL`)
      .bind(now.toISOString(), JSON.stringify(due)).run();
    queued = insert.meta.changes || 0;
  }
  const last = (scan.results as ChildScanRow[]).at(-1)!;
  await db.prepare(`INSERT INTO child_birthday_email_scan_state
    (id, workspace_id, user_id, child_id, updated_at) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id,
      user_id = excluded.user_id, child_id = excluded.child_id, updated_at = excluded.updated_at`)
    .bind(last.workspace_id, last.user_id, last.child_id, now.toISOString()).run();
  return { scanned: scan.results.length, queued };
}

async function scanBirthdays(db: DB, now: Date) {
  const cursor = await db.prepare(`SELECT workspace_id, user_id, contact_id
    FROM birthday_email_scan_state WHERE id = 1`)
    .first<{ workspace_id: string | null; user_id: string | null; contact_id: number | null }>();
  const query = `SELECT p.workspace_id, p.user_id, p.time_zone, c.id AS contact_id,
      c.birthday, c.birthday_reminder_days
    FROM reminder_email_preferences p
    JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = p.user_id
    JOIN user u ON u.id = p.user_id
    JOIN workspaces w ON w.id = p.workspace_id
    JOIN contacts c ON c.workspace_id = p.workspace_id
    WHERE p.enabled = 1 AND p.enabled_at IS NOT NULL AND u.email_verified = 1
      AND w.lifecycle = 'active' AND c.birthday IS NOT NULL
      AND (p.workspace_id > ? OR (p.workspace_id = ? AND p.user_id > ?)
        OR (p.workspace_id = ? AND p.user_id = ? AND c.id > ?))
    ORDER BY p.workspace_id, p.user_id, c.id LIMIT ?`;
  const read = (workspaceId: string, userId: string, contactId: number) => db.prepare(query)
    .bind(workspaceId, workspaceId, userId, workspaceId, userId, contactId, SCAN_LIMIT).all<ScanRow>();
  let scan = await read(cursor?.workspace_id || '', cursor?.user_id || '', cursor?.contact_id || 0);
  if (!scan.results.length && cursor?.workspace_id) scan = await read('', '', 0);
  if (!scan.results.length) return { scanned: 0, queued: 0 };

  const due = [];
  for (const row of scan.results as ScanRow[]) {
    const today = dateInTimeZone(now, row.time_zone);
    const occurrence = today && nextBirthdayOccurrence(row.birthday, today);
    if (occurrence && occurrence.daysUntil <= row.birthday_reminder_days) {
      due.push({ workspaceId: row.workspace_id, userId: row.user_id,
        contactId: row.contact_id, occurrence: occurrence.occurrence });
    }
  }
  let queued = 0;
  if (due.length) {
    const insert = await db.prepare(`INSERT OR IGNORE INTO birthday_email_deliveries
      (workspace_id, user_id, contact_id, occurrence, next_attempt_at)
      SELECT json_extract(j.value, '$.workspaceId'), json_extract(j.value, '$.userId'),
        json_extract(j.value, '$.contactId'), json_extract(j.value, '$.occurrence'), ?
      FROM json_each(?) j
      JOIN reminder_email_preferences p ON p.workspace_id = json_extract(j.value, '$.workspaceId')
        AND p.user_id = json_extract(j.value, '$.userId') AND p.enabled = 1
      JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = p.user_id
      JOIN user u ON u.id = p.user_id AND u.email_verified = 1
      JOIN workspaces w ON w.id = p.workspace_id AND w.lifecycle = 'active'
      JOIN contacts c ON c.id = json_extract(j.value, '$.contactId')
        AND c.workspace_id = p.workspace_id AND c.birthday IS NOT NULL`)
      .bind(now.toISOString(), JSON.stringify(due)).run();
    queued = insert.meta.changes || 0;
  }
  const last = (scan.results as ScanRow[]).at(-1)!;
  await db.prepare(`INSERT INTO birthday_email_scan_state
    (id, workspace_id, user_id, contact_id, updated_at) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id,
      user_id = excluded.user_id, contact_id = excluded.contact_id, updated_at = excluded.updated_at`)
    .bind(last.workspace_id, last.user_id, last.contact_id, now.toISOString()).run();
  return { scanned: scan.results.length, queued };
}

export async function deliverBirthdayEmails(db: DB, env: CloudflareEnv, now = new Date()) {
  const result = { scanned: 0, queued: 0, sent: 0, eventsSent: 0, failed: 0, quiet: 0 };
  if (!emailDeliveryAvailable(env)) return result;
  const sender = env as EmailEnv;
  const nowIso = now.toISOString();
  const scan = await scanBirthdays(db, now);
  const childScan = await scanChildBirthdays(db, now);
  result.scanned = scan.scanned + childScan.scanned;
  result.queued = scan.queued + childScan.queued;

  const candidates = await db.prepare(`SELECT d.id, d.workspace_id, d.user_id, d.contact_id, d.child_id,
      d.occurrence, u.email, p.time_zone, p.quiet_start_hour, p.quiet_end_hour,
      child.linked_contact_id,
      CASE WHEN d.child_id IS NULL THEN c.birthday ELSE child.birthday END AS birthday,
      CASE WHEN d.child_id IS NULL THEN c.birthday_reminder_days ELSE ${CHILD_BIRTHDAY_LEAD_DAYS} END AS birthday_reminder_days
    FROM birthday_email_deliveries d
    JOIN reminder_email_preferences p ON p.workspace_id = d.workspace_id AND p.user_id = d.user_id
    JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id
    JOIN user u ON u.id = d.user_id
    JOIN workspaces w ON w.id = d.workspace_id
    JOIN contacts c ON c.id = d.contact_id AND c.workspace_id = d.workspace_id
    LEFT JOIN contact_children child ON child.id = d.child_id AND child.workspace_id = d.workspace_id AND child.contact_id = d.contact_id
    WHERE (d.status = 'pending' OR (d.status = 'leased' AND d.lease_until <= ?))
      AND d.next_attempt_at <= ? AND p.enabled = 1 AND p.enabled_at IS NOT NULL
      AND u.email_verified = 1 AND w.lifecycle = 'active'
    ORDER BY d.next_attempt_at, d.id LIMIT ?`)
    .bind(nowIso, nowIso, CANDIDATE_LIMIT).all<DeliveryRow>();
  const staleIds: number[] = [];
  const quietRows: Array<{ id: number; nextAt: string }> = [];
  const ready = new Map<string, number[]>();
  for (const candidate of candidates.results as DeliveryRow[]) {
    if (!birthdayStillDue(candidate, now)) { staleIds.push(candidate.id); continue; }
    if (isQuietHour(now, candidate.time_zone, candidate.quiet_start_hour, candidate.quiet_end_hour)) {
      quietRows.push({ id: candidate.id, nextAt: nextAllowedEmailTime(now, candidate.time_zone,
        candidate.quiet_start_hour, candidate.quiet_end_hour) });
      continue;
    }
    const key = JSON.stringify([candidate.workspace_id, candidate.user_id]);
    if (!ready.has(key) && ready.size >= MAX_EMAILS_PER_RUN) continue;
    const ids = ready.get(key) || [];
    if (ids.length < MAX_EVENTS_PER_EMAIL) ids.push(candidate.id);
    ready.set(key, ids);
  }
  if (staleIds.length) await db.prepare(`DELETE FROM birthday_email_deliveries
    WHERE id IN (SELECT value FROM json_each(?))
      AND (status = 'pending' OR (status = 'leased' AND lease_until <= ?))`)
    .bind(JSON.stringify(staleIds), nowIso).run();
  if (quietRows.length) {
    const changes = JSON.stringify(quietRows);
    await db.prepare(`UPDATE birthday_email_deliveries SET
      next_attempt_at = (SELECT json_extract(value, '$.nextAt') FROM json_each(?)
        WHERE CAST(json_extract(value, '$.id') AS INTEGER) = birthday_email_deliveries.id),
      status = 'pending', lease_until = NULL
      WHERE id IN (SELECT CAST(json_extract(value, '$.id') AS INTEGER) FROM json_each(?))
        AND (status = 'pending' OR (status = 'leased' AND lease_until <= ?))`)
      .bind(changes, changes, nowIso).run();
    result.quiet = quietRows.length;
  }
  const selectedIds = Array.from(ready.values()).flat();
  if (!selectedIds.length) return result;
  const leaseUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
  const claim = await db.prepare(`UPDATE birthday_email_deliveries
    SET status = 'leased', attempts = attempts + 1, lease_until = ?
    WHERE id IN (SELECT value FROM json_each(?))
      AND (status = 'pending' OR (status = 'leased' AND lease_until <= ?))
      AND next_attempt_at <= ?
      AND EXISTS (SELECT 1 FROM reminder_email_preferences p
        JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = p.user_id
        JOIN user u ON u.id = p.user_id
        JOIN workspaces w ON w.id = p.workspace_id
        JOIN contacts c ON c.id = birthday_email_deliveries.contact_id AND c.workspace_id = p.workspace_id
        LEFT JOIN contact_children child ON child.id = birthday_email_deliveries.child_id
          AND child.workspace_id = p.workspace_id AND child.contact_id = c.id
        WHERE p.workspace_id = birthday_email_deliveries.workspace_id
          AND p.user_id = birthday_email_deliveries.user_id AND p.enabled = 1
          AND u.email_verified = 1 AND w.lifecycle = 'active'
          AND (birthday_email_deliveries.child_id IS NULL AND c.birthday IS NOT NULL
            OR birthday_email_deliveries.child_id IS NOT NULL AND child.birthday IS NOT NULL AND child.linked_contact_id IS NULL))
    RETURNING id, attempts`)
    .bind(leaseUntil, JSON.stringify(selectedIds), nowIso, nowIso).all<Claimed>();
  const claimedRows = claim.results as Claimed[];
  if (!claimedRows.length) return result;
  const claimedIds = claimedRows.map((row) => row.id);
  const attemptsById = new Map(claimedRows.map((row) => [row.id, row.attempts]));
  const fresh = await db.prepare(`SELECT d.id, d.workspace_id, d.user_id, d.contact_id, d.child_id,
      d.occurrence, u.email, p.time_zone, p.quiet_start_hour, p.quiet_end_hour,
      child.linked_contact_id,
      CASE WHEN d.child_id IS NULL THEN c.birthday ELSE child.birthday END AS birthday,
      CASE WHEN d.child_id IS NULL THEN c.birthday_reminder_days ELSE ${CHILD_BIRTHDAY_LEAD_DAYS} END AS birthday_reminder_days
    FROM birthday_email_deliveries d
    JOIN reminder_email_preferences p ON p.workspace_id = d.workspace_id AND p.user_id = d.user_id
    JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id
    JOIN user u ON u.id = d.user_id
    JOIN workspaces w ON w.id = d.workspace_id
    JOIN contacts c ON c.id = d.contact_id AND c.workspace_id = d.workspace_id
    LEFT JOIN contact_children child ON child.id = d.child_id AND child.workspace_id = d.workspace_id AND child.contact_id = d.contact_id
    WHERE d.id IN (SELECT value FROM json_each(?)) AND d.status = 'leased' AND d.lease_until = ?
      AND p.enabled = 1 AND u.email_verified = 1 AND w.lifecycle = 'active'`)
    .bind(JSON.stringify(claimedIds), leaseUntil).all<DeliveryRow>();
  const groups = new Map<string, DeliveryRow[]>();
  const changed: number[] = [];
  const newlyQuiet: Array<{ id: number; nextAt: string }> = [];
  for (const row of fresh.results as DeliveryRow[]) {
    if (!birthdayStillDue(row, now)) { changed.push(row.id); continue; }
    if (isQuietHour(now, row.time_zone, row.quiet_start_hour, row.quiet_end_hour)) {
      newlyQuiet.push({ id: row.id, nextAt: nextAllowedEmailTime(now, row.time_zone,
        row.quiet_start_hour, row.quiet_end_hour) });
      continue;
    }
    const key = JSON.stringify([row.workspace_id, row.user_id]);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  if (changed.length) await db.prepare(`DELETE FROM birthday_email_deliveries
    WHERE id IN (SELECT value FROM json_each(?)) AND status = 'leased' AND lease_until = ?`)
    .bind(JSON.stringify(changed), leaseUntil).run();
  if (newlyQuiet.length) {
    const changes = JSON.stringify(newlyQuiet);
    await db.prepare(`UPDATE birthday_email_deliveries SET
      next_attempt_at = (SELECT json_extract(value, '$.nextAt') FROM json_each(?)
        WHERE CAST(json_extract(value, '$.id') AS INTEGER) = birthday_email_deliveries.id),
      status = 'pending', attempts = MAX(0, attempts - 1), lease_until = NULL
      WHERE id IN (SELECT CAST(json_extract(value, '$.id') AS INTEGER) FROM json_each(?))
        AND status = 'leased' AND lease_until = ?`)
      .bind(changes, changes, leaseUntil).run();
    result.quiet += newlyQuiet.length;
  }
  for (const group of groups.values()) {
    const ids = group.map((row) => row.id);
    const count = ids.length;
    let receipt: { messageId?: string };
    try {
      receipt = await sender.EMAIL!.send({
        to: group[0].email,
        from: sender.EMAIL_FROM!,
        subject: count === 1 ? 'A birthday alert is due' : 'Birthday alerts are due',
        text: `You have ${count} ${count === 1 ? 'birthday alert' : 'birthday alerts'} in Everclose CRM. Open ${env.BETTER_AUTH_URL}/calendar to review ${count === 1 ? 'it' : 'them'}.\n\nThis email does not contain contact names or private notes.`,
      });
    } catch {
      const retries = JSON.stringify(ids.map((id) => {
        const attempts = Number(attemptsById.get(id) || 1);
        const delay = Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** Math.max(0, attempts - 1));
        return { id, nextAt: new Date(now.getTime() + delay).toISOString() };
      }));
      await db.prepare(`UPDATE birthday_email_deliveries SET
        status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
        next_attempt_at = (SELECT json_extract(value, '$.nextAt') FROM json_each(?)
          WHERE CAST(json_extract(value, '$.id') AS INTEGER) = birthday_email_deliveries.id),
        lease_until = NULL
        WHERE id IN (SELECT CAST(json_extract(value, '$.id') AS INTEGER) FROM json_each(?))
          AND status = 'leased' AND lease_until = ?`)
        .bind(retries, retries, leaseUntil).run();
      result.failed++;
      continue;
    }
    await db.prepare(`UPDATE birthday_email_deliveries
      SET status = 'sent', sent_at = ?, lease_until = NULL, provider_message_id = ?
      WHERE id IN (SELECT value FROM json_each(?)) AND status = 'leased' AND lease_until = ?`)
      .bind(nowIso, receipt.messageId || null, JSON.stringify(ids), leaseUntil).run();
    result.sent++;
    result.eventsSent += count;
  }
  return result;
}
