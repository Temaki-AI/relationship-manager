'use client';
import { GoogleSourceControls } from './google-source-controls';
import { readProviderRules, type SavedProviderRules } from '@/packages/domain/src/provider-rules';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { getResponseErrorMessage } from '@/lib/utils';
import { readAppliedProviderFields, readProviderFacts, readProviderSources, type GoogleContactFacts, type ProviderSource } from '@/packages/domain/src/provider-sources';

function Facts({ facts }: { facts: GoogleContactFacts }) {
  return <div className="space-y-1 text-sm"><p className="break-words">{facts.name || 'Name not provided'}</p>
    {facts.emails.concat(facts.phones).map((method, i) => <p key={i} className="break-all">{method.value}{method.label ? ` (${method.label})` : ''}</p>)}
    {[facts.company, facts.title, facts.location].filter(Boolean).map((value, i) => <p key={'f' + i} className="break-words">{value}</p>)}</div>;
}
export function GoogleSavedSources({ contactId }: { contactId: string }) {
  const [links, setLinks] = useState<ProviderSource[]>([]), [epoch, setEpoch] = useState<string | null>(null), [error, setError] = useState('');
  const [rules, setRules] = useState<SavedProviderRules[]>([]), [person, setPerson] = useState<{ name: string; contact_methods: string; edit_revision: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<ProviderSource | null>(null), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch('/api/contacts/' + contactId + '/provider-sources', { cache: 'no-store' });
    if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not load Google sources.'));
    const data = await response.json() as { epoch: string | null; links: ProviderSource[]; rules?: SavedProviderRules[]; contact?: { name: string; contact_methods: string; edit_revision: string } };
    setLinks(readProviderSources(JSON.stringify(data.links))); setEpoch(data.epoch); setRules((data.rules ?? []).map((rule) => ({ ...rule, fields: readProviderRules(rule.fields) }))); setPerson(data.contact ?? null); setError('');
  }, [contactId]);
  useEffect(() => { let active = true; load().catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Could not load sources.'); }); return () => { active = false; }; }, [load]);
  async function unlink() {
    if (!confirm || !epoch) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/contacts/' + contactId + '/provider-sources/' + confirm.public_id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_epoch: epoch, expected_revision: confirm.revision }) });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not unlink this source. Refresh its details.'));
      await load(); setConfirm(null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not unlink this source.'); }
    finally { setBusy(false); }
  }
  async function saveFields(link: ProviderSource, rule: SavedProviderRules, body: Record<string, unknown>) {
    if (!person || !epoch || busy) return false;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/contacts/' + contactId + '/provider-sources/' + link.public_id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, expected_epoch: epoch, expected_revision: link.revision, expected_policy_revision: rule.revision, expected_edit_revision: person.edit_revision }) });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not save these field choices. Reload while keeping your choices.'));
      await load(); setNotice('Google source field choices saved.'); return true;
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save field choices.'); return false; }
    finally { setBusy(false); }
  }
  return <section className="space-y-4" aria-label="Google sources">
    {notice && <p role="status">{notice}</p>}
    {error && <div role="alert"><p>{error}</p><Button className="mt-2" variant="outline" disabled={busy} onClick={() => load().catch((err) => setError(err.message))}>Reload Google sources</Button></div>}
    {links.map((link) => { const original = readProviderFacts(link.original_facts), observed = readProviderFacts(link.observed_facts), applied = readAppliedProviderFields(link.applied_fields);
      return <article key={link.public_id} className="space-y-3 rounded-xl border p-4"><h2 className="text-lg font-semibold">Google Contacts</h2><p className="break-all text-sm">{link.account_email}</p>
        <p className="text-sm">Saved observation · {link.status === 'available' ? 'Source available' : 'Source unavailable'} · {new Date(link.observed_at).toLocaleDateString()}</p>
        <h3 className="font-medium">Original source details</h3><Facts facts={original} />
        {link.original_facts !== link.observed_facts && <><h3 className="font-medium">Last observed source details</h3><Facts facts={observed} /></>}
        <details><summary className="cursor-pointer py-3">Fields accepted from this source</summary><div className="space-y-1 text-sm">{applied.name && <p className="break-words">Name: {applied.name}</p>}{applied.methods.map((item) => <p key={item.method.id} className="break-all">{item.method.kind}: {item.method.value}</p>)}{!applied.name && !applied.methods.length && <p>Source details only; no CRM fields selected.</p>}</div></details>
        {person && rules.find((rule) => rule.source_public_id === link.public_id) ? <GoogleSourceControls link={link} person={person} rules={rules.find((rule) => rule.source_public_id === link.public_id)!} busy={busy} save={(body) => saveFields(link, rules.find((rule) => rule.source_public_id === link.public_id)!, body)} /> : <p className="text-sm text-muted-foreground">Your later corrections remain in the person’s details.</p>}
        <Button variant="outline" disabled={busy} onClick={() => setConfirm(link)}>Unlink Google source</Button>
      </article>;
    })}
    <Link className="inline-block py-3 underline" href="/connections/google">Connect or review Google Contacts</Link>
    <ConfirmDialog open={confirm !== null} title="Unlink Google source?" description="Remove this link and its saved Google source details." safetyNote="The person, imported contact methods, private notes and relationship history stay in Everclose." safetyTone="irreversible" confirmLabel="Unlink source" pending={busy} onCancel={() => setConfirm(null)} onConfirm={() => void unlink()} />
  </section>;
}
