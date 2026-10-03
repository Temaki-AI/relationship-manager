import { getCloudflareContext } from '@opennextjs/cloudflare';
import { buildIntelligenceOverviewFromActivity, type ContactActivitySummary, type IntelligenceContact, type IntelligenceInteraction, type IntelligenceReminder } from '@/lib/intelligence';
import { dateInTimeZone, normalizeTimeZone } from '@/lib/civil-date';

export async function cloudIntelligenceOverview(workspaceId: string, request: Request) {
  const db = getCloudflareContext().env.DB;
  const now = new Date();
  const timeZone = normalizeTimeZone(new URL(request.url).searchParams.get('timeZone'));
  const today = dateInTimeZone(now, timeZone)!;
  // Project only signal fields: photos, long notes, and entire histories are not
  // needed to rank the daily list. All reads share one consistent D1 transaction.
  const data = await db.batch([
    db.prepare(`SELECT id, name, email, phone, birthday, birthday_reminder_days, tags, last_contacted, contact_frequency, created_at, updated_at,
      CASE WHEN json_valid(custom_fields) THEN json_object(
        'company', json_extract(custom_fields, '$.company'), 'location', json_extract(custom_fields, '$.location'),
        'linkedin', json_object('company', json_extract(custom_fields, '$.linkedin.company'), 'location', json_extract(custom_fields, '$.linkedin.location'), 'imported_at', json_extract(custom_fields, '$.linkedin.imported_at')))
        ELSE NULL END AS custom_fields FROM contacts WHERE workspace_id = ? ORDER BY id`).bind(workspaceId),
    db.prepare(`WITH ranked AS (SELECT id, contact_id, date, type, summary,
      COUNT(*) OVER (PARTITION BY contact_id) AS interactions_count,
      ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY date DESC, id DESC) AS rank
      FROM interactions WHERE workspace_id = ?)
      SELECT id, contact_id, date, type, summary, interactions_count FROM ranked WHERE rank = 1`).bind(workspaceId),
    db.prepare(`WITH ranked AS (
        SELECT r.id, r.contact_id, r.title, r.remind_at, r.completed_at,
          ROW_NUMBER() OVER (PARTITION BY r.contact_id ORDER BY julianday(r.remind_at), r.id) AS contact_rank
        FROM reminders r
        WHERE r.workspace_id = ? AND r.completed_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM daily_snoozes s
          WHERE s.workspace_id = r.workspace_id AND s.id = 'reminder-' || r.id AND s.until_date > ?
        )
      ) SELECT id, contact_id, title, remind_at, completed_at FROM ranked
      WHERE contact_rank = 1 ORDER BY julianday(remind_at), id LIMIT 4`).bind(workspaceId, today),
    db.prepare('SELECT COUNT(*) AS count FROM reminders WHERE workspace_id = ? AND completed_at IS NULL').bind(workspaceId),
    db.prepare('SELECT id, name, plan, persona FROM workspaces WHERE id = ?').bind(workspaceId),
    db.prepare(`SELECT s.id, s.contact_id, s.reminder_id, s.until_date,
      c.name AS contact_name, r.title AS reminder_title
      FROM daily_snoozes s JOIN contacts c ON c.id = s.contact_id AND c.workspace_id = s.workspace_id
      LEFT JOIN reminders r ON r.id = s.reminder_id AND r.workspace_id = s.workspace_id
      WHERE s.workspace_id = ? AND s.until_date > ? AND (s.reminder_id IS NULL OR r.completed_at IS NULL)
      ORDER BY s.until_date, s.id`).bind(workspaceId, today),
  ]);
  const activity = new Map<number, ContactActivitySummary>();
  for (const row of data[1].results as Array<IntelligenceInteraction & { interactions_count: number }>) {
    activity.set(row.contact_id, { contactId: row.contact_id, interactionsCount: row.interactions_count, latestInteraction: row, openReminders: [] });
  }
  return {
    workspace: data[4].results[0],
    ...buildIntelligenceOverviewFromActivity(data[0].results as IntelligenceContact[], activity, data[2].results as IntelligenceReminder[], Number((data[3].results[0] as { count: number }).count), now, timeZone, data[5].results as import('@/lib/today-snooze').TodaySnooze[]),
  };
}
