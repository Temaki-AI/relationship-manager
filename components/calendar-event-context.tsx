'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-changes-guard';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { readCalendarEventFacts, type CalendarEventFacts, type CalendarEventLinkPreview, type SavedCalendarEvent, type SavedCalendarEventReview, type EventMoment } from '@/packages/domain/src/calendar-events';
import { getResponseErrorMessage } from '@/lib/utils';
import { calendarEventWhen } from '@/packages/domain/src/calendar-event-display';
function moment(point: EventMoment | null, zone: string) {
  if (!point) return 'Time not supplied';
  if (point.date) return point.date;
  if (!point.instant) return `${point.date_time?.replace('T', ' ')} (${point.time_zone ?? zone}; offset not supplied)`;
  return new Intl.DateTimeFormat(undefined, { timeZone: point.time_zone ?? zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(point.instant)) + ` (${point.time_zone ?? zone})`;
}
export function CalendarEventFactsView({ facts, timeZone = 'UTC' }: { facts: CalendarEventFacts; timeZone?: string }) {
  return <div className="min-w-0 space-y-2">
    <h2 className="break-words text-lg font-semibold">{facts.title}</h2>
    <p className="break-words text-sm">{calendarEventWhen({ start: facts.start ?? facts.original_start, end: facts.end }, timeZone)} · {facts.status}</p>
    {facts.recurring_id && <p className="break-words text-sm">Recurring occurrence · originally {moment(facts.original_start, timeZone)}</p>}
    {facts.redacted && <p className="text-sm">Private details were not saved.</p>}{facts.location && <p className="break-words">{facts.location}</p>}
    {facts.attendees_incomplete && <p className="text-sm">Google supplied a partial participant list.</p>}
    {facts.attendees.length > 0 && <details><summary className="min-h-11 cursor-pointer">Source participants ({facts.attendees.length})</summary><ul className="space-y-2">{facts.attendees.map((p, i) => <li key={i} className="break-words text-sm">{p.name ?? p.email ?? 'Unnamed participant'}{p.name && p.email ? ` · ${p.email}` : ''} · {p.response}{p.resource ? ' · room or resource' : ''}</li>)}</ul></details>}
    <div className="flex flex-wrap gap-3">{facts.google_url && <a className="inline-flex min-h-11 items-center underline" href={facts.google_url} target="_blank" rel="noopener noreferrer">Open in Google Calendar</a>}{facts.conference_url && facts.status !== 'cancelled' && <a className="inline-flex min-h-11 items-center underline" href={facts.conference_url} target="_blank" rel="noopener noreferrer">Meeting link</a>}</div>
  </div>;
}
function SavedLinks({ event }: { event: SavedCalendarEvent }) {
  return <div className="space-y-2 text-sm">
    <p className="break-words">{event.calendar_label} · {event.account_email} · Source {event.source_status.replace('_', ' ')} · Last observed {new Date(event.observed_at).toLocaleString()}.</p>
    {event.source_status !== 'available' && <p>Retained context may be out of date. Reconnect and download the calendar to check it.</p>}
    <p>Linked people: {event.people.length ? event.people.map((p, i) => <span key={p.id}>{i > 0 && ', '}<Link className="underline" href={`/contacts/${p.id}`}>{p.name}</Link></span>) : 'none'}.</p>
    <p>Linked plans: {event.plans.length ? event.plans.map((p, i) => <span key={p.id}>{i > 0 && '; '}<Link className="underline" href={`/contacts/${p.contact_id}`}>{p.summary} · {p.contact_name} · {p.planned_date}</Link></span>) : 'none'}.</p>
  </div>;
}
export function SavedCalendarEventsList({ contactId }: { contactId?: string }) {
  const [data, setData] = useState<{ events: SavedCalendarEvent[]; more: boolean; next: number | null } | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async (after?: number) => {
    const current = ++generation.current; setLoading(true); setError('');
    try { const query = new URLSearchParams(); if (contactId) query.set('contact_id', contactId); if (after) query.set('after', String(after));
      const response = await fetch('/api/calendar/events?' + query, { cache: 'no-store' }); if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not read saved event context.'));
      const fresh = await response.json(); if (current === generation.current) setData(fresh);
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : 'Could not read events.'); }
    finally { if (current === generation.current) setLoading(false); }
  }, [contactId]);
  useEffect(() => { void load(); const requestGeneration = generation; return () => { requestGeneration.current++; }; }, [load]);
  return <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
    <Link className="inline-flex min-h-11 items-center underline" href={contactId ? `/contacts/${contactId}` : '/calendar'}>{contactId ? 'Back to person' : 'Back to calendar'}</Link>
    <h1 className="text-2xl font-semibold">Saved calendar context</h1><p>Reviewed source events linked to people or plans. Invitations and responses do not count as confirmed interactions.</p>
    {contactId && <p>Showing explicit person links and events attached to this person&apos;s plans. <Link href="/calendar/events" className="underline">All saved events</Link></p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}{loading && <p role="status">Loading saved events…</p>}
    {data && <><ul className="space-y-4">{data.events.map((event) => <li key={event.public_id} className="space-y-3 rounded-xl border p-4"><CalendarEventFactsView facts={event.facts} timeZone={event.calendar_time_zone} /><SavedLinks event={event} /><Link className="inline-flex min-h-11 items-center underline" href={`/calendar/events/${event.public_id}`}>Review saved links</Link></li>)}</ul>{data.events.length === 0 && <p>No saved events in this view. Download a selected Google calendar and review an event to save its context.</p>}
      <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={loading} onClick={() => void load()}>First saved event page</Button><Button variant="outline" disabled={loading || !data.more || !data.next} onClick={() => void load(data.next!)}>Next saved event page</Button></div></>}
    <Link href="/connections/google" className="inline-flex min-h-11 items-center underline">Google connections</Link>
  </div>;
}
type Review = CalendarEventLinkPreview | SavedCalendarEventReview;
type Pending = { kind: 'save' | 'remove'; payload: string };
const countLabel = (count: number, singular: string, plural: string) => `${count} ${count === 1 ? singular : plural}`;
const ordered = (ids: number[]) => [...ids].sort((a, b) => a - b);
export function CalendarEventLinkReview({ connectionId, calendarId = '', eventId = '', savedId }: { connectionId?: string; calendarId?: string; eventId?: string; savedId?: string }) {
  const sourceEndpoint = `/api/connections/${connectionId}/calendars/events`, endpoint = savedId ? `/api/calendar/events/${savedId}` : sourceEndpoint + '/link';
  const reviewEndpoint = savedId ? endpoint : sourceEndpoint + '/link-preview';
  const key = 'everclose:event-links:' + endpoint + ':' + encodeURIComponent(calendarId) + ':' + encodeURIComponent(eventId);
  const [data, setData] = useState<Review | null>(null), [contactIds, setContactIds] = useState<number[]>([]), [planIds, setPlanIds] = useState<number[]>([]), [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState<'save' | 'remove' | null>(null), [uncertain, setUncertain] = useState(false), [removed, setRemoved] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const initialized = useRef(false), pending = useRef<Pending | null>(null), generation = useRef(0), epochSeen = useRef<string | null>(null);
  const load = useCallback(async (directorySearch = '', contactsAfter?: number, plansAfter?: number) => {
    const current = ++generation.current; setLoading(true);
    try {
      const query = new URLSearchParams({ search: directorySearch }); if (!savedId) { query.set('calendar_id', calendarId); query.set('event_id', eventId); } if (contactsAfter) query.set('contacts_after', String(contactsAfter)); if (plansAfter) query.set('plans_after', String(plansAfter));
      const response = await fetch(reviewEndpoint + '?' + query, { cache: 'no-store' }); if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not read event context.'));
      const fresh = await response.json() as Review; readCalendarEventFacts('event' in fresh ? fresh.event.facts : fresh.facts);
      if (current !== generation.current) return;
      if (epochSeen.current && epochSeen.current !== fresh.epoch || pending.current && JSON.parse(pending.current.payload).expected_epoch !== fresh.epoch) {
        pending.current = null; setUncertain(false); initialized.current = false; try { sessionStorage.removeItem(key); } catch { /* Optional tab storage. */ }
        setNotice('Recovery changed this workspace. Previous draft choices were cleared; review the current links before saving.');
      }
      epochSeen.current = fresh.epoch;
      setData(fresh);
      if (!initialized.current) { initialized.current = true; const event = 'event' in fresh ? fresh.event : fresh.saved; setContactIds(event?.people.map((p) => p.id) ?? []); setPlanIds(event?.plans.map((p) => p.id) ?? []); }
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : 'Could not read event context.'); }
    finally { if (current === generation.current) setLoading(false); }
  }, [reviewEndpoint, savedId, calendarId, eventId, key]);
  useEffect(() => {
    initialized.current = false; pending.current = null; epochSeen.current = null; setUncertain(false); setRemoved(false); setData(null); setContactIds([]); setPlanIds([]); setError(''); setNotice('');
    try { const raw = sessionStorage.getItem(key); if (raw && raw.length <= 32768) { const item = JSON.parse(raw), body = JSON.parse(item.payload); if ((item.kind === 'save' && [body.contact_ids, body.plan_ids].every((ids) => Array.isArray(ids) && ids.length <= 20 && ids.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length) || item.kind === 'remove' && savedId) && isSyncUuid(body.operation_id) && isSyncUuid(body.expected_epoch) && (savedId || body.calendar_id === calendarId && body.event_id === eventId)) { pending.current = item; setUncertain(true); initialized.current = true; if (item.kind === 'save') { setContactIds(body.contact_ids); setPlanIds(body.plan_ids); } } } } catch { /* Tab recovery is optional. */ }
    void load(); const requestGeneration = generation; return () => { requestGeneration.current++; };
  }, [load, key, calendarId, eventId, savedId]);
  const saved = data ? 'event' in data ? data.event : data.saved : null, facts = data ? 'event' in data ? data.event.facts : data.facts : null;
  const dirty = JSON.stringify(ordered(contactIds)) !== JSON.stringify(ordered(saved?.people.map((p) => p.id) ?? [])) || JSON.stringify(ordered(planIds)) !== JSON.stringify(ordered(saved?.plans.map((p) => p.id) ?? []));
  function clearPending() { pending.current = null; setUncertain(false); try { sessionStorage.removeItem(key); } catch { /* Optional tab storage. */ } }
  function choose(id: number, checked: boolean, plans: boolean) { const choices = plans ? planIds : contactIds; if (checked && choices.length >= 20) { setError('Choose at most 20 people and 20 plans.'); return; } (plans ? setPlanIds : setContactIds)(checked ? [...choices, id] : choices.filter((item) => item !== id)); }
  async function mutate(kind: 'save' | 'remove') {
    if (busy || !data && !pending.current) return; setBusy(true); setConfirm(null); setError('');
    try {
      if (!pending.current) {
        const common = { operation_id: crypto.randomUUID(), expected_epoch: data!.epoch };
        const body = kind === 'remove' ? { ...common, expected_revision: saved!.revision } : savedId ? { ...common, expected_revision: saved!.revision, contact_ids: ordered(contactIds), plan_ids: ordered(planIds) } : { ...common, expected_authorization_revision: (data as CalendarEventLinkPreview).authorization_revision, expected_selection_revision: (data as CalendarEventLinkPreview).selection_revision, expected_generation: (data as CalendarEventLinkPreview).generation, calendar_id: calendarId, event_id: eventId, expected_event_revision: saved?.revision ?? null, contact_ids: ordered(contactIds), plan_ids: ordered(planIds) };
        pending.current = { kind, payload: JSON.stringify(body) };
        try { sessionStorage.setItem(key, JSON.stringify(pending.current)); } catch { setNotice('Tab recovery is unavailable. Keep this page open until saving is confirmed.'); }
      }
      const request = pending.current;
      const response = await fetch(endpoint, { method: request.kind === 'remove' ? 'DELETE' : savedId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: request.payload });
      if (!response.ok) { if (response.status < 500 && ![401, 408, 429].includes(response.status)) clearPending(); throw new Error(await getResponseErrorMessage(response, 'The event change was not confirmed.')); }
      const result = await response.json() as { event: SavedCalendarEvent | null; removed: boolean };
      if (result.removed !== true && (!result.event || !isSyncUuid(result.event.public_id) || !Number.isSafeInteger(result.event.revision))) throw new Error('The acknowledgement could not be read. Retry the unchanged request.');
      if (result.event) readCalendarEventFacts(result.event.facts);
      clearPending();
      if (result.removed) { setRemoved(true); setContactIds([]); setPlanIds([]); setNotice('Saved context removed. People and plans remain intact.'); }
      else { setContactIds(result.event!.people.map((p) => p.id)); setPlanIds(result.event!.plans.map((p) => p.id)); setData((old) => old ? 'event' in old ? { ...old, event: result.event! } : { ...old, saved: result.event! } : old); setNotice('Event context saved. Plans and interaction history are unchanged.'); }
    } catch (err) { if (pending.current) setUncertain(true); setError(err instanceof Error ? err.message : 'The event change was not confirmed.'); }
    finally { setBusy(false); }
  }
  const selectedPeople = saved?.people ?? [], selectedPlans = saved?.plans ?? [];
  const people = [...new Map([...selectedPeople.map((p) => ({ ...p, email: null as string | null })), ...(data && 'matches' in data ? data.matches.flatMap((m) => m.candidates) : []), ...(data?.contacts ?? [])].map((p) => [p.id, p])).values()];
  const plans = [...new Map([...selectedPlans, ...(data?.plans ?? [])].map((p) => [p.id, p])).values()];
  return <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
    <Link className="inline-flex min-h-11 items-center underline" href={savedId ? '/calendar/events' : `/connections/google/${connectionId}/calendars/events?${new URLSearchParams({ calendar_id: calendarId })}`}>{savedId ? 'All saved events' : 'Back to source events'}</Link>
    <h1 className="text-2xl font-semibold">Review calendar context</h1><p>Save an event and explicitly choose people or existing plans. You can save it before creating a person and add links later.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}
    {uncertain && <div className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">Unconfirmed event change</h2><p>Retry the unchanged request to learn whether it was saved. Choices stay locked until the result is confirmed.</p><Button disabled={busy} onClick={() => void mutate(pending.current!.kind)}>Retry unchanged event change</Button></div>}
    {loading && <p role="status">Loading event review…</p>}
    {!removed && <><Button variant="outline" disabled={busy || loading} onClick={() => { setError(''); void load(search); }}>Refresh current event</Button>
      {facts && <div className="space-y-3 rounded-xl border p-4"><CalendarEventFactsView facts={facts} timeZone={saved?.calendar_time_zone ?? (data && 'calendar_time_zone' in data ? data.calendar_time_zone : facts.start?.time_zone) ?? 'UTC'} />{data && 'account_email' in data && !saved && <p className="break-words text-sm">{data.calendar_label} · {data.account_email} · Calendar timezone {data.calendar_time_zone} · Last observed {new Date(data.observed_at).toLocaleString()}.</p>}{saved && <><SavedLinks event={saved} />{!savedId && <Link className="inline-flex min-h-11 items-center underline" href={`/calendar/events/${saved.public_id}`}>Open retained context</Link>}</>}</div>}
      {data && <><fieldset disabled={busy || uncertain || loading} className="space-y-4 rounded-xl border p-4"><legend className="px-1 font-semibold">Choose event links</legend>
        {'matches' in data && data.matches.length > 0 && <div><h2 className="font-semibold">Participant suggestions</h2><p className="text-sm">Email matches are suggestions. Shared addresses may refer to several people; nothing is selected automatically.</p><ul className="space-y-2 text-sm">{data.matches.map((m) => <li key={m.address} className="break-words">{m.address}: {m.candidates.length ? m.candidates.map((p) => p.name).join(', ') : 'no existing person'}{m.more ? ' · more matches; search below' : ''}</li>)}</ul></div>}
        <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(event) => { event.preventDefault(); void load(search); }}><div className="min-w-0 flex-1"><Label htmlFor="event-link-search">Search people or plans</Label><Input id="event-link-search" value={search} maxLength={200} onChange={(e) => setSearch(e.target.value)} /></div><Button type="submit" variant="outline">Search event links</Button></form>
        <div><h2 className="font-semibold">People ({contactIds.length}/20)</h2><ul>{people.map((p) => <li key={p.id}><label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={contactIds.includes(p.id)} onChange={(e) => choose(p.id, e.target.checked, false)} /><span className="min-w-0 break-words">{p.name}{p.email ? ` · ${p.email}` : ''}</span></label></li>)}</ul>{!people.length && <p>No people on this page. You can create a person and return later.</p>}
          {contactIds.filter((id) => !people.some((p) => p.id === id)).map((id) => <label key={id} className="flex min-h-11 items-center gap-3"><input type="checkbox" checked onChange={() => choose(id, false, false)} />Selected person #{id} · outside this search</label>)}
          <Button variant="outline" disabled={!data.contacts_more} onClick={() => void load(search, data.contacts_next!)}>Next people page</Button></div>
        <div><h2 className="font-semibold">Plans ({planIds.length}/20)</h2><p className="text-sm">Linking a plan keeps its date, notes and completion state. A plan can link to one saved event.</p><ul>{plans.map((p) => <li key={p.id}><label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={planIds.includes(p.id)} onChange={(e) => choose(p.id, e.target.checked, true)} /><span className="min-w-0 break-words">{p.summary} · {p.contact_name} · {p.planned_date}</span></label></li>)}</ul>
          {planIds.filter((id) => !plans.some((p) => p.id === id)).map((id) => <label key={id} className="flex min-h-11 items-center gap-3"><input type="checkbox" checked onChange={() => choose(id, false, true)} />Selected plan #{id} · outside this search</label>)}
          <Button variant="outline" disabled={!data.plans_more} onClick={() => void load(search, undefined, data.plans_next!)}>Next plans page</Button></div>
        <p>{countLabel(contactIds.length, 'person', 'people')} and {countLabel(planIds.length, 'plan', 'plans')} selected. Other links will be removed from this event when you save.</p>
        <Button onClick={() => setConfirm('save')}>Save reviewed context</Button>
      </fieldset>{savedId && <Button variant="outline" disabled={busy || uncertain || loading} onClick={() => setConfirm('remove')}>Remove saved context</Button>}</>}
    </>}
    <UnsavedChangesGuard active={!removed && (busy || uncertain || dirty)} onDiscard={() => { if (!pending.current) { setContactIds(saved?.people.map((p) => p.id) ?? []); setPlanIds(saved?.plans.map((p) => p.id) ?? []); } }} />
    <ConfirmDialog open={confirm === 'save'} onCancel={() => setConfirm(null)} title="Save this event context?" description={`Save the displayed source details with ${countLabel(contactIds.length, 'person', 'people')} and ${countLabel(planIds.length, 'plan', 'plans')} in this workspace. This does not change plan dates, send invitations or log interactions.`} safetyTone="recovery" safetyNote="Retained source context and reviewed links are included in CRM backup and recovery. Private notes stay unchanged." confirmLabel="Confirm event links" onConfirm={() => void mutate('save')} />
    <ConfirmDialog open={confirm === 'remove'} onCancel={() => setConfirm(null)} title="Remove saved event context?" description="Remove this retained event and its person and plan links. People, plans, notes, history and the Google event remain unchanged. This does not hide the downloaded source event." safetyTone="recovery" safetyNote="A verified CRM recovery point must be saved before removal. Retained backups may still contain this context." confirmLabel="Confirm context removal" onConfirm={() => void mutate('remove')} />
  </div>;
}
