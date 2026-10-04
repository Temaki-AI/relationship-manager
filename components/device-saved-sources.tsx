'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { readDeviceSources, type DeviceSource } from '@/packages/domain/src/device-sources';
import { readDeviceContactFacts } from '@/packages/domain/src/device-contact-facts';
import { readAppliedProviderFields } from '@/packages/domain/src/provider-sources';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { getResponseErrorMessage } from '@/lib/utils';

function Facts({ value }: { value: string }) {
  const facts = readDeviceContactFacts(value);
  return <div className="space-y-1 text-sm"><p className="break-words">{facts.name || 'Name not provided'}</p>
    {facts.emails.concat(facts.phones).map((method, index) => <p key={index} className="break-all">{method.value}{method.label ? ` (${method.label})` : ''}</p>)}
  </div>;
}
export function DeviceSavedSources({ contactId }: { contactId: string }) {
  const [links, setLinks] = useState<DeviceSource[]>([]), [epoch, setEpoch] = useState<string | null>(null), [personId, setPersonId] = useState<string | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState<DeviceSource | null>(null), [draft, setDraft] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(`/api/contacts/${contactId}/device-sources`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Unable to load saved iPhone sources.'));
    const data = await response.json();
    if (data.epoch !== null && (!isSyncUuid(data.epoch) || !isSyncUuid(data.contact_id))) throw new Error('Invalid saved-source response. Refresh this page.');
    setLinks(readDeviceSources(JSON.stringify(data.links))); setEpoch(data.epoch); setPersonId(data.contact_id); setError('');
  }, [contactId]);
  useEffect(() => { let active = true; void load().catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Unable to load source details.'); }); return () => { active = false; }; }, [load]);
  async function unlink() {
    if (!confirm || !epoch || !personId || busy) return;
    const body = draft ?? JSON.stringify({ operation_id: crypto.randomUUID(), epoch, action: 'unlink', source_id: confirm.public_id,
      contact_id: personId, installation_id: confirm.installation_id, external_id: confirm.external_id, expected_revision: confirm.revision });
    setDraft(body); setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/device-sources/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Unable to confirm the unlink. Retry the same request or reload source details.'));
      await load(); setConfirm(null); setDraft(null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to confirm this unlink. Retry it.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="iPhone sources" className="space-y-4">
    <h2 className="text-lg font-semibold">iPhone Contacts</h2>
    {error && !confirm && <div role="alert"><p>{error}</p><Button className="mt-2" variant="outline" disabled={busy} onClick={() => { setConfirm(null); setDraft(null); void load().catch((err) => setError(err.message)); }}>Reload iPhone sources</Button></div>}
    {links.length === 0 && <p className="text-sm text-muted-foreground">Choose a contact in the iPhone app and confirm sharing its source details to see it here.</p>}
    {links.map((link) => { const accepted = readAppliedProviderFields(link.applied_fields);
      return <article key={link.public_id} className="space-y-3 rounded-xl border p-4">
        <p className="text-sm">Saved phone observation · {new Date(link.observed_at).toLocaleDateString()}</p>
        <h3 className="font-medium">Original source details</h3><Facts value={link.original_facts} />
        {link.original_facts !== link.observed_facts && <><h3 className="font-medium">Last observed source details</h3><Facts value={link.observed_facts} /></>}
        <details><summary className="cursor-pointer py-3">Fields accepted from this source</summary><div className="space-y-1 text-sm">
          {accepted.name && <p className="break-words">Name: {accepted.name}</p>}{accepted.methods.map((item) => <p key={item.method.id} className="break-all">{item.method.kind}: {item.method.value}</p>)}
          {!accepted.name && !accepted.methods.length && <p>Source details only; no profile fields selected.</p>}
        </div></details>
        <p className="text-sm text-muted-foreground">These are saved observations from your phone. Choose this contact on that phone to review later changes. Your person’s corrections and private history remain intact.</p>
        <Button variant="outline" disabled={busy || !epoch} onClick={() => { setConfirm(link); setDraft(null); }}>Unlink iPhone source</Button>
      </article>;
    })}
    <ConfirmDialog open={confirm !== null} title="Unlink iPhone source?" description="Remove this shared link and its saved iPhone details from your account. Online devices will receive the removal on their next sync."
      safetyNote="The person, accepted contact methods and private relationship history stay in Everclose. No iPhone address-book entry is changed." safetyTone="irreversible" confirmLabel="Unlink source" pending={busy}
      onCancel={() => { setConfirm(null); setDraft(null); }} onConfirm={() => void unlink()}>
      {error && <p role="alert" className="mt-4 text-sm">{error}</p>}
    </ConfirmDialog>
  </section>;
}
