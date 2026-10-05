'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getResponseErrorMessage } from '@/lib/utils';
import type { GmailConnectionReview } from '@/lib/cloud/google-gmail-connection';
import { readGmailChoices, type GmailChoices, type GmailDownloadRun, type GmailMessagePage } from '@/packages/domain/src/gmail';

type Props = { review: GmailConnectionReview; labelIds: string[]; setLabelIds: (ids: string[]) => void;
  onReview: (review: GmailConnectionReview) => void; onPending: (pending: boolean) => void; labelPreviewPending: boolean;
  onUnavailable: () => void };
const issues: Record<string, string> = {
  provider_retry: 'Gmail asked us to wait. Continue after the retry time.',
  history_repair_required: 'Gmail no longer has the saved change history. Start a new full scan; the previous download was kept.',
  download_expired: 'This download expired. Start a new full scan; the previous download was kept.',
  history_limit: 'Too many changes arrived for this scan limit. Review a larger limit or start a new full scan.',
  mailbox_identity_changed: 'The mailbox identity changed. Reconnect and review this account.',
  unsupported_or_over_limit: 'The provider response could not be safely completed within the limits. Review the account and start a new scan.',
};
export function GoogleGmailDownloads({ review, labelIds, setLabelIds, onReview, onPending, labelPreviewPending, onUnavailable }: Props) {
  const source = review.source, endpoint = '/api/connections/' + review.connection.id + '/gmail';
  const [aliases, setAliases] = useState(''), [days, setDays] = useState('90'), [scan, setScan] = useState('1000');
  const [mode, setMode] = useState<GmailChoices['mode']>('existing_people'), [subjects, setSubjects] = useState(false);
  const [confirmation, setConfirmation] = useState<GmailChoices | null>(null), [page, setPage] = useState<GmailMessagePage | null>(null);
  const [error, setError] = useState(''), [pending, setPending] = useState(false), [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<GmailDownloadRun | null>(null);
  const [, updateClock] = useState(0);
  const alive = useRef(false), busy = useRef(false), sequence = useRef(0), startRequest = useRef<Record<string, unknown> | null>(null);
  const savedChoices = JSON.stringify(source?.choices ?? null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; onPending(false); }; }, [onPending]);
  useEffect(() => { onPending(pending || confirmation !== null || starting); }, [pending, confirmation, starting, onPending]);
  useEffect(() => {
    const choices = JSON.parse(savedChoices) as GmailChoices | null;
    setAliases(choices?.own_addresses.filter((address) => address !== review.connection.email.normalize('NFC').toLowerCase()).join('\n') ?? '');
    setDays(String(choices?.past_days ?? 90)); setScan(String(choices?.scan_limit ?? 1000));
    setMode(choices?.mode ?? 'existing_people'); setSubjects(choices?.retain_subject ?? false); setConfirmation(null);
    startRequest.current = null; setStarting(false);
  }, [source?.settings_revision, savedChoices, review.connection.email]);
  useEffect(() => { setPage(null); }, [source?.generation, source?.settings_revision]);
  useEffect(() => {
    const retry = source?.run?.retry_at ?? 0;
    if (retry <= Date.now()) return;
    const timer = setTimeout(() => updateClock((value) => value + 1), Math.min(retry - Date.now() + 50, 2147483647));
    return () => clearTimeout(timer);
  }, [source?.run?.retry_at]);
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(endpoint + path, { method, cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not complete this Gmail action.'));
    return response.json();
  }
  async function freshReview() {
    const fresh = await request('') as GmailConnectionReview;
    if (!alive.current) return null;
    onReview(fresh);
    if (!fresh.can_preview || fresh.epoch !== review.epoch || fresh.connection.authorization_revision !== review.connection.authorization_revision) {
      setPage(null); throw new Error('Gmail authorization changed. Refresh and review this account.');
    }
    if (fresh.source?.run?.id === startRequest.current?.operation_id) { startRequest.current = null; setStarting(false); }
    return fresh;
  }
  async function run(action: (token: number) => Promise<(fresh: GmailConnectionReview) => void>) {
    if (busy.current) return;
    busy.current = true; const token = ++sequence.current;
    setPending(true); onPending(true); setError(''); setProgress(null);
    try {
      const finish = await action(token), fresh = await freshReview();
      if (alive.current && sequence.current === token && fresh) finish(fresh);
    } catch (err) {
      if (alive.current && sequence.current === token) {
        setPage(null); setError(err instanceof Error ? err.message : 'Could not complete this Gmail action.');
        try { await freshReview(); } catch { if (alive.current) { setPage(null); onUnavailable(); } }
      }
    } finally {
      busy.current = false;
      if (alive.current && sequence.current === token) { setPending(false); setProgress(null); }
    }
  }
  function choices() {
    return readGmailChoices({ label_ids: labelIds, own_addresses: aliases.split(/[\n,]/u).map((value) => value.trim()).filter(Boolean),
      mode, past_days: Number(days), scan_limit: Number(scan), retain_subject: subjects }, review.connection.email);
  }
  function save(value: GmailChoices) {
    void run(async () => {
      await request('/settings', 'PATCH', { choices: value, expected_epoch: review.epoch,
        expected_authorization_revision: review.connection.authorization_revision, expected_settings_revision: source?.settings_revision ?? 0 });
      return () => { setConfirmation(null); setPage(null); };
    });
  }
  function reviewChoices() {
    try {
      const value = choices(); setError('');
      if (source && JSON.stringify(value) !== JSON.stringify(source.choices)) setConfirmation(value);
      else save(value);
    } catch (err) { setError(err instanceof Error ? err.message : 'Review the download choices.'); }
  }
  function start(downloadMode: 'full' | 'incremental') {
    if (!source) return;
    startRequest.current ??= { operation_id: crypto.randomUUID(), mode: downloadMode, expected_epoch: review.epoch,
      expected_authorization_revision: review.connection.authorization_revision, expected_settings_revision: source.settings_revision };
    setStarting(true);
    void run(async () => {
      await request('/downloads', 'POST', startRequest.current);
      return () => { startRequest.current = null; setStarting(false); };
    });
  }
  function advance() {
    const current = source?.run; if (!current || current.status !== 'active') return;
    void run(async (token) => {
      // A user action advances at most ten durable steps. Leaving the page stops
      // further requests; reload discovers the persisted run without rereading Gmail.
      for (let step = 0; step < 10 && alive.current && sequence.current === token; step++) {
        const next = await request('/downloads/' + current.id + '/step', 'POST', {}) as GmailDownloadRun;
        if (alive.current && sequence.current === token) setProgress(next);
        if (next.status !== 'active' || next.retry_at > Date.now()) break;
      }
      return () => {};
    });
  }
  function messages(more = false) {
    if (!source?.generation || more && (!page?.next || page.generation !== source.generation)) return;
    const generation = source.generation, query = new URLSearchParams({ generation });
    if (more) query.set('after', page!.next!);
    void run(async () => {
      const result = await request('/messages?' + query) as GmailMessagePage;
      return (fresh) => {
        if (fresh.source?.generation !== generation || result.generation !== generation) throw new Error('Gmail messages changed. Show the first page again.');
        setPage({ ...result, messages: more && page?.generation === generation ? [...page.messages, ...result.messages] : result.messages });
      };
    });
  }
  let dirty = true;
  try { dirty = JSON.stringify(choices()) !== JSON.stringify(source?.choices); } catch { /* Invalid form choices stay unsaved. */ }
  const current = progress ?? source?.run, active = current?.status === 'active', disabled = pending || confirmation !== null || starting || labelPreviewPending;
  return <section aria-labelledby="gmail-downloads-heading" className="space-y-4 rounded-xl border p-4">
    <h2 id="gmail-downloads-heading" className="text-lg font-semibold">Gmail metadata downloads</h2>
    <p className="text-sm">Choose up to 20 labels from the mailbox preview above. Downloads retain participant addresses, date, direction and message identity for a bounded window. Bodies and attachments are excluded. Bulk, automated, spam, trash and draft messages are filtered.</p>
    <p className="text-sm">Gmail metadata cannot filter by date before reading messages. A scan limit can leave incomplete coverage; it does not prove the whole window was read.</p>
    {error && <p role="alert" className="rounded-lg border border-red-300 p-3 text-sm">{error}</p>}
    <fieldset disabled={disabled} className="min-w-0 space-y-4">
      <legend className="font-medium">Download choices</legend>
      <div className="space-y-2"><p className="text-sm">Selected labels: {labelIds.length}/20</p>
        {labelIds.length === 0 ? <p className="text-sm text-muted-foreground">Preview the mailbox and select at least one label.</p> : <ul aria-label="Selected download labels" className="flex flex-wrap gap-2">{labelIds.map((id) => <li key={id} className="min-w-0">
          <Button className="h-auto min-h-11 max-w-full whitespace-normal break-all" variant="outline" aria-label={'Remove selected label ' + id} onClick={() => setLabelIds(labelIds.filter((value) => value !== id))}>{id} · Remove</Button>
        </li>)}</ul>}
      </div>
      <div className="space-y-2"><label htmlFor="gmail-aliases" className="text-sm font-medium">Your other email addresses</label>
        <textarea id="gmail-aliases" className="min-h-24 w-full rounded-md border p-3 text-sm" value={aliases} maxLength={6720} onChange={(event) => setAliases(event.target.value)} />
        <p className="text-sm text-muted-foreground">One per line, up to twenty. Your primary mailbox address is always excluded from correspondent suggestions. Dots and plus tags are kept as entered.</p></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><label htmlFor="gmail-days" className="text-sm font-medium">Past days to retain</label><Input id="gmail-days" className="min-h-11" type="number" min={1} max={90} value={days} onChange={(event) => setDays(event.target.value)} /></div>
        <div className="space-y-2"><label htmlFor="gmail-scan" className="text-sm font-medium">Maximum messages to scan</label><Input id="gmail-scan" className="min-h-11" type="number" min={100} max={10000} value={scan} onChange={(event) => setScan(event.target.value)} /></div>
      </div>
      <div className="space-y-2"><label htmlFor="gmail-mode" className="text-sm font-medium">Correspondence context</label><select id="gmail-mode" className="min-h-11 w-full rounded-md border bg-background p-2 text-sm" value={mode} onChange={(event) => setMode(event.target.value as GmailChoices['mode'])}>
        <option value="existing_people">Existing people only</option><option value="review_inbox">Review new correspondents</option>
      </select><p className="text-sm text-muted-foreground">A bounded source index allows matching a person created later. Downloads never automatically create people or log CRM interactions.</p></div>
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={subjects} onChange={(event) => setSubjects(event.target.checked)} />Retain email subjects</label>
      <Button className="h-auto min-h-11 whitespace-normal" disabled={pending} onClick={reviewChoices}>Save download choices</Button>
    </fieldset>
    {confirmation && <div className="space-y-3 rounded-lg border p-3" role="group" aria-label="Confirm changed Gmail choices">
      <p>Changing these choices removes the saved Gmail metadata and any unfinished download. Your people, notes and confirmed interactions stay intact. A new full scan will be required.</p>
      <p className="break-words text-sm">{confirmation.label_ids.join(', ')} · {confirmation.past_days} days · up to {confirmation.scan_limit} messages · subjects {confirmation.retain_subject ? 'retained' : 'excluded'}.</p>
      <div className="flex flex-wrap gap-2"><Button className="h-auto min-h-11 whitespace-normal" disabled={pending} onClick={() => save(confirmation)}>Replace download choices</Button><Button className="min-h-11" variant="outline" disabled={pending} onClick={() => setConfirmation(null)}>Keep current choices</Button></div>
    </div>}
    {source && <div className="space-y-3 border-t pt-4">
      <p className="text-sm">{source.generation ? source.coverage === 'limited' ? 'Limited scan: some messages may be missing.' : 'Selected labels scanned within the chosen limit.' : 'No metadata download published yet.'}</p>
      {source.last_downloaded_at && <p className="text-sm">Last downloaded {new Date(source.last_downloaded_at).toLocaleString()}.</p>}
      {current && <p aria-live="polite" className="text-sm">Download {current.status} · {current.pages} pages · {current.processed} messages processed.</p>}
      {current?.issue && <p className="text-sm">{issues[current.issue] ?? 'Review this account before continuing the download.'}</p>}
      {current && current.retry_at > Date.now() && <p className="text-sm">Retry after {new Date(current.retry_at).toLocaleTimeString()}.</p>}
      {dirty && <p className="text-sm">Save or revert the changed choices before starting another download.</p>}
      <div className="flex flex-wrap gap-2">
        {active ? <><Button className="min-h-11" disabled={pending || current.retry_at > Date.now()} onClick={advance}>{pending ? 'Downloading…' : 'Continue download'}</Button>
          <Button className="min-h-11" variant="outline" disabled={pending} onClick={() => void run(async () => { await request('/downloads/' + current.id, 'DELETE', {}); return () => {}; })}>Cancel download</Button></> : <>
          <Button className="h-auto min-h-11 whitespace-normal" disabled={pending || confirmation !== null || labelPreviewPending || dirty && !starting} onClick={() => start('full')}>{starting ? 'Retry starting download' : 'Start full metadata scan'}</Button>
          <Button className="min-h-11" variant="outline" disabled={disabled || dirty || starting || !source.generation} onClick={() => start('incremental')}>Refresh changes</Button>
        </>}
        <Button className="min-h-11" variant="outline" disabled={pending || !source.generation} onClick={() => messages()}>Show downloaded metadata</Button>
      </div>
    </div>}
    {page && <section aria-labelledby="gmail-message-review-heading" className="space-y-3 border-t pt-4">
      <h3 id="gmail-message-review-heading" className="font-semibold">Downloaded message metadata</h3>
      <p className="text-sm">{page.messages.length} messages shown. This source review does not change your relationship history.</p>
      {page.messages.length === 0 ? <p>No eligible messages in the retained window.</p> : <ul className="space-y-3">{page.messages.map(({ facts, observed_at }) => <li key={facts.id} className="min-w-0 space-y-2 rounded-lg border p-3 text-sm">
        <p>{new Date(facts.received_at).toLocaleString()} · {facts.direction === 'unknown' ? 'Direction uncertain' : facts.direction === 'incoming' ? 'Incoming' : 'Outgoing'}</p>
        {facts.subject !== null && <p className="break-words font-medium">{facts.subject}</p>}
        <ul aria-label="Message participants">{facts.participants.map((person) => <li key={person.email} className="break-all">{person.email} · {person.roles.join(', ')}</li>)}</ul>
        {facts.participants_incomplete && <p>Some participant addresses could not be safely read.</p>}
        <p className="text-muted-foreground">Observed {new Date(observed_at).toLocaleString()}.</p>
      </li>)}</ul>}
      {page.more && <Button className="min-h-11" variant="outline" disabled={pending} onClick={() => messages(true)}>Show more messages</Button>}
    </section>}
  </section>;
}
