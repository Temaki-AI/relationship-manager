'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getResponseErrorMessage } from '@/lib/utils';
import type { GmailConnectionReview } from '@/lib/cloud/google-gmail-connection';
import { GoogleGmailDownloads } from './google-gmail-downloads';
import { GoogleGmailMatching } from './google-gmail-matching';

type Preview = { email: string; labels: Array<{ id: string; name: string; type: 'system' | 'user' }> };
export function GoogleGmailMailbox({ connectionId }: { connectionId: string }) {
  return <Mailbox key={connectionId} connectionId={connectionId} />;
}
function Mailbox({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<GmailConnectionReview | null>(null), [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true), [pending, setPending] = useState(false);
  const [search, setSearch] = useState(''), [limit, setLimit] = useState(50);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]), [downloadPending, setDownloadPending] = useState(false);
  const [matchingPending, setMatchingPending] = useState(false);
  const alive = useRef(false), sequence = useRef(0), busy = useRef(false);
  const read = useCallback(async () => {
    const response = await fetch('/api/connections/' + connectionId + '/gmail', { cache: 'no-store' });
    if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not load this Gmail account.'));
    return await response.json() as GmailConnectionReview;
  }, [connectionId]);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const value = await read();
      if (!alive.current || sequence.current !== request) return;
      setData(value); setPreview(null); setError(null);
    } catch (err) {
      if (alive.current && sequence.current === request) { setPreview(null); setData(null); setError(err instanceof Error ? err.message : 'Could not load this Gmail account.'); }
    } finally { if (alive.current && sequence.current === request) setLoading(false); }
  }, [read]);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [refresh]);
  const savedLabels = JSON.stringify(data?.can_preview ? data.source?.choices.label_ids ?? [] : []);
  useEffect(() => { setSelectedLabels(JSON.parse(savedLabels)); }, [savedLabels, data?.epoch, data?.connection.authorization_revision]);
  const updateReview = useCallback((fresh: GmailConnectionReview) => {
    setData((previous) => {
      if (!fresh.can_preview || fresh.epoch !== previous?.epoch || fresh.connection.authorization_revision !== previous?.connection.authorization_revision) setPreview(null);
      return fresh;
    });
  }, []);
  const unavailable = useCallback(() => { setData(null); setPreview(null); setError('The Gmail account could not be verified. Refresh it before continuing.'); }, []);
  async function loadLabels() {
    if (!data?.can_preview || busy.current || downloadPending || matchingPending) return;
    busy.current = true; const request = ++sequence.current, opening = data;
    setPending(true); setError(null); setPreview(null);
    try {
      const response = await fetch('/api/connections/' + connectionId + '/gmail', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_epoch: opening.epoch, expected_authorization_revision: opening.connection.authorization_revision }) });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not preview mailbox labels.'));
      const value = await response.json() as Preview, fresh = await read();
      if (!alive.current || sequence.current !== request) return;
      setData(fresh);
      if (!fresh.can_preview || fresh.epoch !== opening.epoch || fresh.connection.authorization_revision !== opening.connection.authorization_revision
        || value.email !== fresh.connection.email.normalize('NFC').toLowerCase() || !Array.isArray(value.labels) || value.labels.length > 1000) {
        throw new Error('The Gmail account changed. Refresh and review it before previewing again.');
      }
      setPreview(value); setLimit(50); setSearch('');
    } catch (err) {
      if (alive.current && sequence.current === request) {
        setPreview(null); setError(err instanceof Error ? err.message : 'Could not preview mailbox labels.');
        try { const fresh = await read(); if (alive.current && sequence.current === request) setData(fresh); }
        catch { if (alive.current && sequence.current === request) setData(null); }
      }
    } finally { busy.current = false; if (alive.current && sequence.current === request) setPending(false); }
  }
  const needle = search.trim().normalize('NFC').toLowerCase();
  const labels = preview?.labels.filter((label) => label.name.normalize('NFC').toLowerCase().includes(needle) || label.id.toLowerCase().includes(needle)) ?? [];
  return <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-8">
    <Link className="inline-block min-h-11 py-3 underline" href="/connections/google/gmail">Back to Gmail connections</Link>
    <h1 className="text-2xl font-semibold">Gmail mailbox preview</h1>
    <p>This preview reads the connected mailbox identity and its labels. It does not import messages, create people or change private relationship notes.</p>
    {error && <p role="alert" className="rounded-lg border border-red-300 p-3 text-sm">{error}</p>}
    {loading ? <p role="status">Loading Gmail account…</p> : <>
      {data && <div className="min-w-0 rounded-xl border p-4">
        <h2 className="break-words text-lg font-semibold">{data.connection.display_name}</h2>
        <p className="break-all text-sm text-muted-foreground">{data.connection.email}</p>
        {!data.can_preview && <p className="mt-3 text-sm">This connection needs review, reconnection or completion of workspace recovery before a new preview.</p>}
      </div>}
      <div className="flex flex-wrap gap-3">
        <Button className="min-h-11" disabled={!data?.can_preview || pending || downloadPending || matchingPending} onClick={() => void loadLabels()}>{pending ? 'Reading mailbox labels…' : 'Preview mailbox labels'}</Button>
        <Button className="min-h-11" variant="outline" disabled={pending || downloadPending || matchingPending} onClick={() => void refresh()}>Refresh account</Button>
      </div>
    </>}
    {preview && <section aria-labelledby="gmail-labels-heading" className="space-y-3">
      <h2 id="gmail-labels-heading" className="text-lg font-semibold">Mailbox labels</h2>
      <p role="status" className="text-sm">{preview.labels.length} labels loaded. No messages imported.</p>
      <div className="space-y-2"><label htmlFor="gmail-label-search" className="text-sm font-medium">Find a label</label>
        <Input id="gmail-label-search" value={search} maxLength={200} onChange={(event) => { setSearch(event.target.value); setLimit(50); }} /></div>
      {labels.length === 0 ? <p>No matching labels.</p> : <ul className="space-y-2">{labels.slice(0, limit).map((label) => <li key={label.id} className="min-w-0 rounded-lg border p-3">
        <p className="break-words font-medium">{label.name}</p><p className="text-sm text-muted-foreground">{label.type === 'system' ? 'Gmail label' : 'Your label'}</p>
        {!['SPAM', 'TRASH', 'DRAFT'].includes(label.id) && <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" aria-label={'Use label ' + label.name} checked={selectedLabels.includes(label.id)}
          disabled={pending || downloadPending || matchingPending || !selectedLabels.includes(label.id) && selectedLabels.length >= 20}
          onChange={(event) => setSelectedLabels((ids) => event.target.checked ? [...ids, label.id] : ids.filter((id) => id !== label.id))} />Use for metadata downloads</label>}
      </li>)}</ul>}
      {labels.length > limit && <Button className="min-h-11" variant="outline" onClick={() => setLimit(limit + 50)}>Show more labels</Button>}
    </section>}
    {data?.can_preview && <GoogleGmailDownloads key={data.epoch + ':' + data.connection.authorization_revision} review={data} labelIds={selectedLabels}
      setLabelIds={setSelectedLabels} onReview={updateReview} onPending={setDownloadPending} labelPreviewPending={pending || matchingPending} onUnavailable={unavailable} />}
    {data?.can_preview && <GoogleGmailMatching key={[data.epoch, data.connection.authorization_revision, data.source?.settings_revision, data.source?.generation].join(':')}
      review={data} disabled={pending || downloadPending} onReview={updateReview} onPending={setMatchingPending} onUnavailable={unavailable} />}
  </div>;
}
