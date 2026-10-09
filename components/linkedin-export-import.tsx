'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-changes-guard';
import { MAX_LINKEDIN_EXPORT_BYTES, parseLinkedInExport, type LinkedInExportRow } from '@/lib/linkedin-export';
import type { LinkedInImportPreview } from '@/lib/linkedin-import';
import { linkedinProfileIdentity, SOURCE_FIELD_LABELS } from '@/packages/domain/src/contact-sources';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { getResponseErrorMessage } from '@/lib/utils';
type Attempt = { key: string; payload: string };
const pendingKey = (epoch: string) => `everclose:linkedin-row:${epoch}`;
export function LinkedInExportImport() {
  const [rows, setRows] = useState<LinkedInExportRow[]>([]), [filename, setFilename] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(0);
  const [selected, setSelected] = useState<LinkedInExportRow | null>(null), [url, setUrl] = useState(''), [preview, setPreview] = useState<LinkedInImportPreview | null>(null);
  const [mode, setMode] = useState<'new' | 'existing' | ''>(''), [targetId, setTargetId] = useState(''), [createName, setCreateName] = useState('');
  const [useName, setUseName] = useState(false), [useEmail, setUseEmail] = useState(false), [personSearch, setPersonSearch] = useState('');
  const [people, setPeople] = useState<Array<{ id: number; name: string; email?: string | null }>>([]), [saved, setSaved] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [searchError, setSearchError] = useState(''), [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(false), [restoredRow, setRestoredRow] = useState(''), [lastPerson, setLastPerson] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const attempt = useRef<Attempt | null>(null), generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController(), requestGeneration = generation;
    void fetch('/api/sources/context', { cache: 'no-store', signal: controller.signal }).then(async (response) => {
      if (!response.ok) return; const context = await response.json(); if (!isSyncUuid(context.epoch)) return;
      const stored = sessionStorage.getItem(pendingKey(context.epoch)); if (!stored) return;
      const item = JSON.parse(stored) as Attempt, body = JSON.parse(item.payload);
      if (!isSyncUuid(item.key) || typeof item.payload !== 'string' || item.payload.length > 16384 || body.expected_epoch !== context.epoch) return;
      linkedinProfileIdentity(body.profile_url); if (controller.signal.aborted) return;
      attempt.current = item; setUncertain(true); setRestoredRow(typeof body.fields?.name === 'string' ? body.fields.name : 'LinkedIn connection');
    }).catch(() => { /* Import remains usable without tab recovery. */ }).finally(() => { if (!controller.signal.aborted) setReady(true); });
    return () => { controller.abort(); requestGeneration.current++; };
  }, []);
  useEffect(() => {
    if (mode !== 'existing' || uncertain) return; const controller = new AbortController(); setSearchError('');
    void fetch(`/api/contacts?view=mentions&limit=50&search=${encodeURIComponent(personSearch)}`, { cache: 'no-store', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Unable to search people.')); return response.json();
    }).then((body) => setPeople(body.contacts)).catch((err) => { if (!controller.signal.aborted) setSearchError(err.message); });
    return () => controller.abort();
  }, [mode, personSearch, uncertain]);
  const dirty = uncertain || busy || rows.some((row) => !row.issue && !saved[row.row]);
  async function upload(file: File) {
    if (!ready || busy || uncertain) return;
    const current = ++generation.current; setBusy(true); setError('');
    try {
      if (file.size > MAX_LINKEDIN_EXPORT_BYTES) throw new Error('Connections.csv is limited to 2 MiB.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()), parsed = parseLinkedInExport(text);
      if (current !== generation.current) return;
      setRows(parsed); setFilename(file.name.slice(0, 200)); setPage(0); setSearch(''); setSelected(null); setPreview(null); setSaved({}); setNotice(''); setLastPerson(null);
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : 'Unable to read this CSV.'); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function prepare(row: LinkedInExportRow, profileUrl: string, person: string) {
    const current = ++generation.current; setBusy(true); setError(''); setPreview(null);
    try {
      const response = await fetch('/api/sources/linkedin/import/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_url: linkedinProfileIdentity(profileUrl), fields: { name: row.fields.name ?? null, email: row.fields.email ?? null }, contact_id: person ? Number(person) : null }) });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Unable to prepare this row.'));
      const result = await response.json(); if (current === generation.current) setPreview(result);
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : 'Unable to prepare this row.'); }
    finally { if (current === generation.current) setBusy(false); }
  }
  function open(row: LinkedInExportRow) {
    setSelected(row); setUrl(row.profile_url ?? ''); setPreview(null); setMode(''); setTargetId(''); setPersonSearch(''); setPeople([]); setCreateName(row.fields.name ?? ''); setUseName(false); setUseEmail(false); setError('');
    if (row.profile_url) void prepare(row, row.profile_url, '');
  }
  function choosePerson(id: string) { setMode('existing'); setTargetId(id); if (selected && id) void prepare(selected, url, id); else setPreview((current) => current ? { ...current, target: null } : current); }
  const clearAttempt = useCallback((item: Attempt) => {
    try { const body = JSON.parse(item.payload); sessionStorage.removeItem(pendingKey(body.expected_epoch)); } catch { /* Storage can be unavailable. */ }
    attempt.current = null; setUncertain(false); setRestoredRow('');
  }, []);
  async function save() {
    if (busy) return; setBusy(true); setError(''); setConfirm(false);
    let item = attempt.current;
    try {
      if (!uncertain) {
        if (!selected || !preview || !mode || mode === 'existing' && (!preview.target || preview.target.id !== Number(targetId))) throw new Error('Review the chosen person before importing.');
        const payload = JSON.stringify({ profile_url: linkedinProfileIdentity(url), fields: selected.fields, contact_id: mode === 'existing' ? Number(targetId) : null,
          create_name: mode === 'new' ? createName : null, use_name: mode === 'existing' && useName, use_email: useEmail, expected_epoch: preview.epoch,
          expected_contact_revision: mode === 'existing' ? preview.target!.edit_revision : null, expected_source: preview.source ? { public_id: preview.source.public_id, revision: preview.source.revision } : null });
        if (!item || item.payload !== payload) item = { payload, key: crypto.randomUUID() };
        attempt.current = item;
        try { sessionStorage.setItem(pendingKey(preview.epoch), JSON.stringify(item)); } catch { setNotice('This browser cannot recover an unconfirmed row after closing the tab. Keep this page open until it is confirmed.'); }
      }
      if (!item) throw new Error('No unconfirmed row is available.');
      const response = await fetch('/api/sources/linkedin/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': item.key }, body: item.payload });
      if (!response.ok) {
        const message = await getResponseErrorMessage(response, 'This row was not confirmed.');
        if (response.status < 500 && ![401, 408, 429].includes(response.status)) { clearAttempt(item); throw new Error(message); }
        setUncertain(true); throw new Error(`${message} Retry the unchanged row before editing its choices.`);
      }
      const result = await response.json(); clearAttempt(item); setLastPerson(result.contact_id);
      if (selected) setSaved((previous) => ({ ...previous, [selected.row]: result.contact_id }));
      setSelected(null); setPreview(null); setMode(''); setNotice('The reviewed row is saved. Private notes, history and existing preferred methods are preserved.');
    } catch (err) {
      if (attempt.current) setUncertain(true);
      setError(err instanceof Error ? err.message : 'The result was not confirmed. Retry the unchanged row.');
    } finally { setBusy(false); }
  }
  const filtered = rows.filter((row) => [row.fields.name, row.fields.email, row.fields.company].some((value) => value?.toLowerCase().includes(search.toLowerCase())));
  const candidates = [...new Map([...(preview?.matches ?? []), ...people, ...(preview?.target ? [preview.target] : [])].map((person) => [person.id, person])).values()];
  return <section className="space-y-6 [&_button]:min-h-11">
    <p>Review connections from your LinkedIn export. Save their source details, create a person or attach them to an existing relationship, and choose whether to apply the name or add an email.</p>
    <p className="text-sm text-muted-foreground">Read only Connections.csv from your archive. The file is read in this tab; row previews are sent to Everclose to find possible matches. Nothing is saved until you confirm a row. A connection date is source context, not proof of a conversation.</p>
    <a className="inline-block py-3 underline" href="https://www.linkedin.com/help/linkedin/answer/a1339364/downloading-your-account-data?lang=en" target="_blank" rel="noopener noreferrer">How to download LinkedIn connections</a>
    {!!error && <p role="alert" className="text-destructive">{error}</p>}{!!notice && <p role="status">{notice}</p>}
    {lastPerson && <Link className="inline-block py-3 underline" href={`/contacts/${lastPerson}/sources`}>Open saved person and source details</Link>}
    {uncertain && <div className="space-y-3 rounded-xl border p-4"><h2 className="text-lg font-semibold">Unconfirmed row{restoredRow ? ` · ${restoredRow}` : ''}</h2><p>Retry the exact saved request. Editing is paused until Everclose confirms it or reports that it cannot apply.</p><Button disabled={busy} onClick={() => void save()}>Retry unchanged row</Button></div>}
    <fieldset disabled={!ready || busy || uncertain} className="space-y-3">
      <Label htmlFor="linkedin-csv">LinkedIn Connections.csv</Label><Input id="linkedin-csv" type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} />
      <p className="text-sm text-muted-foreground">Up to 2 MiB and 5,000 rows. Older files without URLs can be reviewed after you provide the person&apos;s profile URL.</p>
    </fieldset>
    {selected && !uncertain && <div className="space-y-4 rounded-xl border p-4"><h2 className="text-xl font-semibold">Review row {selected.row} · {selected.fields.name}</h2>
      <dl className="space-y-2">{Object.entries(selected.fields).map(([key, value]) => <div key={key} className="break-words"><dt className="font-medium">{SOURCE_FIELD_LABELS[key as keyof typeof SOURCE_FIELD_LABELS]}</dt><dd>{value || 'Not supplied'}</dd></div>)}</dl>
      <fieldset disabled={busy} className="space-y-4">
        <Label htmlFor="linkedin-row-url">Profile URL for this row</Label><Input id="linkedin-row-url" value={url} maxLength={2048} onChange={(event) => { setUrl(event.target.value); setPreview(null); }} />
        <Button variant="outline" onClick={() => void prepare(selected, url, mode === 'existing' ? targetId : '')}>Refresh row preview</Button>
        {preview && <>
          {preview.linked_person && <div className="space-y-2"><p>This profile is already linked to {preview.linked_person.name}. Reimporting updates its source observations.</p><Button variant="outline" onClick={() => choosePerson(String(preview.linked_person!.id))}>Review linked person</Button></div>}
          <label className="flex min-h-11 items-center gap-3"><input type="radio" name="linkedin-row-target" checked={mode === 'new'} disabled={Boolean(preview.source)} onChange={() => { setMode('new'); setTargetId(''); }} />Create a new person</label>
          <label className="flex min-h-11 items-center gap-3"><input type="radio" name="linkedin-row-target" checked={mode === 'existing'} onChange={() => setMode('existing')} />Attach to an existing person</label>
          {mode === 'new' && <><Label htmlFor="linkedin-create-name">New person name</Label><Input id="linkedin-create-name" maxLength={200} value={createName} onChange={(event) => setCreateName(event.target.value)} /></>}
          {mode === 'existing' && <>
            <p className="text-sm text-muted-foreground">Possible name/email matches are suggestions. Confirm the identity yourself.</p>
            <Label htmlFor="linkedin-person-search">Find an Everclose person</Label><Input id="linkedin-person-search" value={personSearch} onChange={(event) => setPersonSearch(event.target.value)} />
            {!!searchError && <p role="alert">{searchError}</p>}
            <Label htmlFor="linkedin-person">Person to attach</Label><select id="linkedin-person" className="min-h-11 w-full rounded border bg-background p-2" value={targetId} onChange={(event) => choosePerson(event.target.value)}><option value="">Choose a person</option>{candidates.map((person) => <option key={person.id} value={person.id}>{person.name}{person.email ? ` · ${person.email}` : ''}</option>)}</select>
            {preview.target && <><p>Current person name: {preview.target.name}</p><label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={useName} onChange={(event) => setUseName(event.target.checked)} />Replace the person name with this exported name</label></>}
          </>}
          <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={useEmail} disabled={!selected.fields.email} onChange={(event) => setUseEmail(event.target.checked)} />Add the exported email as a contact method</label>
          <p className="text-sm text-muted-foreground">Company, position and connection date stay in source details. Existing preferred email, private notes and history stay intact.</p>
          <Button disabled={!mode || mode === 'existing' && (!preview.target || preview.target.id !== Number(targetId)) || mode === 'new' && (!createName.trim() || Boolean(preview.source))} onClick={() => setConfirm(true)}>Import reviewed row</Button>
        </>}
        <Button variant="outline" onClick={() => { setSelected(null); setPreview(null); }}>Back to connections file</Button>
      </fieldset>
    </div>}
    {!!rows.length && !selected && <div className="space-y-4"><h2 className="text-lg font-semibold">{filename} · {rows.length} connections · {Object.keys(saved).length} saved</h2>
      <Label htmlFor="linkedin-export-search">Find a connection in the file</Label><Input id="linkedin-export-search" value={search} disabled={busy || uncertain} onChange={(event) => { setSearch(event.target.value); setPage(0); }} />
      <ul className="space-y-3">{filtered.slice(page * 50, (page + 1) * 50).map((row) => <li key={row.row} className="space-y-2 rounded-xl border p-4"><p className="break-words font-medium">{row.fields.name || `Row ${row.row}`}</p><p className="break-words text-sm text-muted-foreground">{row.fields.company} {row.fields.email}</p>
        {row.issue && <p className="text-destructive">{row.issue}</p>}{!!row.duplicates.length && <p className="text-sm">Same profile also appears in rows {row.duplicates.join(', ')}{row.duplicate_count > row.duplicates.length ? ` and ${row.duplicate_count - row.duplicates.length} more` : ''}. Review these as the same linked source.</p>}
        {saved[row.row] ? <Link className="inline-block py-3 underline" href={`/contacts/${saved[row.row]}/sources`}>Saved · open person</Link> : <Button variant="outline" disabled={busy || uncertain || Boolean(row.issue)} onClick={() => open(row)}>Review row {row.row}</Button>}
        {!row.profile_url && !row.issue && <p className="text-sm text-muted-foreground">Provide a profile URL during review.</p>}
      </li>)}</ul><div className="flex flex-wrap gap-3"><Button variant="outline" disabled={!page || busy || uncertain} onClick={() => setPage(page - 1)}>Previous page</Button><Button variant="outline" disabled={(page + 1) * 50 >= filtered.length || busy || uncertain} onClick={() => setPage(page + 1)}>Next page</Button></div>
    </div>}
    <ConfirmDialog open={confirm} onCancel={() => setConfirm(false)} title="Import this reviewed connection?" description={`${mode === 'new' ? `Create ${createName}.` : 'Keep the chosen relationship and its private history.'} Save the exported details as user-provided source facts.${useName ? ' Replace the person name with the exported name.' : ''}${useEmail ? ' Add the exported email without replacing an existing preferred email.' : ''}`} safetyTone="irreversible" safetyNote="Unlinking later keeps accepted contact fields. Review the destination before saving." confirmLabel="Confirm row import" onConfirm={() => void save()} />
    <UnsavedChangesGuard active={dirty} onDiscard={() => window.location.reload()} />
  </section>;
}
