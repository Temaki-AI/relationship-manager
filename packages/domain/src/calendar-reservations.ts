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

export type CalendarPublicationReview = {
  action: 'reconcile'; operation_id: string; receipt_id: string; plan_id: string;
  expected_epoch: string; expected_reservation_revision: number | null;
  expected_plan_fingerprint: string; observed_marker: string;
};
export function readCalendarPublicationReview(value: unknown): CalendarPublicationReview {
  const keys = ['action', 'operation_id', 'receipt_id', 'plan_id', 'expected_epoch', 'expected_reservation_revision', 'expected_plan_fingerprint', 'observed_marker'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Review the original Calendar event.');
  const b = value as Record<string, unknown>;
  if (Object.keys(b).length !== keys.length || Object.keys(b).some((key) => !keys.includes(key)) || b.action !== 'reconcile'
    || !isSyncUuid(b.operation_id) || !isSyncUuid(b.receipt_id) || !isSyncUuid(b.plan_id) || !isSyncUuid(b.expected_epoch)
    || b.operation_id === b.receipt_id || b.expected_reservation_revision !== null && (!Number.isSafeInteger(b.expected_reservation_revision) || Number(b.expected_reservation_revision) < 1)
    || typeof b.expected_plan_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(b.expected_plan_fingerprint)
    || b.observed_marker !== appleCalendarUrl(String(b.plan_id), String(b.receipt_id))) throw new Error('Review the original Calendar event.');
  return b as CalendarPublicationReview;
}
import { isSyncUuid } from './sync.ts';
import { appleCalendarUrl } from './apple-calendar.ts';
