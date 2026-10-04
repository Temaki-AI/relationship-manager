'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { getResponseErrorMessage } from '@/lib/utils';

type Purpose = 'contacts' | 'calendar' | 'calendar-publish';
type Connection = { purpose?: Purpose; id: string; email: string; display_name: string; status: string; revision: number };
type Connections = { mode: 'local' | 'cloud'; configured: boolean; configured_purposes?: Record<Purpose, boolean>; epoch: string | null; connections: Connection[] };
const STATUS: Record<string, string> = {
  connected: 'Contacts access authorized', disconnected: 'Disconnected', reconnect_required: 'Reconnect required',
  dataset_review_required: 'Reconnect after recovery', revocation_pending: 'Access stopped · Google revocation pending',
};
export function GoogleConnectionsManager({ purpose = 'contacts' }: { purpose?: Purpose }) {
  const publishing = purpose === 'calendar-publish', calendar = purpose === 'calendar', noun = publishing ? 'Calendar publishing' : calendar ? 'Calendar' : 'Contacts';
  const basePath = '/connections/google' + (publishing ? '/publish' : calendar ? '/calendar' : '');
  const [data, setData] = useState<Connections | null>(null), [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null), [pending, setPending] = useState(false), [loading, setLoading] = useState(true);
  const [disconnect, setDisconnect] = useState<Connection | null>(null);
  const refresh = useCallback(async () => {
    const response = await fetch('/api/connections', { cache: 'no-store' });
    if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not load Google connections.'));
    setData(await response.json() as Connections);
  }, []);
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('result');
    if (result) {
      setNotice(result === 'connected' ? publishing ? 'Google Calendar publishing access is authorized. Review the optional Everclose calendar setup next; connecting does not create a calendar.' : `Google ${noun} access is authorized. Review its ${calendar ? 'calendars' : 'address book'} next; connecting does not copy people or events.`
        : 'Google connection was cancelled, expired or could not be saved. Your people were kept. Try connecting again.');
      window.history.replaceState(null, '', basePath);
    }
    let active = true;
    refresh().catch((err) => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh, basePath, noun, calendar, publishing]);
  async function connect(connection?: Connection) {
    if (!data) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const response = await fetch('/api/connections/google/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose, expected_epoch: data.epoch, ...(connection ? { connection_id: connection.id, expected_revision: connection.revision } : {}) }) });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not start Google authorization.'));
      const url = new URL((await response.json()).authorization_url);
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password) throw new Error('Invalid Google authorization response.');
      window.location.assign(url.href);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not connect Google.'); setPending(false); }
  }
  async function stop(connection: Connection) {
    setPending(true); setError(null); setNotice(null);
    let saved = false;
    try {
      const response = await fetch('/api/connections/' + connection.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: connection.revision }) });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not disconnect this account.'));
      const result = await response.json(); saved = true; setDisconnect(null);
      setNotice(result.revocation_pending ? 'Everclose access is stopped. Google has not confirmed revocation yet. Retry revocation here or remove access in your Google account.'
        : 'Disconnected. Your CRM people, notes and history were kept.');
      await refresh();
    } catch (err) { setError((saved ? 'Access was stopped, but the list could not refresh. ' : '') + (err instanceof Error ? err.message : 'Could not disconnect Google.')); }
    finally { setPending(false); }
  }
  const canConnect = data?.mode === 'cloud' && (data.configured_purposes?.[purpose] ?? (purpose === 'contacts' && data.configured)) && Boolean(data.epoch);
  const connections = data?.connections.filter((connection) => (connection.purpose ?? 'contacts') === purpose) ?? [];
  return <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-8">
    <Link href="/integrations" className="inline-block py-3 underline">Back to data connections</Link>
    <h1 className="text-2xl font-semibold">Google {noun} connections</h1>
    <p>Authorize a personal or work Google account separately from signing in to Everclose. Each account has its own connection.</p>
    <div className="rounded-xl border bg-muted/30 p-4 text-sm leading-relaxed">
      <p>{publishing ? 'Requested access: create secondary calendars and manage events on calendars created by this app; read calendar-list details and basic account identity.' : `Requested access: read-only Google ${noun} and basic account identity.`} {calendar ? 'The calendar list and event scopes are separate from Contacts and Gmail.' : publishing ? 'Publishing has separate consent from Calendar reading, Contacts and Gmail.' : 'Gmail and Calendar each need separate permission.'}</p>
      <p className="mt-2">{publishing ? 'After connecting, optionally set up a dedicated Everclose calendar. Setup creates an empty calendar after your confirmation. Choose an open plan after setup, review its event details and confirm any Google invitations.' : calendar ? 'After connecting, discover calendars and choose which can supply event context. Open a saved calendar to explicitly download its events. Calendar choice does not download events, publish plans or notify invitees.' : 'After connecting, download the address book for review. Import selected people and enable updates explicitly. Connecting alone does not copy people or change Google contacts.'}</p>
    </div>
    {notice && <p role="status" className="rounded-lg border p-3 text-sm">{notice}</p>}
    {error && <div role="alert" className="rounded-lg border border-red-300 p-3 text-sm"><p>{error}</p><Button variant="outline" className="mt-3" disabled={pending} onClick={() => { setError(null); refresh().catch((err) => setError(err.message)); }}>Refresh connections</Button></div>}
    {loading ? <p role="status">Loading connections…</p> : data && <>
      {!canConnect && <p className="text-sm text-muted-foreground">{data.mode === 'local' ? 'Google connections use the cloud workspace. This self-hosted workspace supports file transfers.' : 'Google connection setup is not available on this server yet.'}</p>}
      <Button disabled={!canConnect || pending} onClick={() => connect()}>{publishing ? 'Connect Calendar publishing' : calendar ? 'Connect Google Calendar' : 'Connect a Google account'}</Button>
      {connections.length === 0 && <p>No Google accounts connected.</p>}
      <div className="space-y-4">{connections.map((connection) => <article key={connection.id} className="min-w-0 rounded-xl border p-4">
        <h2 className="break-words text-lg font-semibold">{connection.display_name}</h2>
        <p className="break-all text-sm text-muted-foreground">{connection.email}</p>
        <p className="mt-2 text-sm">{connection.status === 'connected' ? `${noun} access authorized` : STATUS[connection.status] || 'Connection needs review'}</p>
        {connection.status === 'dataset_review_required' && <p className="mt-2 text-sm">Recovery paused this source. Reconnect before continuing; your Google {calendar || publishing ? 'calendar' : 'address book'} was not rolled back.</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          {(connection.status === 'connected' || publishing) && <Link className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium underline" href={'/connections/google/' + connection.id + (publishing ? '/publish' : calendar ? '/calendars' : '/contacts')}>{publishing ? 'Review Everclose calendar setup' : calendar ? 'Review calendars' : 'Review address book'}</Link>}
          {connection.status !== 'revocation_pending' && <Button variant="outline" disabled={!canConnect || pending} onClick={() => connect(connection)}>{connection.status === 'connected' ? 'Reauthorize' : 'Reconnect'}</Button>}
          {connection.status !== 'disconnected' && <Button variant="outline" disabled={pending} onClick={() => connection.status === 'revocation_pending' ? stop(connection) : setDisconnect(connection)}>{connection.status === 'revocation_pending' ? 'Retry Google revocation' : 'Disconnect'}</Button>}
        </div>
      </article>)}</div>
    </>}
    <Link className="inline-block py-3 underline" href={calendar ? '/connections/google' : '/connections/google/calendar'}>{calendar ? 'Manage Google Contacts' : 'Manage Google Calendar'}</Link>
    {!publishing && <Link className="block py-3 underline" href="/connections/google/publish">Manage Calendar publishing</Link>}
    <ConfirmDialog open={disconnect !== null} title={`Disconnect Google ${noun}?`} description={`Stop this ${noun} connection and ask Google to revoke authorization. Google revocation can also invalidate connections in the same Cloud project; those connections may need reconnecting.`}
      safetyNote="Your CRM people, private notes and history stay in Everclose." safetyTone="recovery" confirmLabel="Disconnect account" pending={pending}
      onCancel={() => setDisconnect(null)} onConfirm={() => { if (disconnect) void stop(disconnect); }} />
  </div>;
}
