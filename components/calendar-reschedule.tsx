'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { format } from 'date-fns';
import type { CoreCalendarEvent } from '@/lib/calendar-directory';
import { getResponseErrorMessage } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';

type Review = { revision: string; original: string; initial: string; title: string };
export function CalendarReschedule({ event, onCancel, onSaved }: { event: CoreCalendarEvent; onCancel: () => void; onSaved: (at: string) => void }) {
  const fieldId = useId(), active = useRef(true), hasReview = useRef(false), attempt = useRef<{ body: string; at: string } | null>(null);
  const [review, setReview] = useState<Review | null>(null), [value, setValue] = useState('');
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
  const kind = event.kind === 'plan' ? 'plan' : 'reminder', endpoint = `/api/${kind === 'plan' ? 'plans' : 'reminders'}/${event.source_id}`;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function load() {
    setLoading(true); setError('');
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Unable to load the current event.'));
      const data = (await response.json())[kind] as Record<string, unknown>;
      const at = data?.[kind === 'plan' ? 'planned_date' : 'remind_at'];
      if (!data || data.contact_id !== event.contact_id || data.completed_at !== null || typeof data.schedule_revision !== 'string'
        || !/^[a-f0-9]{64}$/u.test(data.schedule_revision) || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) {
        throw new Error('This event or its person changed. Close this review and refresh Calendar.');
      }
      const initial = kind === 'plan' ? at : format(new Date(at), "yyyy-MM-dd'T'HH:mm");
      if (active.current) {
        attempt.current = null; setUncertain(false);
        if (!hasReview.current) setValue(initial);
        hasReview.current = true;
        setReview({ revision: data.schedule_revision, original: at, initial, title: String(data.title ?? data.summary ?? event.title) });
      }
    } catch (issue) { if (active.current) { setReview(null); setError(issue instanceof Error ? issue.message : 'Unable to load this event.'); } }
    finally { if (active.current) setLoading(false); }
  }
  useEffect(() => { void load(); /* Each keyed dialog reviews one event. */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = kind === 'plan' ? null : new Date(value);
  const valid = kind === 'plan' ? /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
    : parsed && Number.isFinite(parsed.getTime()) && format(parsed, "yyyy-MM-dd'T'HH:mm") === value;
  async function save() {
    if (saving || !review || !attempt.current && (!valid || value === review.initial)) return;
    const frozen = attempt.current ?? { at: kind === 'plan' ? value : parsed!.toISOString(), body: '' };
    if (!frozen.body) frozen.body = JSON.stringify({ calendar_schedule: { expected_revision: review.revision, original_at: review.original, at: frozen.at } });
    attempt.current = frozen; setSaving(true); setError('');
    try {
      const response = await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: frozen.body });
      if (!response.ok) {
        if (response.status < 500) { attempt.current = null; setUncertain(false); setReview(null); }
        throw new Error(await getResponseErrorMessage(response, 'Unable to confirm this date change.'));
      }
      const data = (await response.json())[kind] as Record<string, unknown>;
      const at = data?.[kind === 'plan' ? 'planned_date' : 'remind_at'];
      if (typeof at !== 'string' || (kind === 'plan' ? at !== frozen.at : Date.parse(at) !== Date.parse(frozen.at))) throw new Error('The saved date could not be confirmed. Retry the unchanged request.');
      if (active.current) { attempt.current = null; setUncertain(false); onSaved(frozen.at); }
    } catch (issue) {
      if (active.current) { setUncertain(Boolean(attempt.current)); setError(attempt.current ? 'The date change is unconfirmed. Retry this unchanged request before adjusting it.' : issue instanceof Error ? issue.message : 'Unable to save this date.'); }
    } finally { if (active.current) setSaving(false); }
  }
  return <ConfirmDialog open title={kind === 'plan' ? 'Reschedule plan' : 'Reschedule reminder'} actionTone="standard"
    description={review?.title || event.title} safetyTone="recovery"
    safetyNote={kind === 'plan' ? 'Change this Everclose plan’s date. Its private notes and history stay intact. A linked Google or Apple event keeps its own date until you separately review an update there.' : 'Change when Everclose reminds you. The person, title, private notes and completion history stay intact.'}
    confirmLabel={uncertain ? 'Retry unchanged date change' : 'Save new date'} pendingLabel="Saving date…" pending={saving}
    confirmDisabled={loading || !review || !uncertain && (!valid || value === review.initial)} onCancel={onCancel} onConfirm={() => { void save(); }}>
    <div className="mt-4 space-y-3">
      {loading ? <p role="status" className="text-sm">Loading the current date…</p> : review && <>
        <p className="text-sm text-muted-foreground">Current date: {kind === 'plan' ? review.original : new Date(review.original).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' })}</p>
        <label htmlFor={fieldId} className="block text-sm font-medium">{kind === 'plan' ? 'New plan date' : 'New reminder date and time'}</label>
        <input id={fieldId} type={kind === 'plan' ? 'date' : 'datetime-local'} value={value} disabled={saving || uncertain} onChange={(change) => setValue(change.target.value)} className="min-h-11 w-full min-w-0 rounded-lg border bg-background px-3 text-sm" />
        {kind === 'reminder' && valid && <p className="break-words text-xs text-muted-foreground">{parsed!.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' })} ({Intl.DateTimeFormat().resolvedOptions().timeZone})</p>}
        {!valid && <p className="text-sm text-destructive">Choose a valid {kind === 'plan' ? 'date' : 'local date and time'}.</p>}
      </>}
      {!!error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!loading && !review && <Button type="button" variant="outline" disabled={saving} onClick={() => { void load(); }}>Review current event</Button>}
    </div>
  </ConfirmDialog>;
}
