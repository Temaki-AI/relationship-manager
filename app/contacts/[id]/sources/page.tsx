'use client';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-changes-guard';
import { LinkedInSourceForm } from '@/components/linkedin-source-form';
import { GoogleSavedSources } from '@/components/google-saved-sources';
import { DeviceSavedSources } from '@/components/device-saved-sources';
import { readSourceFacts, SOURCE_FIELD_LABELS, type ContactSource } from '@/packages/domain/src/contact-sources';
import { getResponseErrorMessage } from '@/lib/utils';

type Person = { id: number; name: string; edit_revision: string };
function SourceCard({ source, person, onUpdate, onDirty }: { source: ContactSource; person: Person; onUpdate: () => Promise<void>; onDirty: (id: string, dirty: boolean) => void }) {
  const facts = readSourceFacts(source.fields);
  const [draft, setDraft] = useState(Object.fromEntries(Object.keys(SOURCE_FIELD_LABELS).map((key) => [key, facts[key as keyof typeof facts]?.observed_value ?? ''])));
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState<'unlink' | 'refresh' | null>(null);
  const dirty = Object.entries(draft).some(([key, value]) => value !== (facts[key as keyof typeof facts]?.observed_value ?? ''));
  useEffect(() => { onDirty(source.public_id, dirty || saving); return () => onDirty(source.public_id, false); }, [dirty, saving, source.public_id, onDirty]);
  async function change(action: 'observe' | 'use_name' | 'unlink') {
    setSaving(true); setError('');
    try {
      const response = await fetch(`/api/contacts/${person.id}/sources/${source.public_id}`, { method: action === 'unlink' ? 'DELETE' : 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, expected_revision: source.revision, expected_edit_revision: person.edit_revision, ...(action === 'observe' ? { fields: draft } : {}) }) });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Unable to update this source. Your draft is still here.'));
      await onUpdate(); setConfirm(null);
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save. Your draft is still here.'); }
    finally { setSaving(false); }
  }
  return <article className="space-y-4 rounded-xl border p-4" aria-label={`LinkedIn source ${source.profile_url}`}>
    <h2 className="text-lg font-semibold">LinkedIn</h2>
    <a href={source.profile_url} target="_blank" rel="noreferrer noopener" className="block break-all py-3 underline">Open LinkedIn profile</a>
    <p className="text-sm text-muted-foreground">User supplied · Updated {new Date(source.observed_at).toLocaleDateString()}</p>
    {error && <><p role="alert" className="text-destructive">{error}</p><Button variant="outline" disabled={saving} onClick={() => setConfirm('refresh')}>Refresh source</Button></>}
    <form onSubmit={(event) => { event.preventDefault(); void change('observe'); }} className="space-y-4">
      <fieldset disabled={saving} className="space-y-4"><legend className="sr-only">LinkedIn details</legend>
        {Object.entries(SOURCE_FIELD_LABELS).map(([key, label]) => <div key={key} className="space-y-2"><Label htmlFor={`${source.public_id}-${key}`}>{label} on LinkedIn</Label>
          <Input id={`${source.public_id}-${key}`} value={draft[key]} maxLength={key === 'name' ? 200 : 500} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
          {facts[key as keyof typeof facts] && <p className="break-words text-sm text-muted-foreground">Original: {facts[key as keyof typeof facts]!.original_value ?? 'Not supplied'}</p>}</div>)}
        <Button type="submit" disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save source details'}</Button>
      </fieldset>
    </form>
    <p className="text-sm">Your contact name: <strong>{person.name}</strong>{facts.name?.applied_value && <span className="block text-muted-foreground">Last name applied from this source: {facts.name.applied_value}{person.name !== facts.name.applied_value ? ' · You have kept a different name' : ''}</span>}</p>
    {facts.name?.observed_value && <Button variant="outline" disabled={saving || dirty || person.name === facts.name.observed_value} onClick={() => void change('use_name')}>Use source name</Button>}
    <Button className="ml-3" variant="outline" disabled={saving} onClick={() => setConfirm('unlink')}>Unlink profile</Button>
    <ConfirmDialog open={confirm !== null} title={confirm === 'unlink' ? 'Unlink LinkedIn profile?' : 'Discard this source draft?'}
      description={confirm === 'unlink' ? 'This removes the source link and its LinkedIn details.' : 'Refresh this source with the latest saved details. Other source drafts stay here.'}
      safetyNote="The person, contact methods, private notes and relationship history stay in Everclose." safetyTone="irreversible"
      confirmLabel={confirm === 'unlink' ? 'Unlink profile' : 'Discard draft and refresh'} pending={saving} onCancel={() => setConfirm(null)}
      onConfirm={() => { if (confirm === 'unlink') void change('unlink'); else void onUpdate().then(() => { setDraft(Object.fromEntries(Object.keys(SOURCE_FIELD_LABELS).map((key) => [key, facts[key as keyof typeof facts]?.observed_value ?? '']))); setError(''); setConfirm(null); }).catch((error) => setError(error.message)); }} />
  </article>;
}
export default function ContactSourcesPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{ contact: Person; sources: ContactSource[] } | null>(null), [error, setError] = useState('');
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const markDirty = useCallback((key: string, value: boolean) => setDirty((current) => current[key] === value ? current : { ...current, [key]: value }), []);
  const markCreateDirty = useCallback((value: boolean) => markDirty('create', value), [markDirty]);
  const load = useCallback(async () => {
    const response = await fetch(`/api/contacts/${id}/sources`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Unable to load sources.'));
    setData(await response.json()); setError('');
  }, [id]);
  useEffect(() => { let cancelled = false; void load().catch((error) => { if (!cancelled) setError(error.message); }); return () => { cancelled = true; }; }, [load]);
  return <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-8">
    <Link href={`/contacts/${id}`} className="inline-block py-3 underline">Back to person</Link>
    <h1 className="text-2xl font-semibold">Sources{data ? ` · ${data.contact.name}` : ''}</h1>
    <p>Keep source details alongside your private relationship. Choose which Google fields follow updates or keep your corrections. LinkedIn details can be edited here; Use source name explicitly applies its name.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!data && !error && <p role="status">Loading sources…</p>}
    <GoogleSavedSources contactId={id} />
    <DeviceSavedSources contactId={id} />
    {data && <>{data.sources.length === 0 && <p>No LinkedIn profiles linked yet.</p>}
      {data.sources.map((source) => <SourceCard key={`${source.public_id}:${source.revision}`} source={source} person={data.contact} onUpdate={load} onDirty={markDirty} />)}
      {data.sources.length < 32 && <LinkedInSourceForm contactId={data.contact.id} onCreated={load} onDirty={markCreateDirty} />}</>}
    <UnsavedChangesGuard active={Object.values(dirty).some(Boolean)} onDiscard={() => window.location.reload()} />
  </div>;
}
