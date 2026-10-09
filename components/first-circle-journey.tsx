'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CalendarDays, Check, Heart, MessageSquare, Search, Users } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FIRST_CIRCLE_TAG, MAX_FIRST_CIRCLE_SIZE, type FirstStepsSnapshot } from '@/lib/first-steps';
import { getResponseErrorMessage } from '@/lib/utils';

type ContactOption = { id: number; name: string };

export function FirstCircleJourney({ snapshot, onChanged }: { snapshot: FirstStepsSnapshot; onChanged: () => void }) {
  const [pickerOpen, setPickerOpen] = useState(snapshot.circleCount === 0);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<ContactOption[]>([]);
  const [selected, setSelected] = useState<ContactOption[]>([]);
  const [loading, setLoading] = useState(snapshot.circleCount === 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slotsRemaining = Math.max(0, MAX_FIRST_CIRCLE_SIZE - snapshot.circleCount);
  const memberIds = new Set(snapshot.circlePeople.map((person) => person.id));
  const available = options.filter((person) => !memberIds.has(person.id));
  const nextPerson = snapshot.circlePeople[0];

  useEffect(() => {
    if (!pickerOpen) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ view: 'mentions', search: query.trim(), limit: '20' });
        const response = await fetch(`/api/contacts?${params}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not load people'));
        const data = await response.json() as { contacts?: ContactOption[] };
        if (!controller.signal.aborted) {
          setOptions(Array.isArray(data.contacts) ? data.contacts : []);
          setError(null);
        }
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setOptions([]);
          setError(loadError instanceof Error ? loadError.message : 'Could not load people');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [pickerOpen, query]);

  function toggle(person: ContactOption) {
    setSelected((current) => current.some((item) => item.id === person.id)
      ? current.filter((item) => item.id !== person.id)
      : current.length < slotsRemaining ? [...current, person] : current);
  }

  async function saveCircle() {
    if (selected.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/contacts/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'add_tag', tag: FIRST_CIRCLE_TAG, contactIds: selected.map((person) => person.id) }),
      });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not save your circle'));
      setSelected([]);
      setPickerOpen(false);
      onChanged();
    } catch (saveError) {
      setError(saveError instanceof Error
        ? `${saveError.message} You can retry the same selection safely.`
        : 'Could not confirm the change. You can retry the same selection safely.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="first-circle-title" className="relative overflow-hidden rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-7">
      <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full border border-rose-200/50" aria-hidden="true" />
      <div className="relative">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.17em] text-primary"><Heart className="h-3.5 w-3.5" aria-hidden="true" /> Your first circle</p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="first-circle-title" className="max-w-2xl text-2xl font-bold tracking-tight sm:text-3xl">Start close, not wide.</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">Choose a few people you want to show up for. Add one detail, then capture a real conversation or plan when to reach out. You never need to import everyone.</p>
          </div>
          <span className="w-fit shrink-0 rounded-full border border-rose-200 bg-card/80 px-3 py-1.5 text-xs font-semibold text-rose-800">{snapshot.circleCount} in your circle</span>
        </div>

        <div className="mt-6 grid items-start gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-xl border border-border/70 bg-muted p-4 shadow-sm sm:p-5">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-100 text-primary"><Users className="h-4 w-4" aria-hidden="true" /></span>
              <div>
                <h3 className="font-semibold">01 / Pick your people</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">This adds the “{FIRST_CIRCLE_TAG}” tag only to the people you choose. You can change it later in Groups.</p>
              </div>
            </div>

            {snapshot.circlePeople.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {snapshot.circlePeople.map((person) => (
                  <Link key={person.id} href={`/contacts/${person.id}`} className="rounded-full border border-rose-200 bg-secondary px-3 py-1.5 text-xs font-semibold text-rose-900 hover:bg-rose-100">{person.name}</Link>
                ))}
              </div>
            )}

            {slotsRemaining > 0 && !pickerOpen && (
              <Button type="button" variant="outline" size="sm" className="mt-4 min-h-10" onClick={() => { setLoading(true); setPickerOpen(true); }}>{snapshot.circleCount ? 'Add another person' : 'Choose people'}</Button>
            )}
            {pickerOpen && slotsRemaining > 0 && (
              <div className="mt-4 space-y-3">
                <label htmlFor="first-circle-search" className="text-xs font-semibold">Search your people</label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <Input id="first-circle-search" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setOptions([]); setError(null); setLoading(true); }} placeholder="Find someone by name" className="h-10 pl-9" />
                </div>
                {selected.length > 0 && <p className="text-xs text-muted-foreground">Selected: {selected.map((person) => person.name).join(', ')}</p>}
                {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                {loading ? <p role="status" className="text-xs text-muted-foreground">Finding people...</p> : (
                  <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border/70 bg-card p-1">
                    {available.length > 0 ? available.map((person) => {
                      const checked = selected.some((item) => item.id === person.id);
                      return (
                        <label key={person.id} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-3 text-sm hover:bg-secondary">
                          <input type="checkbox" checked={checked} disabled={!checked && selected.length >= slotsRemaining} onChange={() => toggle(person)} className="h-4 w-4 accent-primary" />
                          <span className="flex-1 truncate">{person.name}</span>
                          {checked && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
                        </label>
                      );
                    }) : <p className="px-3 py-2 text-xs text-muted-foreground">No matching people. <Link href="/contacts/new" className="font-semibold text-primary underline">Add someone</Link></p>}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" className="min-h-10" disabled={!selected.length || saving} onClick={() => void saveCircle()}>{saving ? 'Saving...' : `Add ${selected.length || ''} to my circle`}</Button>
                  {snapshot.circleCount > 0 && <Button type="button" variant="ghost" size="sm" className="min-h-10" onClick={() => { setPickerOpen(false); setSelected([]); setError(null); }}>Cancel</Button>}
                </div>
              </div>
            )}
            {slotsRemaining === 0 && <Link href="/groups" className="mt-4 inline-flex min-h-10 items-center text-sm font-semibold text-primary hover:underline">Manage this group <ArrowRight className="ml-1 h-4 w-4" aria-hidden="true" /></Link>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            <div className="rounded-xl border border-border/70 bg-muted p-4 shadow-sm sm:p-5">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-800"><CalendarDays className="h-4 w-4" aria-hidden="true" /></span>
                <div>
                  <h3 className="font-semibold">02 / Remember a detail</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">A birthday or your preferred check-in rhythm gives future you a reason to reconnect.</p>
                </div>
              </div>
              {nextPerson && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs font-semibold">
                <Link href={`/contacts/${nextPerson.id}/edit?focus=birthday`} className="text-primary hover:underline">{nextPerson.birthdayKnown ? 'Review birthday' : `Add ${nextPerson.name}'s birthday`}</Link>
                <Link href={`/contacts/${nextPerson.id}/edit?focus=cadence`} className="text-primary hover:underline">Choose a check-in rhythm</Link>
              </div>}
              {!nextPerson && <p className="mt-3 text-xs text-muted-foreground">Choose a person first, or add these details from any profile later.</p>}
            </div>
            <div className="rounded-xl border border-border/70 bg-muted p-4 shadow-sm sm:p-5">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-success"><MessageSquare className="h-4 w-4" aria-hidden="true" /></span>
                <div>
                  <h3 className="font-semibold">03 / Take one real step</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Log a conversation you actually had, or set a reminder for one you want to have. Opening a message app does not count as contact.</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={nextPerson ? `/contacts/${nextPerson.id}?capture=moment` : '/contacts?intent=log'} className={buttonVariants({ size: 'sm', className: 'min-h-10' })}>Log a moment</Link>
                <Link href="/calendar?create=reminder" className={buttonVariants({ variant: 'outline', size: 'sm', className: 'min-h-10' })}>Plan a reminder</Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
