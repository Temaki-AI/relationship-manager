'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { publicationDraft, type PublicationDraft } from '@/packages/domain/src/calendar-publication';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { getResponseErrorMessage } from '@/lib/utils';
import type { reviewPlanPublication } from '@/lib/cloud/calendar-plan-publications';
type Review = Awaited<ReturnType<typeof reviewPlanPublication>>;
type Preparation = { operation_id: string; expected_preview_fingerprint: string; draft: PublicationDraft };
const inputClass = 'min-h-11 w-full min-w-0 rounded-md border bg-background px-3';
function initialDraft(review: Review): PublicationDraft | null {
  if (review.remote_draft) return { ...review.remote_draft, follow_plan_date: Boolean(review.publication?.follow_plan_date) };
  if (review.publication?.confirmed_at && review.write) return { ...review.write.draft, follow_plan_date: Boolean(review.publication.follow_plan_date) };
  if (!review.plan) return null;
  const day = review.plan.planned_date, end = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
  return { summary: `${review.plan.type} with ${review.plan.contact_name}`, location: '', visibility: 'private',
    start: { date: day, date_time: null, time_zone: null }, end: { date: end, date_time: null, time_zone: null }, attendee_emails: [], follow_plan_date: false };
}
function eventTime(draft: PublicationDraft) {
  return draft.start.date ? `${draft.start.date} through ${draft.end.date} (end date excluded)` : `${draft.start.date_time} — ${draft.end.date_time} · ${draft.start.time_zone}`;
}
export function GooglePlanPublication({ connectionId, planId }: { connectionId: string; planId: string }) {
  const endpoint = `/api/connections/${connectionId}/plan-publications/${planId}`, storageKey = `everclose-plan-publication:${connectionId}:${planId}`;
  const seeded = useRef(false);
  const [review, setReview] = useState<Review | null>(null), [draft, setDraft] = useState<PublicationDraft | null>(null), [emails, setEmails] = useState('');
  const [retained, setRetained] = useState<Preparation | null>(null), [confirmation, setConfirmation] = useState<'prepare' | 'send' | 'discard' | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const readStored = useCallback((): Preparation | null => {
    const raw = sessionStorage.getItem(storageKey); if (!raw) return null;
    try { const value = JSON.parse(raw) as Preparation;
      if (Object.keys(value).length === 3 && isSyncUuid(value.operation_id) && /^[0-9a-f]{64}$/u.test(value.expected_preview_fingerprint)) { publicationDraft(value.draft); return value; }
    } catch { /* Never send unreadable browser storage. */ }
    throw new Error('The retained publication review could not be read. Keep this tab and review server status before continuing.');
  }, [storageKey]);
  const refresh = useCallback(async (resetDraft = false) => {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not review this plan publication.'));
    const data = await response.json() as Review, stored = readStored(); setReview(data);
    if (stored && data.write?.id === stored.operation_id) { sessionStorage.removeItem(storageKey); setRetained(null); }
    else setRetained(stored);
    const next = stored && data.write?.id !== stored.operation_id ? stored.draft
      : data.write && ['pending', 'unknown'].includes(data.write.status) ? data.write.draft : initialDraft(data);
    if (next && (!seeded.current || resetDraft || stored || data.write && ['pending', 'unknown'].includes(data.write.status))) { seeded.current = true; setEmails(next.attendee_emails.join(', ')); setDraft(next); }
    return data;
  }, [endpoint, readStored, storageKey]);
  useEffect(() => { refresh().catch((err) => setError(err.message)); }, [refresh]);
  async function run(action: () => Promise<void>) {
    setPending(true); setError(null); setNotice(null);
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : 'This request is unconfirmed. Refresh its status.'); }
    finally { setPending(false); setConfirmation(null); }
  }
  async function prepare(body: Preparation) {
    await run(async () => {
      // Persist the exact request before sending, so a lost reply cannot silently start a new review.
      sessionStorage.setItem(storageKey, JSON.stringify(body)); setRetained(body);
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) { if ([400, 403, 404].includes(response.status)) { sessionStorage.removeItem(storageKey); setRetained(null); } throw new Error(await getResponseErrorMessage(response, 'The review save is unconfirmed. Retry this same review.')); }
      await refresh(); setNotice('Review saved. Confirm publishing to send it to Google.');
    });
  }
  async function step(mode: 'send' | 'verify') {
    const data = review; if (!data?.write) return;
    await run(async () => {
      let response: Response;
      try { response = await fetch(endpoint + '/step', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation_id: data.write!.id,
        expected_revision: data.write!.revision, expected_epoch: data.epoch, expected_authorization_revision: data.authorization_revision, expected_plan_fingerprint: data.plan_fingerprint, mode }) }); } catch { await refresh(); throw new Error('The Google reply is unconfirmed. Verify the original event before retrying.'); }
      if (!response.ok) { const message = await getResponseErrorMessage(response, 'The Google reply is unconfirmed. Refresh and verify the original event.'); await refresh(); throw new Error(message); }
      const current = await refresh(true);
      setNotice(current.publication?.status === 'missing' ? 'The original event is unavailable. It will not be recreated.' : current.write?.status === 'confirmed' && current.publication?.status === 'published' ? 'Original Google event status verified. Your CRM history is preserved.' : 'This publication is still unconfirmed. Verify the original event before changing the review.');
    });
  }
  async function discard() {
    if (!review?.write) return;
    await run(async () => {
      const response = await fetch(endpoint, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation_id: review.write!.id, expected_revision: review.write!.revision }) });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'The review could not be discarded.'));
      await refresh(true); setNotice('Unsent review discarded. The original event identity is retained.');
    });
  }
  const write = review?.write, locked = pending || Boolean(retained) || Boolean(write && ['pending', 'unknown'].includes(write.status));
  const canSend = !retained && write && write.can_send && ['pending', 'unknown'].includes(write.status) && !review?.plan?.completed && Boolean(review?.can_prepare && review?.preview_fingerprint);
  const checkedDraft = () => publicationDraft({ ...draft, attendee_emails: emails.split(/[\s,;]+/u).filter(Boolean) }).draft;
  function reviewDraft() { try { const next = checkedDraft(); setDraft(next); setConfirmation('prepare'); setError(null); } catch (err) { setError((err as Error).message); } }
  const display = confirmation === 'send' ? write?.draft : draft;
  const oldGuests = review?.remote_draft?.attendee_emails ?? [], guests = display?.attendee_emails ?? [], removed = oldGuests.filter((email) => !guests.includes(email));
  const invitations = guests.length > 0 || oldGuests.length > 0;
  return <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6 pb-28">
    <Link className="inline-flex min-h-11 items-center underline" href={`/connections/google/${connectionId}/plans`}>Back to plans</Link>
    <h1 className="text-2xl font-semibold">Publish a plan to Google Calendar</h1>
    <p>Review an event in your dedicated Everclose calendar. Private CRM notes stay in Everclose.</p>
    {error && <p role="alert" className="break-words rounded-lg border border-red-200 p-3 text-red-700">{error}</p>}
    {notice && <p role="status" className="rounded-lg border p-3">{notice}</p>}
    <Button variant="outline" disabled={pending} onClick={() => run(async () => { await refresh(); })}>Refresh publication status</Button>
    {review && <p className="break-words">Account: {review.email} · Calendar: {review.calendar?.summary ?? 'Access needs review'}</p>}
    {review?.plan ? <p className="break-words">Plan for <Link className="underline" href={`/contacts/${review.plan.contact_id}`}>{review.plan.contact_name}</Link> · {review.plan.planned_date}{review.plan.completed ? ' · completed' : ''}</p> : review && <p>The original plan has been removed. Its publication receipt is retained for verification.</p>}
    {review?.problem && <p className="break-words">{review.problem === 'missing' ? 'The known event was not found. It will not be recreated.' : review.problem === 'event_not_editable' ? 'This event is cancelled, recurring or has guest details that cannot be safely edited here.' : review.problem} <Link className="underline" href={`/connections/google/${connectionId}/publish`}>Review calendar access</Link></p>}
    {retained && <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">Review save is unconfirmed</h2><p>Keep this exact draft until the save is confirmed. Retrying sends the same review.</p><Button disabled={pending} onClick={() => prepare(retained)}>Retry review save</Button></section>}
    {write && <section className="space-y-3 rounded-xl border p-4">
      <h2 className="font-semibold">{write.status === 'confirmed' && review?.publication?.status === 'published' && !review.problem ? 'Published event verified' : 'Retained publication review'}</h2>
      <p>Publication: {review?.publication?.status ?? 'pending'}</p>
      <p>Status: {write.status} · {write.attempts} sending attempt{write.attempts === 1 ? '' : 's'}</p>
      <p className="break-words">{write.draft.summary} · {eventTime(write.draft)}</p>
      {write.issue && <p>Review required: {write.issue.replaceAll('_', ' ')}.</p>}
      <div className="flex flex-wrap gap-3">
        {canSend && <Button disabled={pending} onClick={() => setConfirmation('send')}>{write.attempts ? 'Review exact retry' : 'Review publishing'}</Button>}
        <Button variant="outline" disabled={pending || Boolean(retained)} onClick={() => step('verify')}>Verify original event</Button>
        {!write.attempts && ['pending', 'unknown', 'held', 'conflict'].includes(write.status) && <Button variant="outline" disabled={pending || Boolean(retained)} onClick={() => setConfirmation('discard')}>Discard unsent review</Button>}
        {review?.saved_event_id && <Link className="inline-flex min-h-11 items-center underline" href={`/calendar/events/${review.saved_event_id}`}>Saved event context</Link>}
      </div>
      {write.attempts > 0 && write.status !== 'confirmed' && <p className="text-sm">An uncertain reply keeps the original event identity. Verification reads that event; a retry checks it before sending the same review.</p>}
    </section>}
    {draft && <section className="space-y-4 rounded-xl border p-4"><h2 className="text-lg font-semibold">Event details</h2>
      {review?.publication?.confirmed_at && !review.remote_draft && <p className="text-sm">Google details could not be refreshed. These fields show the last retained review.</p>}
      <fieldset disabled={locked || !review?.can_prepare} className="space-y-4">
        <label className="block space-y-1"><span>Event title</span><input className={inputClass} maxLength={500} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} /></label>
        <label className="block space-y-1"><span>Location</span><input className={inputClass} maxLength={500} value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} /></label>
        <label className="block space-y-1"><span>Visibility</span><select className={inputClass} value={draft.visibility} onChange={(e) => setDraft({ ...draft, visibility: e.target.value as PublicationDraft['visibility'] })}><option value="private">Private</option><option value="default">Calendar default</option><option value="public">Public</option><option value="confidential">Confidential</option></select></label>
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={Boolean(draft.start.date)} onChange={(e) => {
          const day = draft.start.date ?? draft.start.date_time!.slice(0, 10), end = draft.end.date ?? draft.end.date_time!.slice(0, 10), zone = review?.calendar?.time_zone ?? 'Europe/Lisbon';
          setDraft({ ...draft, start: e.target.checked ? { date: day, date_time: null, time_zone: null } : { date: null, date_time: `${day}T10:00:00`, time_zone: zone },
            end: e.target.checked ? { date: end > day ? end : new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10), date_time: null, time_zone: null } : { date: null, date_time: `${end}T11:00:00`, time_zone: zone } });
        }} />All-day event</label>
        {(['start', 'end'] as const).map((key) => <label key={key} className="block space-y-1"><span>{key === 'start' ? 'Start' : draft.start.date ? 'End date (excluded)' : 'End'}</span><input className={inputClass} type={draft.start.date ? 'date' : 'text'} value={draft[key].date ?? draft[key].date_time ?? ''} placeholder="2026-10-20T10:00:00" onChange={(e) => setDraft({ ...draft, [key]: { ...draft[key], ...(draft.start.date ? { date: e.target.value } : { date_time: e.target.value }) } })} /></label>)}
        {!draft.start.date && <><label className="block space-y-1"><span>Timezone</span><input className={inputClass} value={draft.start.time_zone ?? ''} onChange={(e) => setDraft({ ...draft, start: { ...draft.start, time_zone: e.target.value }, end: { ...draft.end, time_zone: e.target.value } })} placeholder="Europe/Lisbon" /></label><p className="text-sm">Use YYYY-MM-DDTHH:MM:SS. When clocks go back, include the UTC offset, such as +01:00, to choose which occurrence.</p></>}
        <label className="block space-y-1"><span>Invitee emails</span><textarea className={inputClass + ' py-3'} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="ana@example.com, friend@example.com" /></label>
        <p className="text-sm">Choose up to 20 guests. Publishing with guests sends Google invitations or update notices.</p>
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={draft.follow_plan_date} onChange={(e) => setDraft({ ...draft, follow_plan_date: e.target.checked })} />Let this event update the plan date</label>
        <p className="text-sm">This changes only the date of this plan when the source is verified. A manual date change suspends following. Notes and completion history are preserved.</p>
        <Button onClick={reviewDraft}>Review event details</Button>
      </fieldset>
    </section>}
    <ConfirmDialog open={confirmation !== null} title={confirmation === 'discard' ? 'Discard this unsent review?' : confirmation === 'prepare' ? 'Save these event details?' : 'Publish this event to Google?'}
      description={confirmation === 'discard' ? 'Discard a local review that has not been sent. No Google event is removed.' : confirmation === 'prepare' ? 'Save this review before publishing. The following confirmation sends it to Google.' : `Send the retained review to ${review?.calendar?.summary ?? 'the dedicated calendar'} in ${review?.email}.`}
      safetyNote={confirmation === 'discard' ? 'The original event identity and publication receipt are retained.' : invitations ? 'Google will send invitations or update notices to guests. Removed guests can receive cancellation notices.' : 'No guests are selected. Private CRM notes are not copied to the event.'}
      safetyTone={confirmation === 'send' && invitations ? 'irreversible' : 'recovery'} pending={pending} confirmLabel={confirmation === 'prepare' ? 'Save review' : confirmation === 'send' ? 'Publish reviewed event' : 'Discard unsent review'}
      onCancel={() => setConfirmation(null)} onConfirm={() => { if (confirmation === 'prepare' && draft && review?.preview_fingerprint) prepare({ operation_id: crypto.randomUUID(), expected_preview_fingerprint: review.preview_fingerprint, draft }); else if (confirmation === 'send') step('send'); else if (confirmation === 'discard') discard(); }}>
      {confirmation !== 'discard' && display && <div className="max-h-[35vh] space-y-2 overflow-y-auto break-words rounded-lg border p-3 text-sm"><p>{display.summary}</p><p>{eventTime(display)}</p><p>{display.location || 'No location'} · {display.visibility}</p><p>Guests: {guests.join(', ') || 'None'}</p>{removed.length > 0 && <p>Removed guests: {removed.join(', ')}</p>}<p>Plan date: {display.follow_plan_date ? 'Follow the verified event' : 'Keep independent'}</p></div>}
    </ConfirmDialog>
  </div>;
}
