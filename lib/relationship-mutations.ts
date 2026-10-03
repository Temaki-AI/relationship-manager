import type Database from 'better-sqlite3';

type InteractionInput = {
  contactId: number;
  date: string;
  type: string;
  summary: string | null;
  notes: string | null;
};

type InteractionRow = {
  id: number;
  contact_id: number;
  date: string;
  type: string;
  summary: string | null;
  notes: string | null;
  created_at: string;
};

type PlanRow = {
  id: number;
  contact_id: number;
  type: string;
  planned_date: string;
  summary: string | null;
  notes: string | null;
  completed_at: string | null;
  created_at: string;
};

type ReminderRow = {
  id: number;
  contact_id: number;
  title: string;
  notes: string | null;
  remind_at: string;
  completed_at: string | null;
  created_at: string;
};

type ReminderCompletionResult = {
  status: 'completed' | 'already-completed' | 'not-found';
  reminder: ReminderRow | null;
};

export function recalculateLastContacted(db: Database.Database, contactId: number) {
  const row = db.prepare(
    'SELECT MAX(date) as max_date FROM interactions WHERE contact_id = ?'
  ).get(contactId) as { max_date: string | null };

  db.prepare(
    'UPDATE contacts SET last_contacted = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(row.max_date, contactId);
}

export function createInteractionRecord(
  db: Database.Database,
  input: InteractionInput
): InteractionRow {
  return db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO interactions (contact_id, date, type, summary, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.contactId, input.date, input.type, input.summary, input.notes);

    recalculateLastContacted(db, input.contactId);
    return db.prepare('SELECT * FROM interactions WHERE id = ?')
      .get(result.lastInsertRowid) as InteractionRow;
  })();
}

export function deleteInteractionRecord(
  db: Database.Database,
  interactionId: number
): boolean {
  return db.transaction(() => {
    const existing = db.prepare('SELECT contact_id FROM interactions WHERE id = ?')
      .get(interactionId) as { contact_id: number } | undefined;
    if (!existing) return false;

    db.prepare('DELETE FROM interactions WHERE id = ?').run(interactionId);
    recalculateLastContacted(db, existing.contact_id);
    return true;
  })();
}

export function completeReminderRecord(
  db: Database.Database,
  reminderId: number,
  completedAt = new Date().toISOString()
): ReminderCompletionResult {
  return db.transaction((): ReminderCompletionResult => {
    const reminder = db.prepare(`
      UPDATE reminders
      SET completed_at = ?
      WHERE id = ? AND completed_at IS NULL
      RETURNING *
    `).get(completedAt, reminderId) as ReminderRow | undefined;
    if (reminder) return { status: 'completed', reminder };

    const existing = db.prepare('SELECT * FROM reminders WHERE id = ?')
      .get(reminderId) as ReminderRow | undefined;
    return {
      status: existing ? 'already-completed' : 'not-found',
      reminder: existing || null,
    };
  })();
}

export function completePlanRecord(
  db: Database.Database,
  planId: number,
  completedAt = new Date().toISOString()
): { status: 'completed' | 'already-completed' | 'not-found'; plan: PlanRow | null } {
  return db.transaction(() => {
    const plan = db.prepare(`
      UPDATE plans
      SET completed_at = ?
      WHERE id = ? AND completed_at IS NULL
      RETURNING *
    `).get(completedAt, planId) as PlanRow | undefined;

    if (!plan) {
      const existing = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as PlanRow | undefined;
      return {
        status: existing ? 'already-completed' as const : 'not-found' as const,
        plan: existing || null,
      };
    }

    const interactionDate = completedAt.slice(0, 10);
    db.prepare(`
      INSERT INTO interactions (contact_id, date, type, summary, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(plan.contact_id, interactionDate, plan.type, plan.summary, plan.notes);
    recalculateLastContacted(db, plan.contact_id);

    return { status: 'completed' as const, plan };
  })();
}
