import { getCloudflareContext } from '@opennextjs/cloudflare';
import { dateInTimeZone, normalizeTimeZone } from '@/lib/civil-date';
import { readCloudObject } from '@/lib/cloud/request';
import { recoveryErrorResponse } from '@/lib/cloud/recovery-contract';
import { RequestBodyError } from '@/lib/request-body';
import { MAX_ACTIVE_TODAY_SNOOZES, parseTodaySnoozeTarget, parseTodaySnoozeUntil } from '@/lib/today-snooze';

export async function handleCloudTodaySnooze(request: Request, workspaceId: string): Promise<Response> {
  const { DB } = getCloudflareContext().env;
  try {
    if (request.method !== 'PUT' && request.method !== 'DELETE') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    const body = await readCloudObject(request);
    const target = parseTodaySnoozeTarget(body.id);
    if (!target) return Response.json({ error: 'Choose a valid prompt.' }, { status: 400 });
    if (request.method === 'DELETE') {
      await DB.prepare('DELETE FROM daily_snoozes WHERE workspace_id = ? AND id = ?').bind(workspaceId, body.id).run();
      return Response.json({ success: true });
    }
    const timeZone = normalizeTimeZone(body.timeZone);
    const now = new Date();
    const until = parseTodaySnoozeUntil(body.until, now, timeZone);
    if (!until) return Response.json({ error: 'Choose a date within the next 30 days.' }, { status: 400 });
    const source = target.kind === 'reminder'
      ? await DB.prepare('SELECT contact_id, id AS reminder_id FROM reminders WHERE workspace_id = ? AND id = ? AND completed_at IS NULL')
        .bind(workspaceId, target.id).first<{ contact_id: number; reminder_id: number }>()
      : await DB.prepare(`SELECT id AS contact_id, NULL AS reminder_id FROM contacts WHERE workspace_id = ? AND id = ? ${target.kind === 'birthday' ? 'AND birthday IS NOT NULL' : ''}`)
        .bind(workspaceId, target.id).first<{ contact_id: number; reminder_id: null }>();
    if (!source) return Response.json({ error: 'This prompt is no longer available.' }, { status: 404 });
    const timestamp = now.toISOString();
    const saved = await DB.prepare(`INSERT INTO daily_snoozes
      (id, workspace_id, contact_id, reminder_id, until_date, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE
        EXISTS (SELECT 1 FROM daily_snoozes WHERE workspace_id = ? AND id = ?)
        OR (SELECT COUNT(*) FROM daily_snoozes WHERE workspace_id = ? AND until_date > ?) < ?
      ON CONFLICT(workspace_id, id) DO UPDATE SET until_date = excluded.until_date, updated_at = excluded.updated_at
      RETURNING id, contact_id, reminder_id, until_date`)
      .bind(body.id, workspaceId, source.contact_id, source.reminder_id, until, timestamp, timestamp,
        workspaceId, body.id, workspaceId, dateInTimeZone(now, timeZone)!, MAX_ACTIVE_TODAY_SNOOZES)
      .first();
    if (!saved) return Response.json({ error: 'Too many snoozed prompts. Bring one back before snoozing another.' }, { status: 409 });
    return Response.json({ snooze: saved });
  } catch (error) {
    const recoveryError = recoveryErrorResponse(error);
    if (recoveryError) return recoveryError;
    if (error instanceof RequestBodyError) return Response.json({ error: error.message }, { status: error.status });
    console.error('cloud.today.snooze_failed', error);
    return Response.json({ error: 'Could not save the snooze.' }, { status: 500 });
  }
}
