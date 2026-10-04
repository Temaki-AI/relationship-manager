'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { getResponseErrorMessage } from '@/lib/utils';
import type { GoogleContactFacts } from '@/lib/cloud/google-contacts';

type Connection = { id: string; email: string; status: string; authorization_revision: number };
type Review = { generation: string | null; last_synced_at: string | null; count: number; items: GoogleContactFacts[]; next_after: string | null; import_available: boolean;
  schedule?: { enabled: boolean; interval: number; revision: number; next_at: number };
  run: null | { id: string; status: string; processed: number; phase?: string; reconciled?: number; skipped?: number; issue: string | null; retry_at: number } };
const ISSUES: Record<string, string> = { retry: 'Google is temporarily unavailable or limiting requests. The download will retry.',
  retry_exhausted: 'The download stopped after repeated failures. Start a fresh download when Google is available.',
  permission: 'Google Contacts access needs review. Reconnect the account before starting again.',
  invalid: 'Google returned a response this version cannot safely use. The previous address book was kept.',
  capacity: 'This version limits each downloaded address book to 20,000 contacts. The previous complete download was kept.',
  source_capacity: 'Some saved sources grew beyond the person’s source limit. Their previous details and values were kept; unlink an unused source before refreshing again.',
  schedule_changed: 'Automatic sync choices changed. This scheduled download was stopped.',
  connection_changed: 'The account changed. Review its connection before starting again.', dataset_changed: 'Recovery stopped this download.', cursor_expired: 'The saved Google cursor expired. A fresh address book is being downloaded.' };

