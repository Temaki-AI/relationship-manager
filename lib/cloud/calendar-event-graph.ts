export function calendarEventGraphChecks() {
  return [
    ...['calendar_event_people', 'calendar_event_plans'].map((table) => `SELECT 1 FROM ${table} link LEFT JOIN calendar_events event ON event.id = link.event_id AND event.workspace_id = link.workspace_id WHERE link.workspace_id = ? AND event.id IS NULL LIMIT 1`),
    `SELECT 1 FROM calendar_event_plans link LEFT JOIN plans plan ON plan.id = link.plan_id AND plan.workspace_id = link.workspace_id WHERE link.workspace_id = ? AND plan.id IS NULL LIMIT 1`,
    ...['calendar_event_people', 'calendar_event_plans'].map((table) => `SELECT 1 FROM ${table} WHERE workspace_id = ? GROUP BY event_id HAVING COUNT(*) > 20 LIMIT 1`),
  ];
}
