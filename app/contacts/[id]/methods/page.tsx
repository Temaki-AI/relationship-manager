'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-changes-guard';
import { MAX_CONTACT_METHODS, readContactMethods, normalizeUserContactMethods, type ContactMethod, type ContactMethodKind } from '@/packages/domain/src/contact-methods';
import { getResponseErrorMessage } from '@/lib/utils';

type Editor = { name: string; revision: string; original: string; draft: ContactMethod[] };
export default function ContactMethodsPage() {
  const { id } = useParams<{ id: string }>();
  const [editor, setEditor] = useState<Editor | null>(null), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const dirty = Boolean(editor && JSON.stringify(editor.draft) !== editor.original);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(`/api/contacts/${id}`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Unable to open contact methods.'));
      const { contact } = await response.json(), draft = readContactMethods(contact.contact_methods);
      setEditor({ name: contact.name, revision: contact.edit_revision, original: JSON.stringify(draft), draft });
    })().catch((error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [id]);
  function update(methodId: string, fields: Partial<ContactMethod>) { setEditor((current) => current ? { ...current,
    draft: current.draft.map((method) => ({ ...method, ...(method.id === methodId ? fields : fields.preferred && current.draft.find((item) => item.id === methodId)?.kind === method.kind ? { preferred: false } : {}) })) } : null); }
  function add(kind: ContactMethodKind) { setEditor((current) => current ? { ...current, draft: [...current.draft, { id: crypto.randomUUID(), kind, value: '', label: null, country: null,
    preferred: !current.draft.some((method) => method.kind === kind && method.preferred), source: 'manual', source_value: null, user_override: true }] } : null); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!editor) return; setSaving(true); setError('');
    try {
      const value = normalizeUserContactMethods(editor.draft, JSON.parse(editor.original));
      const response = await fetch(`/api/contacts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_methods: value, expected_edit_revision: editor.revision }) });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Unable to save. Your draft is still here.'));
      const { contact } = await response.json(), draft = readContactMethods(contact.contact_methods);
      setEditor({ name: contact.name, revision: contact.edit_revision, original: JSON.stringify(draft), draft });
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save. Your draft is still here.'); }
    finally { setSaving(false); }
  }
  return <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-8">
    <Link href={`/contacts/${id}`} className="inline-block py-3 underline">Back to person</Link>
    <h1 className="text-2xl font-semibold">Contact methods{editor ? ` · ${editor.name}` : ''}</h1>
    <p className="text-muted-foreground">Keep personal and work addresses, numbers and profile links together. Preferred email and phone values also appear on the main profile.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!editor && !error && <p role="status">Loading contact methods…</p>}
    {editor && <form onSubmit={save} className="space-y-5">
      {editor.draft.map((method) => <fieldset disabled={saving} key={method.id} className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 font-medium">{method.kind === 'profile' ? 'Profile link' : method.kind === 'phone' ? 'Phone number' : 'Email address'}</legend>
        <Label htmlFor={`value-${method.id}`}>Value</Label><Input id={`value-${method.id}`} value={method.value} type={method.kind === 'email' ? 'email' : method.kind === 'profile' ? 'url' : 'tel'}
          required maxLength={method.kind === 'profile' ? 2048 : method.kind === 'email' ? 320 : 100} onChange={(event) => update(method.id, { value: event.target.value })} />
        <Label htmlFor={`label-${method.id}`}>Label</Label><Input id={`label-${method.id}`} placeholder="Personal, work…" maxLength={80} value={method.label ?? ''} onChange={(event) => update(method.id, { label: event.target.value })} />
        {method.kind === 'phone' && <><Label htmlFor={`country-${method.id}`}>Country code, if known</Label><Input id={`country-${method.id}`} placeholder="PT" maxLength={2} value={method.country ?? ''} onChange={(event) => update(method.id, { country: event.target.value.toUpperCase() })} />
          <p className="text-sm text-muted-foreground">Use an international number starting with + for reliable matching. Local numbers keep their country context.</p></>}
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={method.preferred} onChange={(event) => update(method.id, { preferred: event.target.checked })} />Preferred {method.kind}</label>
        <p className="text-sm text-muted-foreground">{method.source === 'legacy' ? `From existing data${method.user_override || method.value !== JSON.parse(editor.original).find((item: ContactMethod) => item.id === method.id)?.value ? ' · value edited' : ''}` : 'User supplied'}
          {method.source_value !== null && <span className="block break-all">Original value: {method.source_value}</span>}</p>
        <Button type="button" variant="outline" onClick={() => setEditor({ ...editor, draft: editor.draft.filter((item) => item.id !== method.id) })}>Remove this method</Button>
      </fieldset>)}
      {!editor.draft.length && <p>No contact methods yet.</p>}
      <div className="flex flex-wrap gap-3">{(['email', 'phone', 'profile'] as const).map((kind) => <Button disabled={saving || editor.draft.length >= MAX_CONTACT_METHODS} key={kind} variant="outline" type="button" onClick={() => add(kind)}>Add {kind}</Button>)}</div>
      <Button disabled={saving || !dirty} type="submit">{saving ? 'Saving…' : 'Save methods'}</Button>
    </form>}
    <UnsavedChangesGuard active={dirty || saving} onDiscard={() => window.location.reload()} />
  </div>;
}
