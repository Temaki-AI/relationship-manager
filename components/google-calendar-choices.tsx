'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-changes-guard';
import type { CalendarReview } from '@/packages/domain/src/calendars';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { getResponseErrorMessage } from '@/lib/utils';
type Attempt = { payload: string };
const storageKey = (id: string, epoch: string) => `everclose:calendar-choices:${id}:${epoch}`;
export function GoogleCalendarChoices({ connectionId }: { connectionId: string }) {
  const endpoint = `/api/connections/${connectionId}/calendars`;
  const [data, setData] = useState<CalendarReview | null>(null), [selected, setSelected] = useState<string[]>([]), [search, setSearch] = useState(''), [appliedSearch, setAppliedSearch] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [confirm, setConfirm] = useState(false), [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [clock, setClock] = useState(Date.now());
  const pending = useRef<Attempt | null>(null), discovery = useRef<string | null>(null), generation = useRef(0), recovered = useRef(false);
  const load = useCallback(async (after: string | null = null, searchText = '', preserveDraft = false, catalogue: string | null = null) => {
    const current = ++generation.current;
    try {
      const query = new URLSearchParams({ search: searchText }); if (after) { query.set('after', after); query.set('generation', catalogue ?? ''); }
      const response = await fetch(endpoint + '?' + query, { cache: 'no-store' });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not review this calendar account.'));
      const fresh = await response.json() as CalendarReview; if (current !== generation.current) return;
      setData(fresh); setAppliedSearch(searchText); if (!preserveDraft) setSelected(fresh.selected_ids);
      if (!recovered.current) {
        recovered.current = true;
        try {
          const saved = sessionStorage.getItem(storageKey(connectionId, fresh.epoch));
          if (saved && saved.length <= 65536) {
            const item = JSON.parse(saved) as Attempt, body = JSON.parse(item.payload);
            if (typeof item.payload === 'string' && item.payload.length <= 32768 && isSyncUuid(body.operation_id) && body.expected_epoch === fresh.epoch && Array.isArray(body.selected_ids) && body.selected_ids.length <= 20 && body.selected_ids.every((id: unknown) => typeof id === 'string')) {
              pending.current = item; setSelected(body.selected_ids); setUncertain(true);
            }
          }
        } catch { /* Tab storage is optional; the current authenticated list remains usable. */ }
      }
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : 'Could not load calendars.'); }
  }, [endpoint, connectionId]);
  useEffect(() => { let active = true; const requestGeneration = generation; void load().finally(() => { if (active) setLoading(false); }); return () => { active = false; requestGeneration.current++; }; }, [load]);
  useEffect(() => { if (!data?.run?.retry_at) return; const interval = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(interval); }, [data?.run?.retry_at]);
  const dirty = uncertain || busy || Boolean(data && JSON.stringify([...selected].sort()) !== JSON.stringify([...data.selected_ids].sort()));
  const clear = (item: Attempt) => { try { sessionStorage.removeItem(storageKey(connectionId, JSON.parse(item.payload).expected_epoch)); } catch { /* Optional storage. */ } pending.current = null; setUncertain(false); };
  async function discover(step = false) {
    if (!data || busy || uncertain) return; setBusy(true); setError('');
    try {
      discovery.current ??= JSON.stringify({ operation_id: crypto.randomUUID(), expected_epoch: data.epoch, expected_authorization_revision: data.authorization_revision });
      const response = await fetch(endpoint + (step ? '/step' : ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: step ? JSON.stringify({ run_id: data.run!.id }) : discovery.current });
      if (!response.ok) { if (response.status < 500 && ![401, 408, 429].includes(response.status)) discovery.current = null; throw new Error(await getResponseErrorMessage(response, 'Calendar discovery was not confirmed. Refresh or retry.')); }
      discovery.current = null; await load(null, appliedSearch, true);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not discover calendars.'); await load(null, appliedSearch, true); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!data || busy) return; setConfirm(false); setBusy(true); setError('');
    let attempt = pending.current;
    try {
      if (!uncertain) {
        attempt = { payload: JSON.stringify({ operation_id: crypto.randomUUID(), expected_epoch: data.epoch, expected_authorization_revision: data.authorization_revision,
          expected_generation: data.generation, expected_selection_revision: data.selection_revision, selected_ids: selected }) };
        pending.current = attempt;
        try { sessionStorage.setItem(storageKey(connectionId, data.epoch), JSON.stringify(attempt)); } catch { setNotice('Tab recovery is unavailable. Keep this page open until your choices are confirmed.'); }
      }
      if (!attempt) throw new Error('No unconfirmed calendar choices are available.');
      const response = await fetch(endpoint + '/selection', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: attempt.payload });
      if (!response.ok) {
        const message = await getResponseErrorMessage(response, 'Calendar choices were not confirmed.');
        if (response.status < 500 && ![401, 408, 429].includes(response.status)) clear(attempt);
        throw new Error(message);
      }
      clear(attempt); setNotice('Your reviewed choice was confirmed. The refreshed list shows current calendar choices.'); await load(null, appliedSearch);
    } catch (err) { if (pending.current) setUncertain(true); setError(err instanceof Error ? err.message : 'Retry the unchanged calendar choices.'); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-8 [&_button]:min-h-11">
    <Link className="inline-block py-3 underline" href="/connections/google/calendar">Back to Google Calendar connections</Link>
    <h1 className="text-2xl font-semibold">Choose Google calendars</h1>
    <p>Discover this account&apos;s calendar list, then explicitly choose up to 20 calendars for event context. Connecting alone selects none.</p>
    <p className="text-sm text-muted-foreground">This step reads calendar names, timezones and access roles. It does not download events, create people, publish plans or notify invitees. Open a saved calendar below to explicitly download its events.</p>
    {!!error && <p role="alert" className="text-destructive">{error}</p>}{!!notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">Loading calendar choices…</p> : <>
      <Button variant="outline" disabled={busy} onClick={() => { setError(''); void load(null, appliedSearch, Boolean(data)); }}>Refresh calendar choices</Button>
      {uncertain && <div className="space-y-3 rounded-xl border p-4"><h2 className="text-lg font-semibold">Unconfirmed calendar choices</h2><p>Retry the saved request before editing. Restored or changed authorization requires a new review.</p><Button disabled={busy} onClick={() => void save()}>Retry unchanged choices</Button></div>}
      {data && <>
        <fieldset disabled={busy || uncertain} className="space-y-4">
          <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={data.run?.status === 'active'} onClick={() => void discover()}>Discover calendars</Button>
            {data.run?.status === 'active' && <Button disabled={data.run.retry_at > clock} onClick={() => void discover(true)}>Continue discovery</Button>}</div>
          {data.run && <p role="status">Discovery {data.run.status} · {data.run.processed} calendars · {data.run.pages} pages{data.run.retry_at > clock ? ' · waiting for provider retry' : ''}. {data.run.status !== 'complete' ? 'The previous complete list stays available.' : ''}</p>}
          <Label htmlFor="calendar-search">Find a calendar</Label><Input id="calendar-search" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} />
          <Button variant="outline" onClick={() => void load(null, search, true)}>Search calendars</Button>
          <p>{selected.length} of 20 calendars chosen.</p>
          {data.selected_calendars.length > 0 && <div className="rounded-xl border p-4"><h2 className="font-semibold">Saved calendar choices</h2><ul className="mt-2 space-y-2">{data.selected_calendars.map((calendar) => <li className="break-words" key={calendar.facts.id}><Link className="inline-flex min-h-11 items-center underline" href={`/connections/google/${connectionId}/calendars/events?calendar_id=${encodeURIComponent(calendar.facts.id)}`}>Review events in {calendar.facts.summary}</Link> · {calendar.availability}{calendar.facts.access_role === 'freeBusyReader' ? ' · event read access unavailable' : ''}</li>)}</ul></div>}
          {data.calendars.length === 0 && <p>{data.generation ? 'No calendars match this search.' : 'Discover the calendar list before choosing calendars.'}</p>}
          <ul className="space-y-3">{data.calendars.map((calendar) => <li className="min-w-0 space-y-2 rounded-xl border p-4" key={calendar.facts.id}>
            <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={selected.includes(calendar.facts.id)} disabled={(!data.selected_ids.includes(calendar.facts.id) && (calendar.availability !== 'available' || calendar.facts.access_role === 'freeBusyReader')) || !selected.includes(calendar.facts.id) && selected.length >= 20}
              onChange={(event) => setSelected((values) => event.target.checked ? [...values, calendar.facts.id] : values.filter((id) => id !== calendar.facts.id))} /><span className="min-w-0 break-words">{calendar.facts.summary}</span></label>
            <p className="break-words text-sm text-muted-foreground">{calendar.facts.time_zone} · {calendar.facts.access_role} · {calendar.availability}{calendar.facts.primary ? ' · primary calendar' : ''}{calendar.facts.hidden ? ' · hidden in Google' : ''}</p>
            {(calendar.availability === 'unavailable' || calendar.facts.access_role === 'freeBusyReader') && <p className="text-sm">Event read access is unavailable. A previously saved choice can be kept or removed; your relationships remain intact.</p>}
          </li>)}</ul>
          <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={() => void load(null, appliedSearch, true)}>First page</Button><Button variant="outline" disabled={!data.more} onClick={() => void load(data.next, appliedSearch, true, data.generation)}>Next page</Button></div>
          <Button disabled={!data.generation} onClick={() => setConfirm(true)}>Save reviewed calendars</Button>
        </fieldset>
      </>}
    </>}
    <ConfirmDialog open={confirm} onCancel={() => setConfirm(false)} title="Save these calendar choices?" description={`Choose ${selected.length} calendars for event context. This choice does not download events, change Google calendars or send invitations.`}
      safetyTone="recovery" safetyNote="Unavailable saved calendars can remain selected without deleting people or relationship history." confirmLabel="Confirm calendar choices" onConfirm={() => void save()} />
    <UnsavedChangesGuard active={dirty} onDiscard={() => window.location.reload()} />
  </div>;
}
