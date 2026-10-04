'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { getResponseErrorMessage } from '@/lib/utils';
import { isSyncUuid } from '@/packages/domain/src/sync';
import type { reviewOwnedCalendar } from '@/lib/cloud/google-owned-calendar';

type Review = Awaited<ReturnType<typeof reviewOwnedCalendar>>;
type Preparation = { operation_id: string; expected_epoch: string; expected_authorization_revision: number; time_zone: string };
const ISSUES: Record<string, string> = {
  retry: 'Google did not confirm the result. Verification will look for the original calendar.',
  not_visible: 'The original calendar was not found in the available calendar list. It may be delayed, hidden from access or removed. Another calendar will not be created.',
  ambiguous: 'More than one calendar matched this setup. Review them in Google Calendar before continuing.',
  invalid: 'The Google result could not be verified. Check the calendar and its access in Google Calendar.',
  authorization_changed: 'Access changed. Reconnect publishing and verify the original calendar.',
  dataset_changed: 'Recovery paused this setup. Reconnect publishing before verifying the original calendar.',
};
export function GoogleOwnedCalendarSetup({ connectionId }: { connectionId: string }) {
  const endpoint = '/api/connections/' + encodeURIComponent(connectionId) + '/owned-calendar', storageKey = 'everclose-calendar-setup:' + connectionId;
  const [review, setReview] = useState<Review | null>(null), [timeZone, setTimeZone] = useState('Europe/Lisbon');
  const [unconfirmed, setUnconfirmed] = useState<Preparation | null>(null), [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<'prepare' | 'create' | 'discard' | null>(null);
  const stored = useCallback(() => {
    const raw = sessionStorage.getItem(storageKey); if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Preparation;
      if (Object.keys(value).length === 4 && isSyncUuid(value.operation_id) && isSyncUuid(value.expected_epoch)
        && Number.isSafeInteger(value.expected_authorization_revision) && typeof value.time_zone === 'string' && value.time_zone.length <= 100) return value;
    } catch { /* Invalid browser storage is never sent to the service. */ }
    throw new Error('The retained setup request could not be read. Keep this tab and review server status before continuing.');
  }, [storageKey]);
  const refresh = useCallback(async () => {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not review calendar setup.'));
    const data = await response.json() as Review, retained = stored();
    if (retained && data.setup) {
      sessionStorage.removeItem(storageKey); setUnconfirmed(null);
      if (data.setup.operation_id !== retained.operation_id) setNotice('A different reviewed setup already exists for this account. Review its current status before continuing.');
    }
    else setUnconfirmed(retained);
    setReview(data); return data;
  }, [endpoint, storageKey, stored]);
  useEffect(() => {
    let active = true;
    try { setUnconfirmed(stored()); setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Lisbon'); } catch (err) { setError((err as Error).message); }
    refresh().catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [refresh, stored]);
  async function mutate(method: string, body: unknown, step = false) {
    const response = await fetch(endpoint + (step ? '/step' : ''), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw Object.assign(new Error(await getResponseErrorMessage(response, 'Calendar setup was not confirmed. Refresh its status before continuing.')), { status: response.status });
  }
  async function prepare(retained?: Preparation) {
    if (!review) return;
    setPending(true); setError(null); setNotice(null); setConfirmation(null);
    const body = retained ?? { operation_id: crypto.randomUUID(), expected_epoch: review.epoch, expected_authorization_revision: review.authorization_revision, time_zone: timeZone };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(body)); setUnconfirmed(body);
      await mutate('POST', body); await refresh(); setNotice('Setup saved. Review the next confirmation to create an empty Everclose calendar.');
    } catch (err) {
      if ((err as Error & { status?: number }).status === 400) {
        sessionStorage.removeItem(storageKey); setUnconfirmed(null);
        await refresh().catch(() => { /* The rejected local preparation never creates a Google calendar. */ });
      }
      setError((err as Error).message);
    }
    finally { setPending(false); }
  }
  async function advance() {
    if (!review?.setup) return;
    setPending(true); setError(null); setNotice(null); setConfirmation(null);
    try {
      await mutate('POST', { operation_id: review.setup.operation_id, expected_revision: review.setup.revision,
        expected_epoch: review.epoch, expected_authorization_revision: review.authorization_revision }, true);
      const current = await refresh();
      setNotice(current.setup?.status === 'ready' ? 'The Everclose calendar was verified. No events or invitations were created.' : 'The result is still unconfirmed. The original setup is retained for verification.');
    } catch (err) { setError((err as Error).message); }
    finally { setPending(false); }
  }
  async function discard() {
    if (!review?.setup) return;
    setPending(true); setError(null); setConfirmation(null);
    try { await mutate('DELETE', { operation_id: review.setup.operation_id, expected_revision: review.setup.revision }); await refresh(); setNotice('Unsent setup discarded.'); }
    catch (err) { setError((err as Error).message); }
    finally { setPending(false); }
  }
  const setup = review?.setup;
  return <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-8">
    <Link className="inline-block py-3 underline" href="/connections/google/publish">Back to Calendar publishing</Link>
    <h1 className="text-2xl font-semibold">Everclose calendar setup</h1>
    <p>Create an optional, dedicated calendar in your Google account. Plan publishing is still in development.</p>
    {review && <p className="break-all text-sm">Google account: {review.email}</p>}
    {notice && <p role="status" className="rounded-lg border p-3">{notice}</p>}
    {error && <p role="alert" className="rounded-lg border border-red-300 p-3">{error}</p>}
    <Button variant="outline" disabled={pending} onClick={() => { setError(null); refresh().catch((err) => setError(err.message)); }}>Refresh setup status</Button>
    {!review && <p role="status">Loading calendar setup…</p>}
    {review && !review.can_continue && <p>Reconnect Calendar publishing before continuing. <Link href="/connections/google/publish" className="underline">Review access</Link></p>}
    {unconfirmed && <div className="space-y-3 rounded-xl border p-4"><p>The setup save is unconfirmed. Retry the same request or refresh its status before changing the timezone.</p><p>Chosen timezone: {unconfirmed.time_zone}</p><Button disabled={pending || !review?.can_continue} onClick={() => prepare(unconfirmed)}>Retry setup save</Button></div>}
    {review && !setup && !unconfirmed && <div className="space-y-3 rounded-xl border p-4">
      <label htmlFor="calendar-setup-timezone" className="block font-medium">Calendar timezone</label>
      <input id="calendar-setup-timezone" className="min-h-11 w-full min-w-0 rounded-md border bg-background px-3" value={timeZone} disabled={pending} onChange={(event) => setTimeZone(event.target.value)} placeholder="Europe/Lisbon" />
      <p className="text-sm">Name: Everclose. Saving this review prepares setup; the next confirmation creates the empty calendar.</p>
      <Button disabled={pending || !review.can_continue || !timeZone.trim()} onClick={() => setConfirmation('prepare')}>Review calendar setup</Button>
    </div>}
    {setup && <article className="space-y-3 rounded-xl border p-4">
      <h2 className="text-lg font-semibold">{setup.status === 'ready' ? 'Calendar verified' : setup.attempted ? 'Original calendar needs verification' : 'Reviewed setup'}</h2>
      <p className="break-words">Chosen setup timezone: {setup.chosen_time_zone}</p>
      {setup.issue && <p>{ISSUES[setup.issue] ?? 'Review access and verify this retained setup before continuing.'}</p>}
      {review?.unsent_access_changed && <p>This unsent setup belongs to earlier access. Discard it and review a fresh setup.</p>}
      {setup.attempted && <p className="text-sm">Further attempts only verify the original calendar. If it cannot be found, review Google Calendar and your publishing access; another calendar will not be created.</p>}
      <div className="flex flex-wrap gap-3">
        <Button disabled={pending || Boolean(unconfirmed) || !review?.can_continue || review.unsent_access_changed} onClick={() => setup.attempted ? advance() : setConfirmation('create')}>{setup.attempted ? 'Verify original calendar' : 'Create empty calendar'}</Button>
        {!setup.attempted && <Button variant="outline" disabled={pending || Boolean(unconfirmed)} onClick={() => setConfirmation('discard')}>Discard unsent setup</Button>}
        {setup.status === 'ready' && <Link className="inline-flex min-h-11 items-center px-3 underline" href={`/connections/google/${connectionId}/plans`}>Publish a plan</Link>}
        {setup.calendar_id && <a className="inline-flex min-h-11 items-center px-3 underline" href="https://calendar.google.com/calendar/u/0/r" target="_blank" rel="noopener noreferrer">Open Google Calendar</a>}
      </div>
    </article>}
    <ConfirmDialog open={confirmation !== null} pending={pending} title={confirmation === 'prepare' ? 'Save this calendar setup?' : confirmation === 'create' ? 'Create an empty Everclose calendar?' : 'Discard this unsent setup?'}
      description={confirmation === 'prepare' ? `Save a review for ${review?.email} with timezone ${timeZone}. This step does not contact Google to create a calendar.` : confirmation === 'create' ? `Create one empty secondary calendar named Everclose in ${review?.email}, with the reviewed timezone ${setup?.chosen_time_zone}.` : 'Remove only the setup that has not been sent to Google.'}
      safetyNote="No people, plan events, invitations or private CRM notes are added to Google by this setup." safetyTone="recovery"
      confirmLabel={confirmation === 'prepare' ? 'Save reviewed setup' : confirmation === 'create' ? 'Confirm calendar creation' : 'Discard setup'}
      onCancel={() => setConfirmation(null)} onConfirm={() => { if (confirmation === 'prepare') void prepare(); else if (confirmation === 'create') void advance(); else if (confirmation === 'discard') void discard(); }} />
  </div>;
}
