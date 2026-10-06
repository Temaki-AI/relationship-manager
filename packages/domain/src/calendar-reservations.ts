export type PublicationPlan = {
  public_id: string; contact_public_id: string; type: string; planned_date: string;
  summary: string | null; notes: string | null; completed_at: string | null;
};

// Scalar keys use the server fingerprint's canonical order, also on native clients.
export function publicationPlanSnapshot(plan: PublicationPlan) {
  return {
    completed_at: plan.completed_at, contact_public_id: plan.contact_public_id,
    notes: plan.notes, planned_date: plan.planned_date, public_id: plan.public_id,
    summary: plan.summary, type: plan.type,
  };
}

export type CalendarReservation = {
  id: string; plan_id: string; provider: 'google-calendar' | 'apple-calendar';
  status: 'reserved' | 'attempted' | 'saved' | 'cancelled' | 'held';
  attempted: boolean; revision: number; epoch: string; on_this_phone: boolean; plan_fingerprint: string | null;
};
