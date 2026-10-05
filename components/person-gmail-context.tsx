'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { GMAIL_CONTEXT_MAX_BYTES, readGmailContextManifest, readGmailContextPage, type GmailContextManifest, type GmailContextMessage } from '@/packages/domain/src/gmail-context';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';

export function PersonGmailContext({ personId, refreshKey }: { personId: string; refreshKey: object }) {
  const [sourceId, setSourceId] = useState(''), [reload, setReload] = useState(0), [after, setAfter] = useState<string | null>(null);
  const key = JSON.stringify([personId, sourceId, reload, after]);
  const [saved, setSaved] = useState<{ key: string; manifest: GmailContextManifest; messages: GmailContextMessage[]; next: string | null } | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(3);
  useEffect(() => {
    const controller = new AbortController(); let alive = true, checkedScope: string | null = null;
    const hide = () => { setSaved(null); setAfter(null); setReload((value) => value + 1); };
    const visibility = () => { if (document.visibilityState === 'hidden') { alive = false; controller.abort(); setSaved(null); } else hide(); };
    document.addEventListener('visibilitychange', visibility);
    async function request(query = new URLSearchParams()) {
      const response = await fetch('/api/v1/gmail-context' + (query.size ? '?' + query : ''), { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Could not refresh reviewed email context.');
      const raw = await response.text(); if (new TextEncoder().encode(raw).byteLength > GMAIL_CONTEXT_MAX_BYTES) throw new Error('Email context is too large. Review this mailbox separately.');
      return JSON.parse(raw) as unknown;
    }
    async function load() {
      setLoading(true); setError(''); setSaved(null);
      try {
        const manifest = readGmailContextManifest(await request());
        const source = manifest.sources.find((source) => source.id === sourceId) ?? manifest.sources[0];
        if (source && source.id !== sourceId) { if (alive) { setAfter(null); setSourceId(source.id); } return; }
        let messages: GmailContextMessage[] = [], next: string | null = null;
        if (source && manifest.directory_ready) {
          const query = new URLSearchParams({ scope: manifest.scope, source_id: source.id, person_id: personId }); if (after) query.set('after', after);
          const page = readGmailContextPage(await request(query), manifest, source.id, personId);
          const checked = readGmailContextManifest(await request());
          if (checked.scope !== manifest.scope || checked.valid_until <= Date.now()) throw new Error('Email review changed. Refresh this profile.');
          messages = page.messages; next = page.next;
        }
        if (alive && !controller.signal.aborted) { checkedScope = manifest.scope; setSaved({ key, manifest, messages, next }); }
      } catch (err) { if (alive && !controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not read reviewed email context.'); }
      finally { if (alive && !controller.signal.aborted) setLoading(false); }
    }
    void load();
    const timer = setInterval(() => { void (async () => {
      try { const fresh = readGmailContextManifest(await request()); if (alive && fresh.scope !== checkedScope) hide(); }
      catch { if (alive && !controller.signal.aborted) { checkedScope = null; setSaved(null); setError('Connect to refresh reviewed email context.'); } }
    })(); }, 30000);
    return () => { alive = false; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [personId, refreshKey, sourceId, key, after]);
  const value = saved?.key === key ? saved : null;
  return <Card className="border-0 shadow-sm"><CardContent className="space-y-3 pt-5 pb-4">
    <h2 className="text-sm font-semibold">Reviewed email context</h2>
    <p className="text-xs text-muted-foreground">Observed Gmail metadata stays separate from confirmed interactions and your last-contacted date.</p>
    {loading && <p role="status" className="text-sm">Loading reviewed email context…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!loading && !error && value && <>
      {value.manifest.sources.length > 0 && <label className="block text-sm">Mailbox<select aria-label="Email context mailbox" className="mt-1 min-h-11 w-full rounded border bg-background p-2" value={sourceId} onChange={(event) => { setAfter(null); setVisible(3); setSourceId(event.target.value); }}>{value.manifest.sources.map((source) => <option key={source.id} value={source.id}>{source.email}</option>)}</select></label>}
      {!value.manifest.directory_ready ? <p className="text-sm text-muted-foreground">Matching contact email identities. Refresh shortly.</p> : value.messages.length ? <ul className="space-y-3">{value.messages.slice(0, visible).map((message) => <li key={message.id} className="space-y-1 rounded border p-3 text-sm">
        <p>{message.direction === 'incoming' ? 'Received email' : message.direction === 'outgoing' ? 'Sent email' : 'Observed email'} · {new Date(message.received_at).toLocaleString()}</p>
        <p className="break-words">{message.subject ?? 'Subject not retained'}</p><p className="break-all text-xs text-muted-foreground">{message.linked_addresses.join(', ')}</p>
      </li>)}</ul> : <p className="text-sm text-muted-foreground">No reviewed correspondence in this mailbox’s saved window. Connect Gmail, download metadata and confirm the person match.</p>}
      {visible < value.messages.length && <Button variant="outline" onClick={() => setVisible(value.messages.length)}>Show all {value.messages.length} reviewed messages on this page</Button>}
      {value.next && visible >= value.messages.length && <Button variant="outline" onClick={() => { setVisible(3); setAfter(value.next); }}>Older reviewed messages</Button>}
    </>}
    <Button variant="outline" disabled={loading} onClick={() => { setAfter(null); setReload((value) => value + 1); }}>Refresh email context</Button>
    <Link className="inline-flex min-h-11 items-center text-sm underline" href="/connections/google/gmail">Connect or review Gmail</Link>
  </CardContent></Card>;
}
