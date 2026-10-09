'use client';

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowRight, CalendarClock, Check, CircleCheck, Mail, MessageCircle, Phone, RotateCcw } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Button, buttonVariants } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { getResponseErrorMessage } from '@/lib/utils';
import type { DailyFeedItem } from '@/lib/intelligence';
import type { TodaySnooze } from '@/lib/today-snooze';

type ActivityType = 'call' | 'message' | 'meetup' | 'email';

function localDateAfter(days: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function displayDate(value: string): string {
  return new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function TodayCard({ item, onChanged }: { item: DailyFeedItem; onChanged: () => void }) {
  const { toast } = useToast();
  const [panel, setPanel] = useState<'reach' | 'log' | 'snooze' | null>(null);
  const [type, setType] = useState<ActivityType>('message');
  const [summary, setSummary] = useState('');
  const [date, setDate] = useState(() => localDateAfter(0));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logKey = useRef<string | null>(null);
  const additionalReasons = item.reasons?.filter((reason) => reason.id !== item.id) || [];

  const toggle = (next: typeof panel) => {
    setError(null);
    setPanel((current) => current === next ? null : next);
  };

  const log = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!item.contactId || !summary.trim() || pending) return;
    const key = logKey.current || crypto.randomUUID();
    logKey.current = key;
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ contact_id: item.contactId, date, type, summary: summary.trim() }),
      });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not log this moment.'));
      logKey.current = null;
      setPanel(null);
      toast({ message: `Logged your ${type} with ${item.contactName || 'this person'}.` });
      onChanged();
    } catch (reason) {
      setError(reason instanceof TypeError ? 'Could not confirm the save. Your note is still here; retry without changing it.'
        : reason instanceof Error ? reason.message : 'Could not confirm the save. Your note is still here; retry without changing it.');
    } finally { setPending(false); }
  };

  const snooze = async (days: number) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const until = localDateAfter(days);
      const response = await fetch('/api/today/snooze', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, until, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not snooze this prompt.'));
      toast({ message: `Snoozed until ${displayDate(until)}. You can bring it back below.` });
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not snooze this prompt.');
    } finally { setPending(false); }
  };

  const complete = async () => {
    if (!item.reminderId || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/reminders/${item.reminderId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed: true }),
      });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not complete this reminder.'));
      const result = await response.json() as { completionChanged?: boolean };
      toast({ message: result.completionChanged === false ? 'Reminder was already completed.' : 'Reminder completed. This did not log a conversation.' });
      onChanged();
    } catch (reason) {
      setError(reason instanceof TypeError ? 'Could not confirm completion. It is safe to try again.'
        : reason instanceof Error ? reason.message : 'Could not confirm completion. It is safe to try again.');
    } finally { setPending(false); }
  };

  return <article className="rounded-2xl border border-border/70 bg-card p-5 shadow-card">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        {item.contactName && <div className="mb-3 flex items-center gap-3"><Avatar contact={{ name: item.contactName }} size="sm" /><span className="text-lg font-semibold">{item.contactName}</span></div>}
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${item.priority === 'high' ? 'bg-secondary text-primary' : 'bg-warning-soft text-warning'}`}>{item.type === 'birthday' ? 'Birthday' : item.type === 'reminder' ? 'Reminder' : 'Check-in'}</span>
        </div>
        <h3 className="mt-3 text-lg font-semibold leading-tight text-foreground">{item.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
      </div>
      <Link href={item.href} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary hover:underline">Profile <ArrowRight className="h-4 w-4" /></Link>
    </div>
    {additionalReasons.length > 0 && <div className="mt-4 flex flex-wrap gap-2" aria-label="Other reasons to connect">
      {additionalReasons.map((reason) => <span key={reason.id} className="rounded-full bg-muted/70 px-3 py-1 text-xs text-foreground">{reason.title}</span>)}
    </div>}
    {item.lastInteraction && <div className="mt-4 rounded-xl bg-muted px-3.5 py-3 text-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Last conversation · {displayDate(item.lastInteraction.date)}</p>
      <p className="mt-1 text-foreground">{item.lastInteraction.summary || `${item.lastInteraction.type} logged`}</p>
    </div>}
    {item.contactId && <div className="mt-4 flex flex-wrap gap-2 border-t border-border/60 pt-4">
      <Button type="button" size="sm" disabled={pending} onClick={() => toggle('reach')} aria-expanded={panel === 'reach'}><Phone className="h-3.5 w-3.5" />Reach out</Button>
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => toggle('log')} aria-expanded={panel === 'log'}><MessageCircle className="h-3.5 w-3.5" />Log a moment</Button>
      {item.reminderId && <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void complete()} aria-label={`Mark ${item.title} as done`}><CircleCheck className="h-3.5 w-3.5" />{pending ? 'Working...' : 'Mark done'}</Button>}
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => toggle('snooze')} aria-expanded={panel === 'snooze'}><CalendarClock className="h-3.5 w-3.5" />Snooze</Button>
    </div>}
    {panel === 'reach' && <div className="mt-3 rounded-xl border border-border/70 bg-muted p-4">
      <p className="text-sm font-medium">How would you like to connect?</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {item.contactPhone && <a href={`tel:${item.contactPhone}`} className={buttonVariants({ size: 'sm', variant: 'outline' })}><Phone className="h-3.5 w-3.5" />Call</a>}
        {item.contactEmail && <a href={`mailto:${item.contactEmail}`} className={buttonVariants({ size: 'sm', variant: 'outline' })}><Mail className="h-3.5 w-3.5" />Email</a>}
        {!item.contactPhone && !item.contactEmail && <Link href={item.href} className={buttonVariants({ size: 'sm', variant: 'outline' })}>Open profile</Link>}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Opening a contact method does not mark this as done. Log the conversation when it happens.</p>
    </div>}
    {panel === 'log' && <form onSubmit={(event) => void log(event)} className="mt-3 rounded-xl border border-border/70 bg-muted p-4">
      <p className="text-sm font-medium">Capture what happened</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr]">
        <label className="text-xs font-medium text-foreground">Type
          <select value={type} disabled={pending} onChange={(event) => { setType(event.target.value as ActivityType); logKey.current = null; }} className="mt-1 block min-h-11 w-full rounded-lg border border-input bg-card px-3 text-sm">
            <option value="message">Message</option><option value="call">Call</option><option value="email">Email</option><option value="meetup">Meetup</option>
          </select>
        </label>
        <label className="text-xs font-medium text-foreground">Date
          <input type="date" value={date} max={localDateAfter(0)} disabled={pending} onChange={(event) => { setDate(event.target.value); logKey.current = null; }} required className="mt-1 block min-h-11 w-full rounded-lg border border-input bg-card px-3 text-sm" />
        </label>
      </div>
      <label className="mt-3 block text-xs font-medium text-foreground">What would you like to remember?
        <textarea value={summary} maxLength={500} rows={2} disabled={pending} onChange={(event) => { setSummary(event.target.value); logKey.current = null; }} required placeholder="A quick detail from your conversation" className="mt-1 block w-full rounded-lg border border-input bg-card p-3 text-sm" />
      </label>
      <div className="mt-3 flex gap-2"><Button type="submit" size="sm" disabled={pending || !summary.trim()}><Check className="h-3.5 w-3.5" />{pending ? 'Saving...' : 'Save moment'}</Button><Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setPanel(null)}>Cancel</Button></div>
    </form>}
    {panel === 'snooze' && <div className="mt-3 rounded-xl border border-border/70 bg-muted p-4">
      <p className="text-sm font-medium">Bring this prompt back</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {[{ days: 1, label: 'Tomorrow' }, { days: 7, label: 'In a week' }, { days: 30, label: 'In 30 days' }].map((option) => <Button key={option.days} type="button" variant="outline" size="sm" disabled={pending} onClick={() => void snooze(option.days)}>{option.label}</Button>)}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Only this reason is snoozed. A separate birthday or reminder for the same person will still appear.</p>
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
  </article>;
}

export function TodayFocus({ items, snoozes, onChanged }: { items: DailyFeedItem[]; snoozes: TodaySnooze[]; onChanged: () => void }) {
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const { toast } = useToast();

  const restore = async (id: string) => {
    setRestoringId(id);
    setRestoreError(null);
    try {
      const response = await fetch('/api/today/snooze', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not bring this prompt back.'));
      toast({ message: 'Prompt returned to your Today queue.' });
      onChanged();
    } catch (reason) {
      setRestoreError(reason instanceof Error ? reason.message : 'Could not bring this prompt back.');
    } finally { setRestoringId(null); }
  };

  return <section aria-labelledby="today-focus-title" className="space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <h2 id="today-focus-title" className="text-lg font-semibold text-foreground">Next up</h2>
      <Link href="/reminders" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary hover:underline">All reminders <ArrowRight className="h-4 w-4" /></Link>
    </div>
    {items.length ? <div className="grid gap-3 lg:grid-cols-2">{items.map((item) => <TodayCard key={item.id} item={item} onChanged={onChanged} />)}</div>
      : <div className="rounded-2xl border border-dashed border-border bg-card/80 px-6 py-12 text-center"><Check className="mx-auto h-8 w-8 text-emerald-600" /><h3 className="mt-3 text-lg font-semibold">You&apos;re caught up</h3><p className="mt-1 text-sm text-muted-foreground">Nothing needs your attention right now. New reasons will appear as dates and reminders come due.</p><Link href="/calendar" className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">Explore your calendar <ArrowRight className="h-4 w-4" /></Link></div>}
    {snoozes.length > 0 && <details className="rounded-xl border border-border/70 bg-card/80 px-4 py-3">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-foreground">Snoozed prompts ({snoozes.length})</summary>
      <div className="mt-3 divide-y divide-border/60">
        {snoozes.map((snooze) => <div key={snooze.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
          <div><p className="font-medium">{snooze.reminder_title || (snooze.id.startsWith('birthday-') ? `${snooze.contact_name || 'Contact'}'s birthday` : `Reconnect with ${snooze.contact_name || 'contact'}`)}</p><p className="text-xs text-muted-foreground">Returns {displayDate(snooze.until_date)}</p></div>
          <Button type="button" variant="ghost" size="sm" disabled={restoringId !== null} onClick={() => void restore(snooze.id)}><RotateCcw className="h-3.5 w-3.5" />{restoringId === snooze.id ? 'Restoring...' : 'Bring back'}</Button>
        </div>)}
      </div>
      {restoreError && <p role="alert" className="mt-2 text-sm text-destructive">{restoreError}</p>}
    </details>}
  </section>;
}
