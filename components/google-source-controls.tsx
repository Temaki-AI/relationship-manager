'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { readContactMethods } from '@/packages/domain/src/contact-methods';
import { readProviderFacts, type ProviderSource } from '@/packages/domain/src/provider-sources';
import type { ProviderRuleMode, SavedProviderRules } from '@/packages/domain/src/provider-rules';
type Person = { name: string; contact_methods: string; edit_revision: string };
const inputClass = 'min-h-11 w-full min-w-0 rounded-md border bg-background px-3';
const issues = { missing: 'The source field is missing. Your value is kept.', ambiguous: 'More than one source field could match. Choose a saved value to continue.', invalid: 'The source value cannot be used safely. Your value is kept.', capacity: 'The source grew beyond the saved-source limit. Your value is kept.' };
export function GoogleSourceControls({ link, rules, person, busy, save }: { link: ProviderSource; rules: SavedProviderRules; person: Person; busy: boolean;
  save: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [nameMode, setNameMode] = useState<ProviderRuleMode>(rules.fields.name.mode);
  const [modes, setModes] = useState<Record<string, ProviderRuleMode>>({});
  const [selection, setSelection] = useState({ facts: link.observed_facts, slots: {} as Record<string, number>, emails: [] as number[], phones: [] as number[] });
  const sourceChanged = selection.facts !== link.observed_facts;
  const choices = sourceChanged ? { facts: link.observed_facts, slots: {} as Record<string, number>, emails: [] as number[], phones: [] as number[] } : selection;
  const { slots, emails, phones } = choices;
  const setSlots = (value: Record<string, number>) => setSelection({ ...choices, slots: value });
  const setEmails = (value: number[]) => setSelection({ ...choices, emails: value });
  const setPhones = (value: number[]) => setSelection({ ...choices, phones: value });
  const [follow, setFollow] = useState(false);
  const facts = readProviderFacts(link.observed_facts), methods = readContactMethods(person.contact_methods);
  function toggle(index: number, selected: number[], change: (value: number[]) => void) { change(selected.includes(index) ? selected.filter((i) => i !== index) : [...selected, index]); }
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">Following uses saved Google details now and keeps the value current on future downloads. Your edits pause that field until you explicitly use Google’s saved value again. Labels, preferred methods and private history stay yours.</p>
    {sourceChanged && <p role="status" className="text-sm">Saved Google details changed. Choose source values again; your field update choices are retained.</p>}
    <fieldset disabled={busy} className="space-y-4"><legend className="font-medium">Field update choices</legend>
      <div className="space-y-2"><label className="block text-sm" htmlFor={link.public_id + '-name'}>Name: {person.name}</label>
        <select id={link.public_id + '-name'} className={inputClass} value={nameMode} onChange={(event) => setNameMode(event.target.value as ProviderRuleMode)}><option value="keep">Keep my value</option><option value="follow">Follow Google</option></select>
        {rules.fields.name.overridden && <p className="text-sm">Your name correction is protected.</p>}
        {rules.fields.name.issue && <p className="text-sm">{issues[rules.fields.name.issue]}</p>}
        {facts.name && <Button className="h-auto min-h-11 whitespace-normal text-left" variant="outline" onClick={() => void save({ action: 'reset', field: 'name' })}>Use saved Google name: {facts.name}</Button>}
      </div>
      {rules.fields.methods.map((rule) => { const method = methods.find((method) => method.id === rule.id), collection = rule.kind === 'email' ? facts.emails : facts.phones;
        return <div key={rule.id} className="space-y-2 border-t pt-3"><label className="block break-all text-sm" htmlFor={link.public_id + rule.id + '-mode'}>{rule.kind === 'email' ? 'Email' : 'Phone'}: {method?.value ?? 'Removed from this person'}</label>
          <select id={link.public_id + rule.id + '-mode'} className={inputClass} value={modes[rule.id] ?? rule.mode} onChange={(event) => setModes({ ...modes, [rule.id]: event.target.value as ProviderRuleMode })}><option value="keep">Keep my value</option><option value="follow">Follow Google</option></select>
          {rule.overridden && <p className="text-sm">Your correction or removal is protected.</p>}{rule.issue && <p className="text-sm">{issues[rule.issue]}</p>}
          {!!collection.length && <><label htmlFor={link.public_id + rule.id + '-slot'} className="block text-sm">Saved Google {rule.kind === 'email' ? 'email' : 'phone'} to use</label>
            <select id={link.public_id + rule.id + '-slot'} className={inputClass} value={slots[rule.id] ?? ''} onChange={(event) => setSlots({ ...slots, [rule.id]: Number(event.target.value) })}><option value="" disabled>Choose a saved source value</option>{collection.map((slot, index) => <option key={index} value={index}>{slot.value}{slot.label ? ` (${slot.label})` : ''}</option>)}</select>
            <Button variant="outline" disabled={slots[rule.id] === undefined} onClick={() => void save({ action: 'reset', field: 'method', method_id: rule.id, source_index: slots[rule.id] })}>Use selected Google value</Button></>}
        </div>;
      })}
      <Button onClick={() => void save({ action: 'settings', name_mode: nameMode, methods: rules.fields.methods.map((rule) => ({ id: rule.id, mode: modes[rule.id] ?? rule.mode })) })}>Save field choices</Button>
    </fieldset>
    <details><summary className="cursor-pointer py-3">Accept additional saved source fields</summary><fieldset disabled={busy} className="space-y-3"><legend className="sr-only">Additional saved source fields</legend>
      {(['emails', 'phones'] as const).map((kind) => <div key={kind}>{facts[kind].map((slot, index) => <label key={index} className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={(kind === 'emails' ? emails : phones).includes(index)} onChange={() => toggle(index, kind === 'emails' ? emails : phones, kind === 'emails' ? setEmails : setPhones)} /><span className="min-w-0 break-all text-sm">{slot.value}{slot.label ? ` (${slot.label})` : ''}</span></label>)}</div>)}
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /><span className="text-sm">Follow these selected values on future downloads</span></label>
      <p className="text-sm">These are saved source values from {new Date(link.observed_at).toLocaleString()}. Existing preferred methods are kept. Selecting an existing method explicitly accepts it again and clears its protected correction.</p>
      <Button disabled={!emails.length && !phones.length} onClick={async () => { if (await save({ action: 'accept', emails, phones, follow })) { setSelection({ ...choices, emails: [], phones: [] }); } }}>Accept selected fields</Button>
    </fieldset></details>
  </div>;
}
