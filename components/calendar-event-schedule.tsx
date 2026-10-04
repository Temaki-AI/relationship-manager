'use client';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-changes-guard';
import type { CalendarEventsReview } from '@/packages/domain/src/calendar-events';
import { getResponseErrorMessage } from '@/lib/utils';

export function CalendarEventSchedule({ data, endpoint, reload }: { data: CalendarEventsReview; endpoint: string; reload(): Promise<unknown> }) {
  const schedule = data.schedule;
  const [enabled, setEnabled] = useState(schedule.enabled), [interval, setInterval] = useState(String(schedule.interval));
  const [past, setPast] = useState(String(schedule.past_days)), [future, setFuture] = useState(String(schedule.future_days));
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [confirm, setConfirm] = useState(false), [error, setError] = useState('');
  const pending = useRef<string | null>(null);
  const valid = /^\d+$/u.test(past) && /^\d+$/u.test(future) && Number(past) + Number(future) <= 365;
  const dirty = enabled !== schedule.enabled || Number(interval) !== schedule.interval || Number(past) !== schedule.past_days || Number(future) !== schedule.future_days;
  async function save() {
    if (busy) return;
    setBusy(true); setConfirm(false); setError('');
    pending.current ??= JSON.stringify({ calendar_id: data.calendar.id, expected_epoch: data.epoch, expected_authorization_revision: data.authorization_revision,
      expected_selection_revision: data.selection_revision, expected_settings_revision: schedule.revision, enabled, interval: Number(interval), past_days: Number(past), future_days: Number(future) });
    try {
      const response = await fetch(endpoint + '/schedule', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: pending.current });
      if (!response.ok) {
        if (response.status < 500 && ![401, 408, 429].includes(response.status)) { pending.current = null; setUncertain(false); }
        else setUncertain(true);
        throw new Error(await getResponseErrorMessage(response, 'Automatic choices were not confirmed. Check saved choices or retry unchanged.'));
      }
      pending.current = null; setUncertain(false);
    } catch (err) {
      if (pending.current) setUncertain(true);
      setError(err instanceof Error ? err.message : 'Automatic choices were not confirmed.');
    } finally { await reload(); setBusy(false); }
  }
  return <section className="space-y-3 rounded-xl border p-4" aria-labelledby="automatic-calendar-heading">
    <h2 id="automatic-calendar-heading" className="font-semibold">Automatic event downloads</h2>
    <p className="text-sm">Currently {schedule.enabled ? `on · ${schedule.interval === 3600 ? 'hourly' : 'daily'}` : 'off'}. {schedule.enabled && schedule.next_at ? `Next eligible refresh: ${new Date(schedule.next_at).toLocaleString()}.` : ''}</p>
    <p className="text-sm">Refresh this selected calendar while the app is closed. Each complete download rolls the chosen window forward in {data.calendar.time_zone}. This updates saved event context without creating people, publishing plans, inviting anyone or logging interactions.</p>
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    <fieldset disabled={busy || uncertain} className="space-y-3">
      <legend className="sr-only">Automatic event choices</legend>
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={enabled} disabled={!data.can_download && !schedule.enabled} onChange={(e) => setEnabled(e.target.checked)} />Keep this calendar updated</label>
      <div><Label htmlFor="calendar-auto-interval">Refresh frequency</Label><select id="calendar-auto-interval" className="min-h-11 w-full rounded-md border bg-background px-3" value={interval} onChange={(e) => setInterval(e.target.value)}><option value="86400">Daily</option><option value="3600">Hourly</option></select></div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><div><Label htmlFor="calendar-auto-past">Automatic past days</Label><Input id="calendar-auto-past" type="number" inputMode="numeric" min="0" max="365" value={past} onChange={(e) => setPast(e.target.value)} /></div><div><Label htmlFor="calendar-auto-future">Automatic future days</Label><Input id="calendar-auto-future" type="number" inputMode="numeric" min="0" max="365" value={future} onChange={(e) => setFuture(e.target.value)} /></div></div>
      <p className="text-sm">At most 365 past and future days combined, plus today. Daily is recommended for personal use. The scheduler checks about every 15 minutes; the eligible time is not a delivery guarantee. For a different window, use a separate manual download within the same limits. Disabling retains saved relationships and the last complete view.</p>
      <Button disabled={!valid || !dirty || enabled && !data.can_download} onClick={() => setConfirm(true)}>Review automatic choices</Button>
    </fieldset>
    {uncertain && <div className="space-y-2"><p role="status">The save is unconfirmed. Check the saved choices or retry the same request before changing it.</p><Button variant="outline" disabled={busy} onClick={() => void reload()}>Check saved choices</Button><Button disabled={busy} onClick={() => void save()}>Retry unchanged automatic choices</Button></div>}
    <UnsavedChangesGuard active={dirty || busy || uncertain} onDiscard={() => window.location.reload()} />
    <ConfirmDialog open={confirm} onCancel={() => setConfirm(false)} title={enabled ? 'Enable automatic event downloads?' : 'Save automatic event choices?'} description={`${enabled ? 'Read' : 'Stop recurring reads for'} this calendar ${interval === '3600' ? 'hourly' : 'daily'} with ${past} past days and ${future} future days. Private details remain redacted. No invitations or completed interactions are created.`} safetyTone="recovery" safetyNote="A changed schedule cancels unfinished automatic downloads. Existing saved links and your private notes remain." confirmLabel="Save automatic choices" onConfirm={() => void save()} />
  </section>;
}
