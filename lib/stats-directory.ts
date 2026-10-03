import { birthdayMatchesDaySQL, dateInTimeZone, normalizeTimeZone } from './civil-date.ts';

export const MAX_STATS_BIRTHDAYS = 100;

export function statsToday(request: Request): string {
  return dateInTimeZone(new Date(), normalizeTimeZone(new URL(request.url).searchParams.get('timeZone')))!;
}

export function birthdayStatsSQL(workspaceScoped: boolean): string {
  const workspaceClause = workspaceScoped ? 'AND c.workspace_id = ?' : '';
  return `WITH RECURSIVE days(day, days_until) AS (
    SELECT date(?), 0
    UNION ALL SELECT date(day, '+1 day'), days_until + 1 FROM days WHERE days_until < 30
  )
  SELECT c.id, c.name, c.birthday, days.days_until AS daysUntil, COUNT(*) OVER () AS total
  FROM days JOIN contacts c ON c.birthday IS NOT NULL AND ${birthdayMatchesDaySQL('c.birthday', 'days.day')}
  WHERE 1 = 1 ${workspaceClause}
  ORDER BY days.days_until, c.name COLLATE NOCASE, c.id
  LIMIT ${MAX_STATS_BIRTHDAYS}`;
}

export function checkInStatsSQL(workspaceScoped: boolean, list: boolean): string {
  const workspaceClause = workspaceScoped ? 'AND workspace_id = ?' : '';
  const common = `WITH rhythms AS (
    SELECT id, CAST(julianday(?) - julianday(date(last_contacted)) AS INTEGER) AS days_since,
      CASE WHEN contact_frequency > 0 THEN contact_frequency ELSE 14 END AS cadence
    FROM contacts WHERE last_contacted IS NOT NULL ${workspaceClause}
  )`;
  return list
    ? `${common} SELECT id FROM rhythms WHERE days_since >= cadence ORDER BY days_since - cadence DESC, id LIMIT 5`
    : `${common} SELECT COUNT(*) FILTER (WHERE days_since >= cadence) AS ready,
      COUNT(*) FILTER (WHERE days_since > cadence * 2) AS neglected FROM rhythms`;
}

export function statsResponse(
  totalContacts: number,
  conversationsThisWeek: number,
  rhythms: { ready: number; neglected: number } | null,
  actionItems: Array<{ id: number }>,
  birthdays: Array<{ id: number; name: string; birthday: string; daysUntil: number; total: number }>,
) {
  const upcomingBirthdaysCount = Number(birthdays[0]?.total || 0);
  return {
    stats: {
      totalContacts,
      conversationsThisWeek,
      readyToReconnectCount: Number(rhythms?.ready || 0),
      neglectedCount: Number(rhythms?.neglected || 0),
      upcomingBirthdaysCount,
    },
    actionItems: actionItems.map((item) => item.id),
    upcomingBirthdays: birthdays.map(({ id, name, birthday, daysUntil }) => ({ id, name, birthday, daysUntil })),
    upcomingBirthdaysTruncated: upcomingBirthdaysCount > birthdays.length,
  };
}
