'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-changes-guard';
import type { CalendarEventsReview, EventMoment } from '@/packages/domain/src/calendar-events';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { getResponseErrorMessage } from '@/lib/utils';
import { CalendarEventSchedule } from '@/components/calendar-event-schedule';
const storageKey = (id: string, calendar: string, epoch: string) => `everclose:event-download:${id}:${encodeURIComponent(calendar)}:${epoch}`;
function momentLabel(point: EventMoment | null, timeZone: string) {
  if (!point) return 'Time not supplied'; if (point.date) return point.date;
  if (!point.instant) return `${point.date_time?.replace('T', ' ')} (${point.time_zone ?? timeZone}; offset not supplied)`;
  return new Intl.DateTimeFormat(undefined, { timeZone: point.time_zone ?? timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(point.instant)) + ` (${point.time_zone ?? timeZone})`;
}
export function GoogleCalendarEvents({ connectionId, calendarId }: { connectionId: string; calendarId: string }) {
  const endpoint = `/api/connections/${connectionId}/calendars/events`;
  const [data, setData] = useState<CalendarEventsReview | null>(null), [past, setPast] = useState('90'), [future, setFuture] = useState('180'), [cancelled, setCancelled] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [clock, setClock] = useState(Date.now());
  const pending = useRef<string | null>(null), recovered = useRef(false), generation = useRef(0);
  const load = useCallback(async (after: string | null = null, catalogue: string | null = null, includeCancelled = false) => {
    const current = ++generation.current;
    try {
      const query = new URLSearchParams({ calendar_id: calendarId, cancelled: includeCancelled ? '1' : '0' }); if (after) { query.set('after', after); query.set('generation', catalogue ?? ''); }
      const response = await fetch(endpoint + '?' + query, { cache: 'no-store' }); if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not read this calendar.'));
      const fresh = await response.json() as CalendarEventsReview; if (current !== generation.current) return; setData(fresh);
      if (!recovered.current) { recovered.current = true; try {
        const saved = sessionStorage.getItem(storageKey(connectionId, calendarId, fresh.epoch));
        if (saved && saved.length <= 32768) { const body = JSON.parse(saved); if (isSyncUuid(body.operation_id) && body.calendar_id === calendarId && body.expected_epoch === fresh.epoch) { pending.current = saved; setUncertain(true); setPast(String(body.past_days)); setFuture(String(body.future_days)); } }
      } catch { /* The authenticated source review remains usable if tab storage is unavailable. */ } }
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : 'Could not read events.'); }
  }, [endpoint, connectionId, calendarId]);
  useEffect(() => { let active = true; const requestGeneration = generation; if (calendarId) void load().finally(() => { if (active) setLoading(false); }); else setLoading(false); return () => { active = false; requestGeneration.current++; }; }, [load, calendarId]);
  useEffect(() => { if (!data?.run?.retry_at) return; const interval = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(interval); }, [data?.run?.retry_at]);
  function clear(payload: string) { try { sessionStorage.removeItem(storageKey(connectionId, calendarId, JSON.parse(payload).expected_epoch)); } catch { /* Optional tab recovery. */ } pending.current = null; setUncertain(false); }
  async function download(step = false) {
    if (!data || busy || step && uncertain) return; setBusy(true); setConfirm(false); setError('');
    let payload: string | null = null;
    try {
      if (!step) {
        pending.current ??= JSON.stringify({ operation_id: crypto.randomUUID(), calendar_id: calendarId, expected_epoch: data.epoch, expected_authorization_revision: data.authorization_revision, expected_selection_revision: data.selection_revision, past_days: Number(past), future_days: Number(future) });
        payload = pending.current;
        try { sessionStorage.setItem(storageKey(connectionId, calendarId, data.epoch), payload); } catch { setNotice('Tab recovery is unavailable. Keep this page open until the download is confirmed.'); }
      }
      const response = await fetch(endpoint + (step ? '/step' : ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: step ? JSON.stringify({ run_id: data.run!.id }) : payload });
      if (!response.ok) { if (payload && response.status < 500 && ![401, 408, 429].includes(response.status)) clear(payload); throw new Error(await getResponseErrorMessage(response, 'The download was not confirmed. Refresh or retry.')); }
      if (payload) clear(payload); await load(null, null, cancelled);
    } catch (err) { if (pending.current) setUncertain(true); setError(err instanceof Error ? err.message : 'Could not continue this download.'); await load(null, null, cancelled); }
    finally { setBusy(false); }
  }
  const validWindow = /^\d+$/u.test(past) && /^\d+$/u.test(future) && Number(past) + Number(future) <= 365;
  async function cancel() {
    if (!data?.run || busy || uncertain) return; setBusy(true); setError('');
    try { const response = await fetch(endpoint, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: data.run.id }) }); if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Cancellation was not confirmed. Refresh event status.')); }
    catch (err) { setError(err instanceof Error ? err.message : 'Cancellation was not confirmed. Refresh event status.'); }
    finally { await load(null, null, cancelled); setBusy(false); }
  }
  return <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
    <Link className="inline-flex min-h-11 items-center underline" href={`/connections/google/${connectionId}/calendars`}>Calendar choices</Link>
    <h1 className="text-2xl font-semibold">Google Calendar events</h1>
    <p>Download a selected calendar&apos;s event context. Private events appear as busy time. Source events do not count as confirmed interactions.</p>
    {!!error && <p role="alert" className="text-destructive">{error}</p>}{!!notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">Loading calendar events…</p> : !calendarId ? <p>Choose a saved calendar to review its events.</p> : data && <>
      <h2 className="break-words text-lg font-semibold">{data.calendar.summary}</h2>
      <p className="text-sm text-muted-foreground">Calendar timezone: {data.calendar.time_zone} · Event access {data.availability}. {data.last_downloaded_at ? `Last complete download: ${new Date(data.last_downloaded_at).toLocaleString()}.` : 'No complete download yet.'}</p>
      {data.window_start && <p className="text-sm">Downloaded window: {momentLabel({ date: null, date_time: data.window_start, time_zone: data.calendar.time_zone, instant: data.window_start }, data.calendar.time_zone)} to {momentLabel({ date: null, date_time: data.window_end, time_zone: data.calendar.time_zone, instant: data.window_end }, data.calendar.time_zone)} (end excluded).</p>}
      <Button variant="outline" disabled={busy} onClick={() => { setError(''); void load(null, null, cancelled); }}>Refresh event status</Button>
      {data.schedule && <CalendarEventSchedule key={`${data.epoch}:${data.authorization_revision}:${data.selection_revision}:${data.schedule.revision}`} data={data} endpoint={endpoint} reload={() => load(null, null, cancelled)} />}
      {uncertain && <div className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">Unconfirmed event download</h2><p>Retry the unchanged request before starting another download.</p><Button disabled={busy} onClick={() => void download()}>Retry unchanged download</Button></div>}
      <fieldset disabled={busy || uncertain || data.run?.status === 'active'} className="space-y-3 rounded-xl border p-4">
        <legend className="px-1 font-semibold">Choose the date window</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><div><Label htmlFor="event-past">Past days</Label><Input id="event-past" type="number" inputMode="numeric" min="0" max="365" value={past} onChange={(e) => setPast(e.target.value)} /></div><div><Label htmlFor="event-future">Future days</Label><Input id="event-future" type="number" inputMode="numeric" min="0" max="365" value={future} onChange={(e) => setFuture(e.target.value)} /></div></div>
        <p className="text-sm">Up to 365 past and future days combined, plus today, in the calendar&apos;s timezone. Downloads contain at most 5,000 events; a larger result keeps the last complete view.</p>
        <Button disabled={!validWindow || !data.can_download} onClick={() => setConfirm(true)}>Download events</Button>
      </fieldset>
      {data.run && <p role="status">Download {data.run.status} · {data.run.processed} events · {data.run.pages} pages{data.run.retry_at > clock ? ' · waiting for provider retry' : ''}. {data.run.issue === 'calendar_unavailable' ? 'This calendar is unavailable. Refresh calendar choices or try again after access is restored.' : data.run.issue === 'unsupported_events' ? 'The download could not be completed within the supported format or size. Try a smaller date window.' : data.run.issue === 'schedule_changed' ? 'Automatic choices changed; the previous unfinished automatic download was cancelled.' : data.run.issue === 'job_expired' ? 'The automatic download could not finish while its authorization and time window were current. Review access and refresh again.' : ''} {data.run.status !== 'complete' ? 'The previous complete view stays available.' : ''}</p>}
      {data.run?.status === 'active' && <div className="flex flex-wrap gap-3"><Button disabled={busy || uncertain || data.run.retry_at > clock} onClick={() => void download(true)}>Continue event download</Button><Button variant="outline" disabled={busy || uncertain} onClick={() => void cancel()}>Cancel event download</Button></div>}
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={cancelled} disabled={busy} onChange={(e) => { setCancelled(e.target.checked); void load(null, null, e.target.checked); }} />Include cancelled source events</label>
      {data.events.length === 0 && <p>{data.generation ? 'No events in this view.' : 'Download events to review this calendar.'}</p>}
      <ul className="space-y-3">{data.events.map((event) => <li className="min-w-0 space-y-2 rounded-xl border p-4" key={event.id}>
        <h3 className="break-words font-semibold">{event.title}</h3><p className="break-words text-sm">{momentLabel(event.start ?? event.original_start, data.calendar.time_zone)}{event.start?.date ? ' · all day (end date excluded)' : event.end ? ` → ${momentLabel(event.end, data.calendar.time_zone)}` : ''} · {event.status}</p>
        {event.start?.date && event.end?.date && <p className="text-sm">All-day dates: {event.start.date} to {event.end.date} (end excluded).</p>}
        {event.recurring_id && <p className="break-words text-sm">Recurring occurrence · originally {momentLabel(event.original_start, data.calendar.time_zone)}</p>}
        {event.redacted && <p className="text-sm">Private details were not saved.</p>}{event.location && <p className="break-words text-sm">{event.location}</p>}
        {event.organizer && <p className="break-words text-sm">Organizer: {event.organizer.name ?? event.organizer.email ?? 'Not supplied'}</p>}
        {event.attendees_incomplete && <p className="text-sm">Google supplied a partial participant list.</p>}
        {event.attendees.length > 0 && <details><summary className="min-h-11 cursor-pointer">Participants ({event.attendees.length})</summary><ul className="space-y-2">{event.attendees.map((p, i) => <li className="break-words text-sm" key={i}>{p.name ?? p.email ?? 'Unnamed participant'}{p.name && p.email ? ` · ${p.email}` : ''} · {p.response === 'needsAction' ? 'awaiting response' : p.response}{p.resource ? ' · room or resource' : ''}</li>)}</ul></details>}
        <div className="flex flex-wrap gap-4">{data.can_download && <Link className="inline-flex min-h-11 items-center underline" href={`/connections/google/${connectionId}/calendars/events/link?${new URLSearchParams({ calendar_id: calendarId, event_id: event.id })}`}>Link to people and plans</Link>}{event.google_url && <a className="inline-flex min-h-11 items-center underline" href={event.google_url} target="_blank" rel="noopener noreferrer">Open in Google Calendar</a>}{event.conference_url && <a className="inline-flex min-h-11 items-center underline" href={event.conference_url} target="_blank" rel="noopener noreferrer">Meeting link</a>}</div>
      </li>)}</ul>
      <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={busy} onClick={() => void load(null, null, cancelled)}>First event page</Button><Button variant="outline" disabled={busy || !data.more || !data.next} onClick={() => void load(data.next, data.generation, cancelled)}>Next event page</Button></div>
    </>}
    <UnsavedChangesGuard active={busy || uncertain} onDiscard={() => window.location.reload()} />
    <ConfirmDialog open={confirm} onCancel={() => setConfirm(false)} title="Download this calendar's events?" description="Read events within the chosen date window, including recurring occurrences and cancellations. Private details will not be stored. This does not create people, publish plans, notify invitees or log interactions." safetyTone="recovery" safetyNote="The last complete view stays available until every page arrives." confirmLabel="Confirm event download" onConfirm={() => void download()} />
  </div>;
}
