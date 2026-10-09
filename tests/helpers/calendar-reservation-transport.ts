import assert from 'node:assert/strict';
import type { CalendarReservation } from '../../packages/domain/src/calendar-reservations.ts';

// Unit-test transport only. Cross-layer tests use the actual authenticated D1
// handler, including ownership, competing claims and recovery fences.
export function calendarReservationTransport() {
  const rows = new Map<string, CalendarReservation>(), responses = new Map<string, CalendarReservation>();
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(new URL(String(url)).pathname, '/api/v1/calendar-reservations');
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    const text = String(init?.body); requests.push(text);
    const b = JSON.parse(text) as { action: string; operation_id: string; plan_id: string; expected_epoch: string;
      expected_revision: number | null; expected_plan_fingerprint: string; result_action?: string };
    let row = responses.get(text);
    if (!row) {
      const old = rows.get(b.operation_id);
      if (b.action === 'reserve') {
        if (old) return Response.json({ error: 'Changed reservation' }, { status: 409 });
        row = { id: b.operation_id, plan_id: b.plan_id, epoch: b.expected_epoch, provider: 'apple-calendar',
          revision: 1, status: 'reserved', attempted: false, on_this_phone: true, plan_fingerprint: b.expected_plan_fingerprint };
      } else {
        assert.ok(old); assert.equal(old.revision, b.expected_revision);
        row = { ...old, revision: old.revision + 1, attempted: b.action === 'attempt' || old.attempted,
          status: b.action === 'attempt' ? 'attempted' : b.action === 'release' || b.result_action === 'canceled' ? 'cancelled' : 'saved' };
      }
      rows.set(row.id, row); responses.set(text, row);
    }
    return Response.json({ version: 1, epoch: b.expected_epoch, reservation: row });
  };
  return { fetcher, requests, rows };
}
