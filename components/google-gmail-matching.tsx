'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { getResponseErrorMessage } from '@/lib/utils';
import type { GmailConnectionReview } from '@/lib/cloud/google-gmail-connection';
import type { GmailCorrespondent, GmailMatchDecision, GmailMatchPage, GmailMatchScope, GmailPersonContext } from '@/packages/domain/src/gmail-matching';

type Props = { review: GmailConnectionReview; disabled: boolean; onReview: (review: GmailConnectionReview) => void;
  onPending: (pending: boolean) => void; onUnavailable: () => void };
const status: Record<GmailCorrespondent['status'], string> = { unmatched: 'No person with this email yet', suggested: 'One possible person — review before linking',
  ambiguous: 'Shared address — choose a person explicitly', linked: 'Reviewed link', excluded: 'Excluded from correspondence', needs_review: 'Contact emails or identities changed — review again' };
function cursor(s: GmailMatchScope, after?: string | null) {
  const q = new URLSearchParams({ generation: s.generation!, directory_revision: String(s.directory_revision), matching_revision: String(s.matching_revision) });
  if (after) q.set('after', after); return q;
}
export function GoogleGmailMatching({ review, disabled, onReview, onPending, onUnavailable }: Props) {
  const endpoint = '/api/connections/' + review.connection.id + '/gmail';
  const [page, setPage] = useState<GmailMatchPage | null>(null), [context, setContext] = useState<GmailPersonContext | null>(null);
  const [selections, setSelections] = useState<Record<string, string>>({}), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const alive = useRef(false), busy = useRef(false), sequence = useRef(0), frozen = useRef<GmailMatchDecision | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; onPending(false); }; }, [onPending]);
  useEffect(() => { onPending(pending || uncertain); }, [pending, uncertain, onPending]);
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(endpoint + path, { method, cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not complete this correspondence review.'));
    return response.json();
  }
  async function verify(value: GmailMatchScope) {
    const fresh = await request('') as GmailConnectionReview;
    if (!alive.current) return false;
    onReview(fresh);
    if (!fresh.can_preview || fresh.epoch !== review.epoch || fresh.connection.authorization_revision !== review.connection.authorization_revision
      || fresh.source?.settings_revision !== value.settings_revision || fresh.source?.generation !== value.generation) throw new Error('Gmail authorization or download changed. Review the current account.');
    // A catalog/rule change while the browser checks the account must suppress the
    // earlier reply too. This reads only the retained cache, never Gmail.
    const current = await request('/matches?' + cursor(value)) as GmailMatchPage;
    if (!alive.current) return false;
    if (current.directory_ready !== value.directory_ready) throw new Error('Contacts changed while preparing this review. Show correspondence again.');
    return true;
  }
  async function run(action: (token: number) => Promise<void>) {
    if (busy.current || disabled) return;
    busy.current = true; const token = ++sequence.current; setPending(true); setError('');
    try { await action(token); }
    catch (err) {
      if (alive.current && sequence.current === token) {
        setPage(null); setContext(null); setError(err instanceof Error ? err.message : 'Could not complete this correspondence review.');
        try { const fresh = await request('') as GmailConnectionReview; if (alive.current) onReview(fresh); }
        catch { if (alive.current) onUnavailable(); }
      }
    } finally { busy.current = false; if (alive.current && sequence.current === token) setPending(false); }
  }
  async function show(more = false, discard = false) {
    await run(async (token) => {
      const value = await request('/matches' + (more && page?.next ? '?' + cursor(page, page.next) : '')) as GmailMatchPage;
      if (await verify(value) && alive.current && sequence.current === token) {
        setPage({ ...value, correspondents: more && page ? [...page.correspondents, ...value.correspondents] : value.correspondents });
        if (!more) { setContext(null); setSelections({}); }
        if (discard) { frozen.current = null; setUncertain(false); }
      }
    });
  }
  function prepare() {
    void run(async (token) => {
      for (let step = 0; step < 10 && alive.current && sequence.current === token; step++) {
        const value = await request('/matches/directory', 'POST', {}) as GmailMatchScope;
        if (value.directory_ready) break;
      }
      if (!alive.current || sequence.current !== token) return;
      const value = await request('/matches') as GmailMatchPage;
      if (await verify(value) && alive.current && sequence.current === token) { setPage(value); setContext(null); setSelections({}); }
    });
  }
  function choose(row: GmailCorrespondent, action: GmailMatchDecision['action']) {
    if (!page || frozen.current) return;
    const target = action === 'link' ? selections[row.email] : null; if (action === 'link' && !target) return;
    frozen.current = { operation_id: crypto.randomUUID(), action, email: row.email, target_public_id: target ?? null,
      expected_epoch: page.epoch, expected_authorization_revision: page.authorization_revision, expected_settings_revision: page.settings_revision,
      expected_generation: page.generation!, expected_directory_revision: page.directory_revision, expected_matching_revision: page.matching_revision };
    setUncertain(true); retry();
  }
  function retry() {
    if (!frozen.current) return;
    void run(async (token) => {
      await request('/matches', 'POST', frozen.current);
      const value = await request('/matches') as GmailMatchPage;
      if (await verify(value) && alive.current && sequence.current === token) {
        frozen.current = null; setUncertain(false); setPage(value); setContext(null); setSelections({});
      }
    });
  }
  function person(row: GmailCorrespondent, more = false) {
    const linked = row.linked_person; if (!linked) return;
    void run(async (token) => {
      const value = await request('/people/' + linked.public_id + (more && context?.next ? '?' + cursor(context, context.next) : '')) as GmailPersonContext;
      if (await verify(value) && alive.current && sequence.current === token) {
        if (value.person.public_id !== linked.public_id) throw new Error('This person was merged. Refresh correspondence before opening the current profile.');
        setContext({ ...value, messages: more && context ? [...context.messages, ...value.messages] : value.messages });
      }
    });
  }
  const locked = pending || disabled || uncertain;
  return <section aria-labelledby="gmail-matching-heading" className="min-w-0 space-y-4 rounded-xl border p-4">
    <h2 id="gmail-matching-heading" className="text-lg font-semibold">Correspondence review</h2>
    <p className="text-sm">Match downloaded email addresses to people and review each link. Adding or changing a person’s email lets them match the retained window later. Shared addresses need your choice.</p>
    <p className="text-sm">Observed email remains separate from notes and confirmed interactions. Linking does not update your last-contacted date.</p>
    {error && <p role="alert" className="rounded-lg border border-red-300 p-3 text-sm">{error}</p>}
    {uncertain && <div className="space-y-3 rounded-lg border p-3">
      <p>A choice is waiting for confirmation. Retrying uses the same request. Discarding the local retry does not undo a choice already saved.</p>
      <div className="flex flex-wrap gap-2"><Button className="min-h-11" disabled={pending || disabled} onClick={retry}>Retry saving choice</Button>
        <Button className="h-auto min-h-11 whitespace-normal" variant="outline" disabled={pending || disabled} onClick={() => void show(false, true)}>Discard local retry and refresh</Button></div>
    </div>}
    <Button className="h-auto min-h-11 whitespace-normal" disabled={locked || !review.source?.generation} variant="outline" onClick={() => void show()}>Show correspondence review</Button>
    {page && !page.directory_ready && <div className="space-y-3"><p>Prepare the contact email index before showing matches. This uses saved Everclose contacts and makes no Gmail requests.</p>
      <Button className="h-auto min-h-11 whitespace-normal" disabled={locked} onClick={prepare}>Prepare contact matching</Button></div>}
    {page?.directory_ready && <>
      <p className="text-sm">{page.mode === 'review_inbox' ? 'Review inbox includes new correspondents.' : 'Showing existing people and previously reviewed addresses.'} {page.correspondents.length} addresses shown.</p>
      {page.correspondents.length === 0 ? <p>No matches in the retained window. Add the relevant email to a person, then refresh this review.</p> : <ul className="space-y-3">{page.correspondents.map((row, index) => <li key={row.email} className="min-w-0 space-y-3 rounded-lg border p-3">
        <p className="break-all font-medium">{row.email}</p><p className="text-sm">{status[row.status]}</p>
        <p className="text-sm">{row.messages} messages · latest {new Date(row.latest_at).toLocaleString()}</p>
        {row.linked_person && <div className="flex flex-wrap items-center gap-3"><Link href={'/contacts/' + row.linked_person.id} className="min-h-11 break-words py-3 underline">{row.linked_person.name}</Link>
          <Button className="h-auto min-h-11 whitespace-normal" variant="outline" disabled={locked} onClick={() => person(row)}>Show correspondence for {row.linked_person.name}</Button></div>}
        {row.status !== 'linked' && row.status !== 'excluded' && row.candidates.length > 0 && !row.candidates_more && <div className="space-y-2">
          <label htmlFor={'gmail-person-' + index} className="block break-all text-sm font-medium">Person for {row.email}</label>
          <select id={'gmail-person-' + index} className="min-h-11 w-full rounded-md border bg-background p-2 text-sm" disabled={locked} value={selections[row.email] ?? ''}
            onChange={(event) => setSelections((previous) => ({ ...previous, [row.email]: event.target.value }))}>
            <option value="">Choose a person…</option>{row.candidates.map((candidate) => <option key={candidate.public_id} value={candidate.public_id}>{candidate.name}</option>)}
          </select><Button className="h-auto min-h-11 max-w-full whitespace-normal break-all" disabled={locked || !selections[row.email]} onClick={() => choose(row, 'link')}>Confirm person for {row.email}</Button>
        </div>}
        {row.candidates_more && <p className="text-sm">More than twenty people share this address. Review their contact methods before linking.</p>}
        {row.status === 'unmatched' && <p className="text-sm">Add this email to an existing person or <Link href="/contacts/new" className="underline">create a person</Link>, then refresh this review.</p>}
        <div className="flex flex-wrap gap-2">
          {row.status !== 'excluded' && <Button className="h-auto min-h-11 max-w-full whitespace-normal break-all" variant="outline" disabled={locked} onClick={() => choose(row, 'exclude')}>Exclude {row.email}</Button>}
          {['linked', 'excluded', 'needs_review'].includes(row.status) && <Button className="h-auto min-h-11 max-w-full whitespace-normal break-all" variant="outline" disabled={locked} onClick={() => choose(row, 'clear')}>Clear choice for {row.email}</Button>}
        </div>
      </li>)}</ul>}
      {page.more && <Button className="min-h-11" variant="outline" disabled={locked} onClick={() => void show(true)}>Show more correspondents</Button>}
    </>}
    {context && <section className="space-y-3 border-t pt-4" aria-labelledby="gmail-person-context-heading">
      <h3 id="gmail-person-context-heading" className="break-words font-semibold">Correspondence with {context.person.name}</h3>
      <p className="text-sm">{context.messages.length} observed messages shown. These are email metadata, not confirmed conversations.</p>
      {!context.directory_ready ? <p>Contact emails changed. Refresh and prepare matching again.</p> : context.messages.length === 0 ? <p>No currently reviewed email metadata in the retained window.</p> : <ul className="space-y-3">{context.messages.map(({ facts, linked_addresses }) => <li key={facts.id} className="min-w-0 space-y-2 rounded-lg border p-3 text-sm">
        <p>{new Date(facts.received_at).toLocaleString()} · {facts.direction === 'incoming' ? 'Incoming' : facts.direction === 'outgoing' ? 'Outgoing' : 'Direction uncertain'}</p>
        {facts.subject !== null && <p className="break-words font-medium">{facts.subject}</p>}
        <p className="break-all">Reviewed addresses: {linked_addresses.join(', ')}</p>
        {facts.participants_incomplete && <p>Some participant addresses could not be safely read.</p>}
      </li>)}</ul>}
      {context.more && page && <Button className="min-h-11" variant="outline" disabled={locked} onClick={() => { const row = page.correspondents.find((item) => item.linked_person?.public_id === context.person.public_id); if (row) person(row, true); }}>Show more correspondence</Button>}
    </section>}
  </section>;
}
