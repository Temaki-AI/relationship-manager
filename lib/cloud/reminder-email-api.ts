import { getCloudflareContext } from '@opennextjs/cloudflare';
import { normalizeTimeZone } from '@/lib/civil-date';
import { readCloudObject } from '@/lib/cloud/request';
import { RequestBodyError } from '@/lib/request-body';
import { emailDeliveryAvailable } from '@/lib/cloud/reminder-email-delivery';

type Preference = {
  enabled: number;
  enabled_at: string | null;
  time_zone: string;
  quiet_start_hour: number;
  quiet_end_hour: number;
};

const defaults: Preference = { enabled: 0, enabled_at: null, time_zone: 'UTC', quiet_start_hour: 22, quiet_end_hour: 8 };

export async function handleReminderEmailPreferences(request: Request, workspaceId: string, userId: string) {
  const env = getCloudflareContext().env;
  const db = env.DB;
  if (request.method !== 'GET' && request.method !== 'PATCH') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  }
  const user = await db.prepare('SELECT email, email_verified FROM user WHERE id = ?')
    .bind(userId).first<{ email: string; email_verified: number }>();
  if (!user) return Response.json({ error: 'Account not found.' }, { status: 404 });
  const available = emailDeliveryAvailable(env) && Boolean(user.email_verified);
  if (request.method === 'PATCH') {
    try {
      const body = await readCloudObject(request);
      const timeZone = body.timeZone;
      const start = body.quietStartHour;
      const end = body.quietEndHour;
      if (typeof body.enabled !== 'boolean'
        || typeof timeZone !== 'string' || normalizeTimeZone(timeZone) !== timeZone
        || !Number.isInteger(start) || Number(start) < 0 || Number(start) > 23
        || !Number.isInteger(end) || Number(end) < 0 || Number(end) > 23) {
        return Response.json({ error: 'Choose a valid timezone and quiet hours.' }, { status: 400 });
      }
      if (body.enabled && !available) {
        return Response.json({ error: user.email_verified
          ? 'Email alerts are not available yet.'
          : 'Verify your account email before enabling alerts.' }, { status: 503 });
      }
      const now = new Date().toISOString();
      await db.prepare(`INSERT INTO reminder_email_preferences
        (workspace_id, user_id, enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, user_id) DO UPDATE SET
          enabled = excluded.enabled,
          enabled_at = CASE WHEN excluded.enabled = 0 THEN NULL
            WHEN reminder_email_preferences.enabled = 1 THEN reminder_email_preferences.enabled_at
            ELSE excluded.enabled_at END,
          time_zone = excluded.time_zone,
          quiet_start_hour = excluded.quiet_start_hour,
          quiet_end_hour = excluded.quiet_end_hour,
          updated_at = excluded.updated_at`)
        .bind(workspaceId, userId, Number(body.enabled), body.enabled ? now : null, timeZone, start, end, now).run();
    } catch (error) {
      if (error instanceof RequestBodyError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }
  const preference = await db.prepare(`SELECT enabled, enabled_at, time_zone, quiet_start_hour, quiet_end_hour
    FROM reminder_email_preferences WHERE workspace_id = ? AND user_id = ?`)
    .bind(workspaceId, userId).first<Preference>() || defaults;
  const delivery = await db.prepare(`SELECT COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
    MAX(sent_at) AS last_sent_at FROM reminder_email_deliveries WHERE workspace_id = ? AND user_id = ?`)
    .bind(workspaceId, userId).first<{ failed_count: number; last_sent_at: string | null }>();
  const birthdays = await db.prepare(`SELECT COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
    MAX(sent_at) AS last_sent_at FROM birthday_email_deliveries WHERE workspace_id = ? AND user_id = ?`)
    .bind(workspaceId, userId).first<{ failed_count: number; last_sent_at: string | null }>();
  return Response.json({
    available,
    verifiedEmail: Boolean(user.email_verified),
    enabled: Boolean(preference.enabled),
    timeZone: preference.time_zone,
    quietStartHour: preference.quiet_start_hour,
    quietEndHour: preference.quiet_end_hour,
    failedCount: (delivery?.failed_count || 0) + (birthdays?.failed_count || 0),
    lastSentAt: [delivery?.last_sent_at, birthdays?.last_sent_at].filter((value): value is string => Boolean(value)).sort().at(-1) || null,
  });
}
