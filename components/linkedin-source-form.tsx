'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SOURCE_FIELD_LABELS, linkedinProfileIdentity, normalizeSourceObservations } from '@/packages/domain/src/contact-sources';
import { getResponseErrorMessage } from '@/lib/utils';

const EMPTY = { name: '', headline: '', company: '', location: '', title: '', email: '', connected_on: '' };
export function LinkedInSourceForm({ contactId, onCreated, onDirty }: { contactId?: number; onCreated?: () => Promise<void>; onDirty: (dirty: boolean) => void }) {
  const router = useRouter();
  const [url, setUrl] = useState(''), [fields, setFields] = useState(EMPTY), [mode, setMode] = useState<'new' | 'existing'>(contactId ? 'existing' : 'new');
  const [selected, setSelected] = useState(contactId ? String(contactId) : ''), [search, setSearch] = useState(''), [people, setPeople] = useState<Array<{ id: number; name: string }>>([]);
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [searchError, setSearchError] = useState('');
  const [epoch, setEpoch] = useState<string | null>(null);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const dirty = Boolean(url || Object.values(fields).some(Boolean));
  useEffect(() => { onDirty(dirty || saving); }, [dirty, saving, onDirty]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/sources/context', { signal: controller.signal, cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Unable to prepare the connection form. Refresh to try again.'));
      return response.json();
    }).then((body) => setEpoch(body.epoch)).catch((error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (contactId || mode !== 'existing') return;
    const controller = new AbortController(); setSearchError('');
    fetch(`/api/contacts?view=mentions&limit=50&search=${encodeURIComponent(search)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => { if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Unable to find people.')); return response.json(); })
      .then((body) => setPeople(body.contacts)).catch((error) => { if (!controller.signal.aborted) setSearchError(error.message); });
    return () => controller.abort();
  }, [contactId, mode, search]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const observations = normalizeSourceObservations(Object.fromEntries(Object.entries(fields).filter(([, value]) => value.trim())));
      const target = contactId ?? (mode === 'existing' ? Number(selected) : null);
      if (target !== null && (!Number.isSafeInteger(target) || target < 1)) throw new Error('Choose the person to link.');
      const payload = JSON.stringify({ contact_id: target, profile_url: linkedinProfileIdentity(url), fields: observations, expected_epoch: epoch });
      if (!attempt.current || attempt.current.payload !== payload) attempt.current = { payload, key: crypto.randomUUID() };
      const response = await fetch('/api/sources/linkedin', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.current.key }, body: payload });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Unable to link this profile. Your draft is still here.'));
      const result = await response.json();
      setUrl(''); setFields(EMPTY); attempt.current = null; onDirty(false);
      if (onCreated) await onCreated(); else router.push(`/contacts/${result.contact_id}/sources`);
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save. Your draft is still here.'); }
    finally { setSaving(false); }
  }
  return <form onSubmit={save} className="space-y-4 rounded-xl border p-4">
    <h2 className="text-lg font-semibold">Link a LinkedIn profile</h2>
    <p className="text-sm text-muted-foreground">Paste a profile link and any details you want to retain. Details are user supplied and update when you edit them here.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <fieldset disabled={saving} className="space-y-4">
      {!contactId && <>
        <legend className="mb-2 font-medium">Person</legend>
        <label className="flex min-h-11 items-center gap-3"><input type="radio" name="source-destination" checked={mode === 'new'} onChange={() => setMode('new')} />Create a new person</label>
        <label className="flex min-h-11 items-center gap-3"><input type="radio" name="source-destination" checked={mode === 'existing'} onChange={() => setMode('existing')} />Link an existing person</label>
        {mode === 'existing' && <><Label htmlFor="source-search">Find a person</Label><Input id="source-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search your people" />
          {searchError && <p role="alert" className="text-destructive">{searchError}</p>}
          <Label htmlFor="source-person">Person to link</Label><select id="source-person" value={selected} onChange={(event) => setSelected(event.target.value)} className="min-h-11 w-full rounded-md border bg-white p-2" required>
            <option value="">Choose a person</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select><p className="text-sm text-muted-foreground">Search to find people outside the first 50 results.</p></>}
      </>}
      <Label htmlFor="source-url">LinkedIn profile URL</Label><Input id="source-url" type="text" inputMode="url" autoCapitalize="none" required value={url} maxLength={2048} placeholder="https://www.linkedin.com/in/ana" onChange={(event) => setUrl(event.target.value)} />
      {Object.entries(SOURCE_FIELD_LABELS).map(([key, label]) => <div key={key} className="space-y-2"><Label htmlFor={`source-${key}`}>{label} on LinkedIn{key === 'name' && mode === 'new' && !contactId ? ' (required)' : ' (optional)'}</Label>
        <Input id={`source-${key}`} maxLength={key === 'name' ? 200 : key === 'email' ? 320 : 500} required={key === 'name' && mode === 'new' && !contactId} value={fields[key as keyof typeof EMPTY]} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} /></div>)}
      <Button disabled={saving || !epoch} type="submit">{saving ? 'Linking…' : 'Link profile'}</Button>
    </fieldset>
  </form>;
}
