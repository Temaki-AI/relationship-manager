import { normalizeTimeZone } from '@/lib/civil-date';

type DB = CloudflareEnv['DB'];
type EmailSender = {
  send(message: { to: string; from: string; subject: string; text: string }): Promise<{ messageId?: string }>;
};
type EmailEnv = CloudflareEnv & { EMAIL_DELIVERY_ENABLED?: string; EMAIL_FROM?: string; EMAIL?: EmailSender };

type Candidate = {
  id: number;
  workspace_id: string;
  user_id: string;
  time_zone: string;
  quiet_start_hour: number;
  quiet_end_hour: number;
};
type Claimed = { id: number; workspace_id: string; user_id: string; attempts: number };
type Recipient = Candidate & { email: string };

const MAX_EMAILS_PER_RUN = 8;
const MAX_EVENTS_PER_EMAIL = 20;
const CANDIDATE_LIMIT = 500;

export function emailDeliveryAvailable(env: CloudflareEnv): boolean {
  const email = env as EmailEnv;
  return email.EMAIL_DELIVERY_ENABLED === 'true'
    && typeof email.EMAIL?.send === 'function'
    && typeof email.EMAIL_FROM === 'string'
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.EMAIL_FROM);
}

function quietHourChecker(timeZone: string, start: number, end: number) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimeZone(timeZone), hour: 'numeric', hourCycle: 'h23',
  });
  return (at: Date) => {
    if (start === end) return false;
    const localHour = Number(formatter.formatToParts(at).find((part) => part.type === 'hour')?.value);
    return start < end ? localHour >= start && localHour < end : localHour >= start || localHour < end;
  };
}

export function isQuietHour(now: Date, timeZone: string, start: number, end: number): boolean {
  return quietHourChecker(timeZone, start, end)(now);
}

export function nextAllowedEmailTime(now: Date, timeZone: string, start: number, end: number): string {
  const interval = 15 * 60_000;
  const first = Math.ceil((now.getTime() + 1) / interval) * interval;
  const isQuiet = quietHourChecker(timeZone, start, end);
  for (let step = 0; step <= 108; step++) {
    const next = new Date(first + step * interval);
    if (!isQuiet(next)) return next.toISOString();
  }
  throw new Error('Quiet hours have no available time in the next 27 hours.');
}