export default function GoogleContactsReviewPage() {
  const { id } = useParams<{ id: string }>();
  const [connection, setConnection] = useState<Connection | null>(null), [epoch, setEpoch] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(''), [query, setQuery] = useState('');
  const [page, setPage] = useState<{ after: string; generation: string | null }>({ after: '', generation: null });
  const requests = useRef({ sequence: 0 }), operation = useRef<string | null>(null);
  const endpoint = '/api/connections/' + encodeURIComponent(id) + '/contacts';
  const load = useCallback(async () => {
    const sequence = ++requests.current.sequence;
    const parameters = new URLSearchParams({ q: query });
    if (page.after) { parameters.set('after', page.after); if (page.generation) parameters.set('generation', page.generation); }
    const [connections, contacts] = await Promise.all([fetch('/api/connections', { cache: 'no-store' }), fetch(endpoint + '?' + parameters, { cache: 'no-store' })]);
    if (sequence !== requests.current.sequence) return;
    if (!connections.ok) throw new Error(await getResponseErrorMessage(connections, 'Could not load this connection.'));
    const accounts = await connections.json() as { connections: Connection[]; epoch: string | null };
    if (sequence !== requests.current.sequence) return;
    const current = accounts.connections.find((c) => c.id === id) ?? null;
    setConnection(current); setEpoch(accounts.epoch);
    if (!contacts.ok) {
      const message = await getResponseErrorMessage(contacts, 'Could not load this address book.');
      if (sequence !== requests.current.sequence) return;
      if (current?.status !== 'connected') setReview(null);
      throw new Error(message);
    }
    const result = await contacts.json() as Review;
    if (sequence !== requests.current.sequence) return;
    if (result.run?.id === operation.current) operation.current = null;
    setReview(result); setError(null);
  }, [endpoint, id, query, page]);
  useEffect(() => {
    let mounted = true; const currentRequests = requests.current;
    load().catch((err) => { if (mounted) setError(err instanceof Error ? err.message : 'Could not load contacts.'); });
    return () => { mounted = false; currentRequests.sequence++; };
  }, [load]);
  useEffect(() => {
    if (review?.run?.status !== 'active' || busy || error) return;
    const timer = setTimeout(() => { load().catch((err) => setError(err instanceof Error ? err.message : 'Could not refresh the download.')); }, 5000);
    return () => clearTimeout(timer);
  }, [review, busy, error, load]);
  async function start() {
    if (!connection || !epoch) return;
    setBusy(true); setError(null); operation.current ||= crypto.randomUUID();
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation_id: operation.current,
        expected_epoch: epoch, expected_authorization_revision: connection.authorization_revision }) });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) operation.current = null;
        throw new Error(await getResponseErrorMessage(response, 'Could not start the download.'));
      }
      operation.current = null; setPage({ after: '', generation: null }); await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not start the download.'); }
    finally { setBusy(false); }
  }
  async function step() {
    if (!review?.run) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(endpoint + '/step', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: review.run.id }) });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not continue the download.'));
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not continue the download.'); }
    finally { setBusy(false); }
  }
  async function saveSchedule(enabled: boolean, interval: number) {
    if (!connection || !epoch || !review?.schedule) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(endpoint + '/schedule', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_epoch: epoch,
        expected_authorization_revision: connection.authorization_revision, expected_settings_revision: review.schedule.revision, enabled, interval }) });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not save automatic sync choices.'));
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save automatic sync.'); }
    finally { setBusy(false); }
  }
  const active = review?.run?.status === 'active';
  return <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-8">
    <Link href="/connections/google" className="inline-block py-3 underline">Back to Google connections</Link>
    <h1 className="text-2xl font-semibold">Review Google Contacts</h1>
    {connection && <p className="break-all text-muted-foreground">{connection.email}</p>}
    <p>Download this account’s address book to review names, email addresses and phone numbers. Linked sources are refreshed after download. Fields you chose to follow can update; your corrections and private notes are protected.</p>
    <p className="rounded-xl border p-4 text-sm">Review each contact to create a person or attach selected fields to an existing relationship. Choose which accepted fields follow Google from the person’s sources. This download does not edit Google contacts.</p>
    {error && <div role="alert" className="rounded-lg border border-red-300 p-3"><p>{error}</p><Button className="mt-3" variant="outline" disabled={busy} onClick={() => { setError(null); setPage({ after: '', generation: null }); }}>Reload review</Button></div>}
    {!review && !error && <p role="status">Loading address book…</p>}
    {review && <>
      {review.schedule && <section aria-label="Automatic Google Contacts downloads" className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">Automatic downloads</h2><label htmlFor="google-sync-frequency" className="block text-sm">Check Google for changes</label>
        <select id="google-sync-frequency" className="min-h-11 w-full rounded-md border bg-background px-3" disabled={busy} value={review.schedule.enabled ? review.schedule.interval : 0} onChange={(event) => void saveSchedule(Number(event.target.value) !== 0, Number(event.target.value) || review.schedule!.interval)}><option value={0}>Manual refresh only</option><option value={86400}>Daily</option><option value={3600}>Hourly</option></select>
        <p className="text-sm">This refreshes saved sources and fields you chose to follow. New people still require your review. Disconnecting or restoring a backup turns automatic downloads off.</p></section>}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy || active || connection?.status !== 'connected'} onClick={start}>{review.generation ? 'Refresh address book' : 'Download address book'}</Button>
        <p className="text-sm">{review.generation ? `${review.count} contacts in the last complete download` : 'No complete download yet.'}</p>
      </div>
      {review.last_synced_at && <p className="text-sm text-muted-foreground">Last completed: {new Date(review.last_synced_at).toLocaleString()}</p>}
      {review.run && <div role="status" className="space-y-2 rounded-lg border p-3 text-sm">
        <p>{active ? review.run.phase === 'reconcile' ? `Updating linked sources… ${review.run.reconciled ?? 0} checked.` : `Downloading… ${review.run.processed} provider records received.` : review.run.status === 'complete' ? 'Address book and linked sources updated.' : 'This download stopped. Your previous address book was kept.'}</p>
        {review.run.issue && <p>{ISSUES[review.run.issue] || 'This download needs review.'}</p>}
        {active && <Button variant="outline" disabled={busy || review.run.retry_at > Date.now()} onClick={step}>Continue download</Button>}
      </div>}
      {review.generation && <>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); setPage({ after: '', generation: null }); setQuery(search.trim()); }}>
          <div className="min-w-0 flex-1"><label htmlFor="google-contact-search" className="mb-1 block text-sm font-medium">Search name, email or phone</label>
            <input id="google-contact-search" className="h-11 w-full rounded-md border bg-background px-3" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} /></div>
          <Button type="submit" variant="outline">Search</Button>
        </form>
        <div className="space-y-3">{review.items.map((contact) => <article key={contact.sourceId} className="min-w-0 space-y-2 rounded-xl border p-4">
          <h2 className="break-words text-lg font-semibold">{contact.name || 'Unnamed Google contact'}</h2>
          {(contact.company || contact.title) && <p className="break-words text-sm">{[contact.title, contact.company].filter(Boolean).join(' · ')}</p>}
          {contact.location && <p className="break-words text-sm text-muted-foreground">{contact.location}</p>}
          {contact.emails.map((method, i) => <p key={'e' + i} className="break-all text-sm">{method.value}{method.label ? ` (${method.label})` : ''}</p>)}
          {contact.phones.map((method, i) => <p key={'p' + i} className="break-all text-sm">{method.value}{method.label ? ` (${method.label})` : ''}</p>)}
          {review.import_available && <Link className="inline-block py-3 underline" href={'/connections/google/' + encodeURIComponent(id) + '/contacts/import?' + new URLSearchParams({ generation: review.generation!, source_id: contact.sourceId })}>Choose how to save</Link>}
        </article>)}</div>
        {!review.items.length && <p>{query ? 'No matching Google contacts in this download.' : 'This downloaded address book is empty.'}</p>}
        <div className="flex flex-wrap gap-2">
          {page.after && <Button variant="outline" onClick={() => setPage({ after: '', generation: null })}>First page</Button>}
          {review.next_after && <Button variant="outline" disabled={active} onClick={() => setPage({ after: review.next_after!, generation: review.generation })}>Next contacts</Button>}
        </div>
      </>}
    </>}
  </div>;
}
