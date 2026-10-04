'use client';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { getResponseErrorMessage } from '@/lib/utils';
import type { GoogleContactFacts } from '@/packages/domain/src/provider-sources';

type Person = { id: number; name: string; edit_revision: string };
type Preview = { epoch: string; generation: string; facts_revision: string; facts: GoogleContactFacts;
  connection: { id: string; email: string; authorization_revision: number }; linked_contact: { id: number; name: string } | null;
  matches: Person[]; people: Person[]; target: Person | null };
type Pending = { key: string; body: Record<string, unknown> };
const inputClass = 'h-11 w-full rounded-md border bg-background px-3';
function ImportReview() {
  const { id } = useParams<{ id: string }>(), parameters = useSearchParams();
  const generation = parameters.get('generation') || '', sourceId = parameters.get('source_id') || '';
  const endpoint = '/api/connections/' + encodeURIComponent(id) + '/contacts';
  const [preview, setPreview] = useState<Preview | null>(null), [target, setTarget] = useState<Person | null>(null);
  const [name, setName] = useState(''), [useName, setUseName] = useState(false), [search, setSearch] = useState('');
  const [keepUpdated, setKeepUpdated] = useState(false);
  const [emails, setEmails] = useState<number[]>([]), [phones, setPhones] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [saved, setSaved] = useState<number | null>(null);
  const pending = useRef<Pending | null>(null), requests = useRef({ sequence: 0 }), loaded = useRef(false);
  const load = useCallback(async (query = '', contactId?: number) => {
    const requestId = ++requests.current.sequence;
    const queryParameters = new URLSearchParams({ generation, source_id: sourceId, q: query });
    if (contactId) queryParameters.set('contact_id', String(contactId));
    const response = await fetch(endpoint + '/import-preview?' + queryParameters, { cache: 'no-store' });
    if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not review this Google contact.'));
    const result = await response.json() as Preview;
    if (requestId !== requests.current.sequence) return;
    setPreview(result); setTarget(result.target); setError(null);
    if (!loaded.current) { setName(result.facts.name || ''); loaded.current = true; }
  }, [endpoint, generation, sourceId]);
  useEffect(() => {
    const currentRequests = requests.current;
    load('', Number(parameters.get('contact_id')) || undefined).catch((err) => setError(err instanceof Error ? err.message : 'Could not load this review.'));
    return () => { currentRequests.sequence++; };
  }, [load, parameters]);
  async function choose(person: Person | null) {
    if (busy || uncertain) return;
    setUseName(false); setBusy(true);
    try { await load(search.trim(), person?.id); } catch (err) { setError(err instanceof Error ? err.message : 'Could not load this person.'); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!preview || busy) return;
    pending.current ||= { key: crypto.randomUUID(), body: { expected_epoch: preview.epoch, expected_authorization_revision: preview.connection.authorization_revision,
      generation: preview.generation, source_id: preview.facts.sourceId, facts_revision: preview.facts_revision,
      contact_id: target?.id ?? null, expected_edit_revision: target?.edit_revision ?? null, create_name: target ? null : name.trim(), use_name: useName, emails, phones, ...(keepUpdated ? { keep_updated: true } : {}) } };
    setBusy(true); setError(null);
    try {
      const response = await fetch(endpoint + '/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.current.key }, body: JSON.stringify(pending.current.body) });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 429) { pending.current = null; setUncertain(false); }
        else setUncertain(true);
        throw new Error(await getResponseErrorMessage(response, 'Could not confirm this import. Retry the same request.'));
      }
      const result = await response.json() as { contact_id: number };
      setSaved(result.contact_id); setUncertain(false); pending.current = null;
    } catch (err) {
      if (pending.current) setUncertain(true);
      setError(err instanceof Error ? err.message : 'Could not confirm this import. Retry the same request.');
    } finally { setBusy(false); }
  }
  const locked = busy || uncertain || saved !== null;
  function toggle(index: number, selected: number[], change: (value: number[]) => void) { change(selected.includes(index) ? selected.filter((i) => i !== index) : [...selected, index]); }
  return <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-8">
    <Link href={'/connections/google/' + encodeURIComponent(id) + '/contacts'} className="inline-block py-3 underline">Back to Google Contacts</Link>
    <h1 className="text-2xl font-semibold">Choose how to save this person</h1>
    {error && <p role="alert" className="rounded-lg border border-red-300 p-3">{error}</p>}
    {uncertain && <p role="status">The response was not confirmed. Retry with the same choices to recover the result without creating another person.</p>}
    {saved !== null ? <div role="status" className="space-y-3 rounded-xl border p-4"><p>Google source saved. Your private relationship details were preserved.</p><Link className="inline-block py-3 underline" href={'/contacts/' + saved}>Open person</Link></div> : preview ? <>
      <div className="space-y-1 rounded-xl border p-4"><p className="break-all text-sm">From {preview.connection.email}</p><h2 className="break-words text-xl font-semibold">{preview.facts.name || 'Unnamed Google contact'}</h2>
        {[preview.facts.title, preview.facts.company, preview.facts.location].filter(Boolean).map((value, i) => <p key={i} className="break-words text-sm">{value}</p>)}</div>
      {preview.linked_contact && !uncertain ? <p>This source is already linked to <Link className="underline" href={'/contacts/' + preview.linked_contact.id}>{preview.linked_contact.name}</Link>. Manage it from that person’s sources.</p> : <>
        <section className="space-y-3 rounded-xl border p-4">
          <h2 className="font-semibold">Create or attach</h2>
          {target ? <div><p className="break-words">Attach to <strong>{target.name}</strong></p><Button className="mt-2" variant="outline" disabled={locked} onClick={() => choose(null)}>Create a new person instead</Button></div>
            : <div><label htmlFor="create-name" className="mb-1 block">New person’s name</label><input id="create-name" className={inputClass} maxLength={200} value={name} disabled={locked} onChange={(event) => setName(event.target.value)} /></div>}
          {!!preview.matches.length && <div><p className="text-sm">Possible matches by email or phone. Confirm who this is before attaching.</p><div className="mt-2 flex flex-wrap gap-2">{preview.matches.map((person) => <Button key={person.id} variant="outline" className="h-auto min-h-11 whitespace-normal text-left" disabled={locked} onClick={() => choose(person)}>Attach to {person.name}</Button>)}</div></div>}
          <form className="space-y-2" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await load(search.trim(), target?.id); } catch (err) { setError(err instanceof Error ? err.message : 'Search failed.'); } finally { setBusy(false); } }}>
            <label htmlFor="person-search" className="block text-sm">Find an existing Everclose person</label><div className="flex gap-2"><input id="person-search" className={inputClass} maxLength={200} value={search} disabled={locked} onChange={(event) => setSearch(event.target.value)} /><Button type="submit" variant="outline" disabled={locked}>Search</Button></div>
          </form>
          {!!preview.people.length && <div className="flex flex-wrap gap-2">{preview.people.map((person) => <Button key={person.id} className="h-auto min-h-11 whitespace-normal text-left" variant="outline" disabled={locked} onClick={() => choose(person)}>Attach to {person.name}</Button>)}</div>}
        </section>
        <fieldset disabled={locked} className="space-y-3 rounded-xl border p-4"><legend className="px-1 font-semibold">Fields to use</legend>
          {target && preview.facts.name && <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={useName} onChange={(event) => setUseName(event.target.checked)} /><span className="break-words">Use Google’s name: {preview.facts.name}</span></label>}
          {(['emails', 'phones'] as const).map((kind) => <div key={kind} className="space-y-1"><h3 className="text-sm font-medium">{kind === 'emails' ? 'Email addresses' : 'Phone numbers'}</h3>{preview.facts[kind].map((method, index) => <label key={index} className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={(kind === 'emails' ? emails : phones).includes(index)} onChange={() => toggle(index, kind === 'emails' ? emails : phones, kind === 'emails' ? setEmails : setPhones)} /><span className="min-w-0 break-all text-sm">{method.value}{method.label ? ` (${method.label})` : ''}</span></label>)}{!preview.facts[kind].length && <p className="text-sm text-muted-foreground">None provided.</p>}</div>)}
          <p className="text-sm">Only selected names, emails and phones are applied. Existing preferred methods and private notes, history and reminders are kept. Company and location stay in the saved source details.</p>
        </fieldset>
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" disabled={locked} checked={keepUpdated} onChange={(event) => setKeepUpdated(event.target.checked)} /><span>Keep selected values updated from Google</span></label>
        <p className="text-sm text-muted-foreground">When enabled, future downloads update accepted values until you correct them in Everclose. You can change each field’s choice in the person’s sources. A custom name stays yours. Automatic downloads are enabled separately for the account.</p>
        <p className="text-sm text-muted-foreground">This saves a source link and the original Google details once. Original source details and private relationship history are preserved. Google contacts are never edited.</p>
        <Button className="min-h-11 w-full sm:w-auto" disabled={busy || !uncertain && !target && !name.trim()} onClick={save}>{busy ? 'Saving…' : uncertain ? 'Retry same import' : target ? 'Attach source and selected fields' : 'Create person and save source'}</Button>
        {!locked && <Button variant="outline" className="ml-0 sm:ml-3" onClick={() => choose(target)}>Refresh person details</Button>}
      </>}
    </> : !error && <p role="status">Loading Google contact…</p>}
  </div>;
}
export default function GoogleImportPage() { return <Suspense fallback={<p className="p-4">Loading review…</p>}><ImportReview /></Suspense>; }