export async function deliverReminderEmails(db: DB, env: CloudflareEnv, now = new Date()) {
  const result = { queued: 0, sent: 0, eventsSent: 0, failed: 0, quiet: 0 };
  if (!emailDeliveryAvailable(env)) return result;
  const email = env as EmailEnv;
  const nowIso = now.toISOString();
  // Snapshot the first bounded set of due events; the unique index makes Cron retries idempotent.
  const queued = await db.prepare(`INSERT OR IGNORE INTO reminder_email_deliveries
    (workspace_id, user_id, reminder_id, remind_at, next_attempt_at)
    SELECT p.workspace_id, p.user_id, r.id, r.remind_at, ?
    FROM reminder_email_preferences p
    JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = p.user_id
    JOIN user u ON u.id = p.user_id
    JOIN workspaces w ON w.id = p.workspace_id
    JOIN reminders r ON r.workspace_id = p.workspace_id
    WHERE p.enabled = 1 AND p.enabled_at IS NOT NULL AND u.email_verified = 1
      AND w.lifecycle = 'active' AND r.completed_at IS NULL
      AND r.remind_at >= p.enabled_at AND r.remind_at <= ?
      AND NOT EXISTS (SELECT 1 FROM reminder_email_deliveries existing
        WHERE existing.workspace_id = p.workspace_id AND existing.user_id = p.user_id
          AND existing.reminder_id = r.id AND existing.remind_at = r.remind_at)
    ORDER BY r.remind_at, r.id LIMIT ?`)
    .bind(nowIso, nowIso, CANDIDATE_LIMIT).run();
  result.queued = queued.meta.changes || 0;

  const candidates = await db.prepare(`SELECT d.id, d.workspace_id, d.user_id, p.time_zone, p.quiet_start_hour, p.quiet_end_hour
    FROM reminder_email_deliveries d
    JOIN reminder_email_preferences p ON p.workspace_id = d.workspace_id AND p.user_id = d.user_id
    JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id
    JOIN user u ON u.id = d.user_id
    JOIN workspaces w ON w.id = d.workspace_id
    JOIN reminders r ON r.id = d.reminder_id AND r.workspace_id = d.workspace_id
    WHERE ((d.status = 'pending') OR (d.status = 'leased' AND d.lease_until <= ?))
      AND d.next_attempt_at <= ? AND p.enabled = 1 AND p.enabled_at IS NOT NULL
      AND d.remind_at >= p.enabled_at AND u.email_verified = 1 AND w.lifecycle = 'active'
      AND r.completed_at IS NULL AND r.remind_at = d.remind_at
    ORDER BY d.next_attempt_at, d.id LIMIT ?`)
    .bind(nowIso, nowIso, CANDIDATE_LIMIT).all<Candidate>();

  const quietRows: Array<{ id: number; nextAt: string }> = [];
  const ready = new Map<string, number[]>();
  const quietTimes = new Map<string, string>();
  for (const candidate of candidates.results) {
    const groupKey = JSON.stringify([candidate.workspace_id, candidate.user_id]);
    if (isQuietHour(now, candidate.time_zone, candidate.quiet_start_hour, candidate.quiet_end_hour)) {
      const quietKey = JSON.stringify([candidate.time_zone, candidate.quiet_start_hour, candidate.quiet_end_hour]);
      let nextAt = quietTimes.get(quietKey);
      if (!nextAt) {
        nextAt = nextAllowedEmailTime(now, candidate.time_zone, candidate.quiet_start_hour, candidate.quiet_end_hour);
        quietTimes.set(quietKey, nextAt);
      }
      quietRows.push({ id: candidate.id, nextAt });
      continue;
    }
    if (!ready.has(groupKey) && ready.size >= MAX_EMAILS_PER_RUN) continue;
    const ids = ready.get(groupKey) || [];
    if (ids.length < MAX_EVENTS_PER_EMAIL) ids.push(candidate.id);
    ready.set(groupKey, ids);
  }
  if (quietRows.length) {
    const changes = JSON.stringify(quietRows);
    await db.prepare(`UPDATE reminder_email_deliveries SET
      next_attempt_at = (SELECT json_extract(value, '$.nextAt') FROM json_each(?)
        WHERE CAST(json_extract(value, '$.id') AS INTEGER) = reminder_email_deliveries.id),
      status = 'pending', lease_until = NULL
      WHERE id IN (SELECT CAST(json_extract(value, '$.id') AS INTEGER) FROM json_each(?))
        AND (status = 'pending' OR (status = 'leased' AND lease_until <= ?))`)
      .bind(changes, changes, nowIso).run();
    result.quiet = quietRows.length;
  }
  const selectedIds = Array.from(ready.values()).flat();
  if (!selectedIds.length) return result;
  const leaseUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
  const claimed = await db.prepare(`UPDATE reminder_email_deliveries SET status = 'leased', attempts = attempts + 1, lease_until = ?
      WHERE id IN (SELECT value FROM json_each(?))
        AND ((status = 'pending') OR (status = 'leased' AND lease_until <= ?))
        AND next_attempt_at <= ?
        AND EXISTS (SELECT 1 FROM reminder_email_preferences p JOIN user u ON u.id = p.user_id
          JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = p.user_id
          JOIN workspaces w ON w.id = p.workspace_id
          JOIN reminders r ON r.id = reminder_email_deliveries.reminder_id AND r.workspace_id = p.workspace_id
          WHERE p.workspace_id = reminder_email_deliveries.workspace_id AND p.user_id = reminder_email_deliveries.user_id
            AND p.enabled = 1 AND p.enabled_at <= reminder_email_deliveries.remind_at AND u.email_verified = 1
            AND w.lifecycle = 'active' AND r.completed_at IS NULL AND r.remind_at = reminder_email_deliveries.remind_at)
      RETURNING id, workspace_id, user_id, attempts`)
    .bind(leaseUntil, JSON.stringify(selectedIds), nowIso, nowIso).all<Claimed>();
  if (!claimed.results.length) return result;
  const claimedRows = claimed.results as Claimed[];
  const claimedIds = claimedRows.map((row) => row.id);
  const attemptsById = new Map(claimedRows.map((row) => [row.id, row.attempts]));
  const recipients = await db.prepare(`SELECT d.id, d.workspace_id, d.user_id, u.email,
      p.time_zone, p.quiet_start_hour, p.quiet_end_hour
    FROM reminder_email_deliveries d
    JOIN reminder_email_preferences p ON p.workspace_id = d.workspace_id AND p.user_id = d.user_id
    JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id
    JOIN user u ON u.id = d.user_id
    JOIN workspaces w ON w.id = d.workspace_id
    JOIN reminders r ON r.id = d.reminder_id AND r.workspace_id = d.workspace_id
    WHERE d.id IN (SELECT value FROM json_each(?)) AND d.status = 'leased' AND d.lease_until = ?
      AND p.enabled = 1 AND p.enabled_at <= d.remind_at AND u.email_verified = 1
      AND w.lifecycle = 'active' AND r.completed_at IS NULL AND r.remind_at = d.remind_at`)
    .bind(JSON.stringify(claimedIds), leaseUntil).all<Recipient>();
  const groups = new Map<string, Recipient[]>();
  const newlyQuiet: Array<{ id: number; nextAt: string }> = [];
  for (const recipient of recipients.results) {
    if (isQuietHour(now, recipient.time_zone, recipient.quiet_start_hour, recipient.quiet_end_hour)) {
      newlyQuiet.push({ id: recipient.id, nextAt: nextAllowedEmailTime(now, recipient.time_zone, recipient.quiet_start_hour, recipient.quiet_end_hour) });
      continue;
    }
    const key = JSON.stringify([recipient.workspace_id, recipient.user_id]);
    groups.set(key, [...(groups.get(key) || []), recipient]);
  }
  if (newlyQuiet.length) {
    const changes = JSON.stringify(newlyQuiet);
    await db.prepare(`UPDATE reminder_email_deliveries SET
      next_attempt_at = (SELECT json_extract(value, '$.nextAt') FROM json_each(?)
        WHERE CAST(json_extract(value, '$.id') AS INTEGER) = reminder_email_deliveries.id),
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
      receipt = await email.EMAIL!.send({
        to: group[0].email,
        from: email.EMAIL_FROM!,
        subject: count === 1 ? 'A relationship reminder is due' : 'Relationship reminders are due',
        text: `You have ${count} ${count === 1 ? 'reminder' : 'reminders'} due in Everclose CRM. Open ${env.BETTER_AUTH_URL}/reminders to review ${count === 1 ? 'it' : 'them'}.\n\nThis email does not contain contact names or private notes.`,
      });
    } catch {
      const retries = JSON.stringify(ids.map((id) => {
        const attempts = Number(attemptsById.get(id) || 1);
        const delay = Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** Math.max(0, attempts - 1));
        return { id, nextAt: new Date(now.getTime() + delay).toISOString() };
      }));
      await db.prepare(`UPDATE reminder_email_deliveries SET
        status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
        next_attempt_at = (SELECT json_extract(value, '$.nextAt') FROM json_each(?)
          WHERE CAST(json_extract(value, '$.id') AS INTEGER) = reminder_email_deliveries.id),
        lease_until = NULL
        WHERE id IN (SELECT CAST(json_extract(value, '$.id') AS INTEGER) FROM json_each(?))
          AND status = 'leased' AND lease_until = ?`)
        .bind(retries, retries, leaseUntil).run();
      result.failed++;
      continue;
    }
    await db.prepare(`UPDATE reminder_email_deliveries SET status = 'sent', sent_at = ?, lease_until = NULL, provider_message_id = ?
      WHERE id IN (SELECT value FROM json_each(?)) AND status = 'leased' AND lease_until = ?`)
      .bind(nowIso, receipt.messageId || null, JSON.stringify(ids), leaseUntil).run();
    result.sent++;
    result.eventsSent += count;
  }
  return result;
}
