'use client';

import { useEffect, useRef, useState, type ElementType, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import {
  Bell,
  CakeSlice,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Filter,
  History,
  List,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import type { CalendarEvent, CalendarEventKind, CoreCalendarEvent } from '@/lib/calendar-directory';
import { calendarEventDates, calendarEventPeople } from '@/lib/calendar-directory';
import { createIdempotencyKey, getResponseErrorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LoadError } from '@/components/ui/load-error';
import { useToast } from '@/components/ui/toast';
import { SavedCalendarEventCard } from '@/components/saved-calendar-event-card';
import { CalendarReschedule } from '@/components/calendar-reschedule';

type CalendarResponse = {
  events: CalendarEvent[];
  range: { start: string; end: string };
  truncated: boolean;
  source_events_available?: boolean;
  source_truncated?: boolean;
  source_date_uncertain?: boolean;
};

type CalendarView = 'month' | 'agenda';
type ContactOption = { id: number; name: string };
const VIEW_KEY = 'everclose:calendar-view';
const FILTERS_KEY = 'everclose:calendar-filters';

const EVENT_STYLES: Record<CalendarEventKind, {
  label: string;
  icon: ElementType;
  dot: string;
  chip: string;
  panel: string;
}> = {
  birthday: {
    label: 'Birthdays',
    icon: CakeSlice,
    dot: 'bg-secondary0',
    chip: 'border-rose-200 bg-secondary text-primary',
    panel: 'bg-rose-100 text-primary',
  },
  reminder: {
    label: 'Reminders',
    icon: Bell,
    dot: 'bg-warning-soft0',
    chip: 'border-amber-200 bg-warning-soft text-warning',
    panel: 'bg-amber-100 text-warning',
  },
  plan: {
    label: 'Plans',
    icon: Sparkles,
    dot: 'bg-blue-500',
    chip: 'border-blue-200 bg-blue-50 text-blue-800',
    panel: 'bg-blue-100 text-blue-700',
  },
  interaction: {
    label: 'History',
    icon: History,
    dot: 'bg-success-soft0',
    chip: 'border-emerald-200 bg-success-soft text-success',
    panel: 'bg-emerald-100 text-success',
  },
  source_event: {
    label: 'Google meetings', icon: CalendarDays, dot: 'bg-violet-500',
    chip: 'border-violet-200 bg-violet-50 text-violet-800', panel: 'bg-violet-100 text-violet-800',
  },
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function formatEventTime(event: CalendarEvent): string | null {
  if (!event.starts_at) return null;
  const date = new Date(event.starts_at);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function CalendarSkeleton() {
  return (
    <div className="space-y-5" aria-label="Loading calendar">
      <div className="skeleton h-20 rounded-2xl" />
      <div className="skeleton h-24 rounded-2xl" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="skeleton h-[36rem] rounded-2xl" />
        <div className="skeleton h-[28rem] rounded-2xl" />
      </div>
    </div>
  );
}

function EventDetail({ event, completing, onComplete, onReschedule }: {
  event: CalendarEvent;
  completing: boolean;
  onComplete: (event: CalendarEvent) => void;
  onReschedule: (event: CoreCalendarEvent) => void;
}) {
  if (event.kind === 'source_event') return <SavedCalendarEventCard event={event.source} />;
  const style = EVENT_STYLES[event.kind];
  const Icon = style.icon;
  const time = formatEventTime(event);
  return (
    <article className={`rounded-xl border p-3.5 ${style.chip} ${event.completed ? 'border-dashed' : ''}`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 rounded-lg p-2 ${style.panel}`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className={`text-sm font-semibold leading-snug ${event.completed ? 'line-through' : ''}`}>
              {event.title}
            </h3>
            {event.completed && (
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-label="Completed" />
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {time && (
              <span className="inline-flex items-center gap-1">
                <Clock3 className="h-3 w-3" aria-hidden="true" />
                {time}
              </span>
            )}
            <Link href={`/contacts/${event.contact_id}`} className="font-medium underline-offset-2 hover:underline">
              {event.contact_name}
            </Link>
            <span className="capitalize">{event.subtype.replaceAll('_', ' ')}</span>
          </div>
          {event.detail && <p className="mt-2 line-clamp-2 text-xs leading-relaxed">{event.detail}</p>}
          {!event.completed && (event.kind === 'reminder' || event.kind === 'plan') && (
            <div className="mt-3 flex flex-wrap gap-2"><button
              type="button"
              disabled={completing}
              onClick={() => onComplete(event)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-current/20 bg-card/70 px-3 text-xs font-semibold hover:bg-card disabled:opacity-50"
              aria-label={`Mark ${event.kind} ${event.title} done`}
            >
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              {completing ? 'Saving...' : 'Mark done'}
            </button><button type="button" disabled={completing} onClick={() => onReschedule(event)} aria-label={`Reschedule ${event.kind} ${event.title}`}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-current/20 bg-card/70 px-3 text-xs font-semibold hover:bg-card disabled:opacity-50">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />Reschedule
            </button></div>
          )}
        </div>
      </div>
    </article>
  );
}

export default function CalendarPage() {
  const createFromMenu = useSearchParams().get('create') === 'reminder';
  const [currentMonth, setCurrentMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [view, setView] = useState<CalendarView>('month');
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [sourceEventsAvailable, setSourceEventsAvailable] = useState(false);
  const [sourceTruncated, setSourceTruncated] = useState(false);
  const [sourceDateUncertain, setSourceDateUncertain] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState('');
  const [contactId, setContactId] = useState('all');
  const [showCompleted, setShowCompleted] = useState(true);
  const [activeKinds, setActiveKinds] = useState<Record<CalendarEventKind, boolean>>({
    birthday: true,
    reminder: true,
    plan: true,
    interaction: true,
    source_event: true,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [contactOptions, setContactOptions] = useState<ContactOption[]>([]);
  const [contactOptionsLoading, setContactOptionsLoading] = useState(true);
  const [selectedContact, setSelectedContact] = useState<ContactOption | null>(null);
  const [contactSearchError, setContactSearchError] = useState<string | null>(null);
  const [reminderTitle, setReminderTitle] = useState('');
  const [reminderAt, setReminderAt] = useState('');
  const [creating, setCreating] = useState(false);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<CoreCalendarEvent | null>(null);
  const createAttempt = useRef<{ payload: string; key: string } | null>(null);
  const focusReminderOnOpen = useRef(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!createFromMenu) return;
    const today = format(new Date(), 'yyyy-MM-dd');
    setSelectedDate(today);
    setCurrentMonth(startOfMonth(new Date()));
    setReminderAt(`${today}T09:00`);
    setContactOptionsLoading(true);
    focusReminderOnOpen.current = true;
    setCreateOpen(true);
    const url = new URL(window.location.href);
    url.searchParams.delete('create');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [createFromMenu]);

  useEffect(() => {
    if (!createOpen || !focusReminderOnOpen.current) return;
    const title = document.getElementById('calendar-reminder-title');
    if (!title) return;
    focusReminderOnOpen.current = false;
    title.focus();
    document.getElementById('calendar-reminder-form')?.scrollIntoView({ behavior: 'auto', block: 'start' });
  }, [createOpen, loading]);

  useEffect(() => {
    try {
      const savedView = localStorage.getItem(VIEW_KEY);
      setView(savedView === 'month' || savedView === 'agenda'
        ? savedView
        : window.matchMedia('(max-width: 639px)').matches ? 'agenda' : 'month');
      const savedFilters = JSON.parse(localStorage.getItem(FILTERS_KEY) || 'null') as Record<string, unknown> | null;
      if (savedFilters && typeof savedFilters === 'object') {
        if (typeof savedFilters.query === 'string') setQuery(savedFilters.query.slice(0, 200));
        if (typeof savedFilters.contactId === 'string') setContactId(savedFilters.contactId);
        if (typeof savedFilters.showCompleted === 'boolean') setShowCompleted(savedFilters.showCompleted);
        if (savedFilters.activeKinds && typeof savedFilters.activeKinds === 'object') {
          const kinds = savedFilters.activeKinds as Record<string, unknown>;
          setActiveKinds({
            birthday: kinds.birthday !== false,
            reminder: kinds.reminder !== false,
            plan: kinds.plan !== false,
            interaction: kinds.interaction !== false,
            source_event: kinds.source_event !== false,
          });
        }
      }
    } catch {
      setView(window.matchMedia('(max-width: 639px)').matches ? 'agenda' : 'month');
    }
    setPreferencesReady(true);
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    try {
      localStorage.setItem(VIEW_KEY, view);
      localStorage.setItem(FILTERS_KEY, JSON.stringify({ query, contactId, showCompleted, activeKinds }));
    } catch {
      // Calendar controls still work if browser storage is unavailable.
    }
  }, [preferencesReady, view, query, contactId, showCompleted, activeKinds]);

  useEffect(() => {
    if (!createOpen) return;
    let cancelled = false;
    setContactOptionsLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ view: 'mentions', search: contactSearch, limit: '20' });
        const response = await fetch(`/api/contacts?${params}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not find contacts'));
        const data = await response.json() as { contacts?: ContactOption[] };
        if (!cancelled) {
          setContactOptions(Array.isArray(data.contacts) ? data.contacts : []);
          setContactSearchError(null);
        }
      } catch (error) {
        if (!cancelled) setContactSearchError(error instanceof Error ? error.message : 'Could not find contacts');
      } finally {
        if (!cancelled) setContactOptionsLoading(false);
      }
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [contactSearch, createOpen]);

  const visibleStart = startOfWeek(startOfMonth(currentMonth), { weekStartsOn: 1 });
  const visibleEnd = endOfWeek(endOfMonth(currentMonth), { weekStartsOn: 1 });
  const visibleStartKey = format(visibleStart, 'yyyy-MM-dd');
  const visibleEndKey = format(visibleEnd, 'yyyy-MM-dd');
  const calendarDays = eachDayOfInterval({ start: visibleStart, end: visibleEnd });

  useEffect(() => {
    let cancelled = false;
    async function loadCalendar() {
      setLoading(true);
      setLoadError(null);
      try {
        const params = new URLSearchParams({
          start: visibleStartKey,
          end: visibleEndKey,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        });
        const response = await fetch(`/api/calendar?${params}`, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(await getResponseErrorMessage(response, 'Failed to load calendar'));
        }
        const data = await response.json() as CalendarResponse;
        if (!cancelled) {
          const nextEvents = Array.isArray(data.events) ? data.events : [];
          setEvents(nextEvents);
          setTruncated(Boolean(data.truncated));
          setSourceEventsAvailable(Boolean(data.source_events_available || nextEvents.some((event) => event.kind === 'source_event')));
          setSourceTruncated(Boolean(data.source_truncated));
          setSourceDateUncertain(Boolean(data.source_date_uncertain));
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load calendar');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadCalendar();
    return () => { cancelled = true; };
  }, [reloadToken, visibleEndKey, visibleStartKey]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredEvents = events.filter((event) => {
    if (!activeKinds[event.kind]) return false;
    if (!showCompleted && event.completed) return false;
    const people = calendarEventPeople(event);
    if (contactId !== 'all' && !people.some((person) => person.id === Number(contactId))) return false;
    if (!normalizedQuery) return true;
    return [event.title, event.detail, ...people.map((person) => person.name), event.subtype,
      ...(event.kind === 'source_event' ? [event.source.calendar_label, event.source.account_email, event.source.facts.location] : [])]
      .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
  });
  const contacts = Array.from(new Map(
    events.flatMap((event) => calendarEventPeople(event).map((person) => [person.id, person.name] as const))
  ).entries()).sort((left, right) => left[1].localeCompare(right[1]));
  const eventsByDate = new Map<string, CalendarEvent[]>();
  const agendaByDate = new Map<string, CalendarEvent[]>();
  for (const event of filteredEvents) {
    const dates = calendarEventDates(event, { start: visibleStartKey, end: visibleEndKey });
    for (const date of dates) {
      const dayEvents = eventsByDate.get(date) || [];
      dayEvents.push(event); eventsByDate.set(date, dayEvents);
    }
    if (dates.length) {
      const dayEvents = agendaByDate.get(dates[0]) || [];
      dayEvents.push(event); agendaByDate.set(dates[0], dayEvents);
    }
  }
  const selectedEvents = eventsByDate.get(selectedDate) || [];
  const availableKinds = (Object.keys(EVENT_STYLES) as CalendarEventKind[]).filter((kind) => kind !== 'source_event' || sourceEventsAvailable);
  const activeFilterCount = availableKinds.filter((kind) => activeKinds[kind]).length;

  function moveMonth(offset: number) {
    const nextMonth = addMonths(currentMonth, offset);
    setCurrentMonth(nextMonth);
    setSelectedDate(format(startOfMonth(nextMonth), 'yyyy-MM-dd'));
  }

  function goToToday() {
    const today = new Date();
    setCurrentMonth(startOfMonth(today));
    setSelectedDate(format(today, 'yyyy-MM-dd'));
  }

  function resetFilters() {
    setQuery('');
    setContactId('all');
    setShowCompleted(true);
    setActiveKinds({ birthday: true, reminder: true, plan: true, interaction: true, source_event: true });
  }

  function openReminder(date = selectedDate) {
    setSelectedDate(date);
    setReminderAt(`${date}T09:00`);
    setContactOptionsLoading(true);
    focusReminderOnOpen.current = true;
    setCreateOpen(true);
  }

  async function createReminder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedContact || !reminderTitle.trim() || !reminderAt) return;
    const parsedDate = new Date(reminderAt);
    if (Number.isNaN(parsedDate.getTime())) {
      toast({ message: 'Choose a valid reminder date and time', variant: 'error' });
      return;
    }
    const payload = JSON.stringify({
      contact_id: selectedContact.id,
      title: reminderTitle.trim(),
      notes: null,
      remind_at: parsedDate.toISOString(),
    });
    const attempt = createAttempt.current?.payload === payload
      ? createAttempt.current
      : { payload, key: createIdempotencyKey() };
    createAttempt.current = attempt;
    setCreating(true);
    try {
      const response = await fetch('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key },
        body: payload,
      });
      if (!response.ok) {
        if (response.status !== 409) createAttempt.current = null;
        throw new Error(await getResponseErrorMessage(response, 'Could not create reminder'));
      }
      createAttempt.current = null;
      setCreateOpen(false);
      setSelectedContact(null);
      setContactSearch('');
      setReminderTitle('');
      const reminderDate = format(parsedDate, 'yyyy-MM-dd');
      setCurrentMonth(startOfMonth(parsedDate));
      setSelectedDate(reminderDate);
      setReloadToken((value) => value + 1);
      toast({ message: 'Reminder added' });
    } catch (error) {
      toast({
        message: error instanceof TypeError
          ? 'Could not confirm the reminder. Retry without changing the form; the same request will be reused safely.'
          : error instanceof Error ? error.message : 'Could not create reminder',
        variant: 'error',
      });
    } finally {
      setCreating(false);
    }
  }

  async function completeEvent(event: CalendarEvent) {
    if (completingId || (event.kind !== 'reminder' && event.kind !== 'plan')) return;
    setCompletingId(event.id);
    try {
      const response = await fetch(`/api/${event.kind === 'plan' ? 'plans' : 'reminders'}/${event.source_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not complete event'));
      setEvents((current) => current.map((item) => item.id === event.id && (item.kind === 'plan' || item.kind === 'reminder') ? { ...item, completed: true } : item));
      setReloadToken((value) => value + 1);
      toast({ message: event.kind === 'plan' ? 'Plan completed and added to history' : 'Reminder completed' });
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : 'Could not complete event', variant: 'error' });
    } finally {
      setCompletingId(null);
    }
  }

  if (loading && events.length === 0) return <CalendarSkeleton />;

  return (
    <div className="space-y-5">
      <section className="space-y-4">
        <div className="relative flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Calendar</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Plans, reminders, and important dates.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link className="inline-flex min-h-11 items-center underline" href="/calendar/events">Saved calendar context</Link>
            <Button type="button" onClick={() => openReminder()} className="min-h-11">
              <Plus className="h-4 w-4" aria-hidden="true" /> Add reminder
            </Button>
            <div className="flex items-center rounded-xl border border-border bg-card p-1">
              <button
                type="button"
                onClick={() => setView('month')}
                aria-pressed={view === 'month'}
                className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium ${
                  view === 'month' ? 'bg-foreground text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <CalendarDays className="h-4 w-4" aria-hidden="true" /> Month
              </button>
              <button
                type="button"
                onClick={() => setView('agenda')}
                aria-pressed={view === 'agenda'}
                className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium ${
                  view === 'agenda' ? 'bg-foreground text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <List className="h-4 w-4" aria-hidden="true" /> Agenda
              </button>
            </div>
          </div>
        </div>
      </section>

      {loadError && (
        <LoadError
          title="Calendar unavailable"
          message={loadError}
          onRetry={() => setReloadToken((value) => value + 1)}
          retrying={loading}
        />
      )}

      {createOpen && (
        <Card id="calendar-reminder-form" className="scroll-mt-24 border-rose-200 bg-secondary/40 shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">New reminder</h2>
                <p className="mt-1 text-sm text-muted-foreground">A gentle nudge for someone in your circle.</p>
              </div>
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button>
            </div>
            <form onSubmit={(event) => void createReminder(event)} className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
                <label htmlFor="calendar-reminder-title" className="mb-1.5 block text-sm font-semibold">What should we remind you?</label>
                <input
                  id="calendar-reminder-title"
                  required
                  maxLength={200}
                  value={reminderTitle}
                  onChange={(event) => setReminderTitle(event.target.value)}
                  placeholder="Ask how the new role is going"
                  className="h-10 w-full rounded-lg border bg-card px-3 text-sm"
                />
              </div>
              <div>
                <label htmlFor="calendar-reminder-at" className="mb-1.5 block text-sm font-semibold">Date and time</label>
                <input
                  id="calendar-reminder-at"
                  type="datetime-local"
                  required
                  value={reminderAt}
                  onChange={(event) => setReminderAt(event.target.value)}
                  className="h-10 w-full rounded-lg border bg-card px-3 text-sm"
                />
              </div>
              <div>
                {selectedContact ? (
                  <p className="mb-1.5 text-sm font-semibold">Person</p>
                ) : (
                  <label htmlFor="calendar-contact-search" className="mb-1.5 block text-sm font-semibold">Person</label>
                )}
                {selectedContact ? (
                  <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border bg-card px-3 text-sm">
                    <span>{selectedContact.name}</span>
                    <button type="button" onClick={() => setSelectedContact(null)} className="font-semibold text-primary hover:underline">Change</button>
                  </div>
                ) : (
                  <>
                    <input
                      id="calendar-contact-search"
                      type="search"
                      value={contactSearch}
                      onChange={(event) => {
                        setContactSearch(event.target.value);
                        setContactOptionsLoading(true);
                      }}
                      placeholder="Find a contact"
                      className="h-10 w-full rounded-lg border bg-card px-3 text-sm"
                      aria-describedby="calendar-contact-help"
                    />
                    <div id="calendar-contact-help" className="sr-only">Choose a person from the results below.</div>
                    {contactSearchError ? (
                      <p role="alert" className="mt-2 text-xs text-destructive">{contactSearchError}</p>
                    ) : contactOptionsLoading ? (
                      <p role="status" className="mt-2 text-xs text-muted-foreground">Finding people...</p>
                    ) : contactOptions.length > 0 ? (
                      <div className="mt-2 max-h-36 overflow-y-auto rounded-lg border bg-card p-1">
                        {contactOptions.map((contact) => (
                          <button
                            key={contact.id}
                            type="button"
                            onClick={() => setSelectedContact(contact)}
                            className="block min-h-11 w-full rounded-md px-2 text-left text-sm hover:bg-secondary focus-visible:bg-secondary"
                          >
                            {contact.name}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">No matching people. <Link href="/contacts/new" className="font-semibold text-primary underline">Add a contact</Link></p>
                    )}
                  </>
                )}
              </div>
              <div className="md:col-span-2 flex items-center gap-3">
                <Button type="submit" disabled={!selectedContact || creating}>{creating ? 'Saving...' : 'Save reminder'}</Button>
                {!selectedContact && <span className="text-xs text-muted-foreground">Choose a person to continue.</span>}
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card className="border-border/70 shadow-card">
        <CardContent className="p-4 sm:p-5">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="icon" onClick={() => moveMonth(-1)} aria-label="Previous month">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button type="button" variant="outline" size="icon" onClick={() => moveMonth(1)} aria-label="Next month">
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button type="button" variant="outline" onClick={goToToday}>Today</Button>
                <label className="sr-only" htmlFor="calendar-month">Jump to month</label>
                <input
                  id="calendar-month"
                  type="month"
                  value={format(currentMonth, 'yyyy-MM')}
                  onChange={(event) => {
                    if (!event.target.value) return;
                    const nextMonth = parseISO(`${event.target.value}-01`);
                    setCurrentMonth(nextMonth);
                    setSelectedDate(format(nextMonth, 'yyyy-MM-dd'));
                  }}
                  className="min-h-11 min-w-0 max-w-full rounded-md border bg-card px-2 text-sm"
                />
              </div>
              <h2 className="sr-only" aria-live="polite">
                {format(currentMonth, 'MMMM yyyy')}
              </h2>
              <div className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{filteredEvents.length}</span> visible events
              </div>
            </div>

            <button
              type="button"
              aria-expanded={filtersOpen}
              aria-controls="calendar-filters"
              onClick={() => setFiltersOpen((open) => !open)}
              className="inline-flex min-h-11 items-center justify-between rounded-lg border bg-card px-3 text-sm font-semibold md:hidden"
            >
              <span className="inline-flex items-center gap-2"><Filter className="h-4 w-4" aria-hidden="true" /> Filters</span>
              <span className="text-xs font-normal text-muted-foreground">{activeFilterCount < availableKinds.length || query || contactId !== 'all' || !showCompleted ? 'Active' : 'All events'}</span>
            </button>

            <div id="calendar-filters" className={`${filtersOpen ? 'space-y-3' : 'hidden'} md:block md:space-y-3`}>
            <div className="h-px bg-border/70" />
            <div className="grid gap-3 lg:grid-cols-[minmax(14rem,1fr)_14rem_auto]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <label className="sr-only" htmlFor="calendar-search">Search calendar</label>
                <input
                  id="calendar-search"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search events or people"
                  className="h-9 w-full rounded-lg border bg-card pl-9 pr-3 text-sm"
                />
              </div>
              <label className="sr-only" htmlFor="calendar-contact">Filter by contact</label>
              <select
                id="calendar-contact"
                value={contactId}
                onChange={(event) => setContactId(event.target.value)}
                className="h-9 rounded-lg border bg-card px-3 text-sm"
              >
                <option value="all">All contacts</option>
                {contactId !== 'all' && !contacts.some(([id]) => String(id) === contactId) && (
                  <option value={contactId}>Selected contact (no events this month)</option>
                )}
                {contacts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
              <label className="flex min-h-11 items-center gap-2 rounded-lg border bg-card px-3 text-sm">
                <input
                  type="checkbox"
                  checked={showCompleted}
                  onChange={(event) => setShowCompleted(event.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                Show completed
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Filter className="h-3.5 w-3.5" aria-hidden="true" /> Types
              </span>
              {availableKinds.map((kind) => {
                const style = EVENT_STYLES[kind];
                const Icon = style.icon;
                return (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={activeKinds[kind]}
                    onClick={() => setActiveKinds((current) => ({ ...current, [kind]: !current[kind] }))}
                    className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition ${
                      activeKinds[kind] ? style.chip : 'border-border bg-card text-muted-foreground opacity-60'
                    }`}
                  >
                    <span className={`h-2 w-2 rounded-full ${style.dot}`} aria-hidden="true" />
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {style.label}
                  </button>
                );
              })}
              {(activeFilterCount < availableKinds.length || query || contactId !== 'all' || !showCompleted) && (
                <button type="button" onClick={resetFilters} className="min-h-8 px-2 text-xs font-semibold text-primary hover:underline">
                  Reset filters
                </button>
              )}
            </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {truncated && (
        <p role="status" className="rounded-lg border border-amber-200 bg-warning-soft px-4 py-3 text-sm text-warning">
          This date range contains more than 5,000 events. Choose another month to see more; filters apply to the events already downloaded.
        </p>
      )}
      {(sourceTruncated || sourceDateUncertain) && <p role="status" className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900">
        {sourceTruncated && 'More saved meetings are available than fit in this calendar view. '}
        {sourceDateUncertain && 'Some saved meetings have no reliable date and cannot be placed on this calendar. '}
        <Link className="inline-flex min-h-11 items-center underline" href="/calendar/events">Review all saved context</Link>
      </p>}

      {view === 'month' ? (
        <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <Card className="overflow-hidden border-border/70 shadow-card">
            <div className="grid grid-cols-7 border-b bg-muted/40">
              {WEEKDAYS.map((weekday) => (
                <div key={weekday} className="px-1 py-2.5 text-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground sm:text-xs">
                  {weekday}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 bg-border/70 gap-px">
              {calendarDays.map((day) => {
                const dateKey = format(day, 'yyyy-MM-dd');
                const dayEvents = eventsByDate.get(dateKey) || [];
                const selected = dateKey === selectedDate;
                return (
                  <button
                    key={dateKey}
                    type="button"
                    onClick={() => setSelectedDate(dateKey)}
                    aria-label={`${format(day, 'EEEE, MMMM d')}, ${dayEvents.length} events`}
                    aria-pressed={selected}
                    className={`min-h-24 bg-card p-1.5 text-left transition hover:bg-secondary/40 sm:min-h-28 sm:p-2 lg:min-h-32 ${
                      !isSameMonth(day, currentMonth) ? 'bg-muted/30 text-muted-foreground' : ''
                    } ${selected ? 'relative z-10 ring-2 ring-inset ring-primary' : ''}`}
                  >
                    <span className={`mb-1.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold sm:text-sm ${
                      isToday(day) ? 'bg-primary text-white shadow-sm' : ''
                    }`}>
                      {format(day, 'd')}
                    </span>
                    <span className="flex flex-wrap gap-1 sm:hidden" aria-hidden="true">
                      {dayEvents.slice(0, 5).map((event) => (
                        <span key={event.id} className={`h-1.5 w-1.5 rounded-full ${EVENT_STYLES[event.kind].dot}`} />
                      ))}
                    </span>
                    <span className="hidden space-y-1 sm:block" aria-hidden="true">
                      {dayEvents.slice(0, 3).map((event) => (
                        <span key={event.id} className={`block truncate rounded border px-1.5 py-0.5 text-[10px] font-medium lg:text-xs ${EVENT_STYLES[event.kind].chip} ${event.completed ? 'line-through' : ''}`}>
                          {formatEventTime(event) && `${formatEventTime(event)} · `}{event.kind === 'source_event' && event.source.facts.status === 'cancelled' && 'Cancelled · '}{event.title}
                        </span>
                      ))}
                      {dayEvents.length > 3 && (
                        <span className="block px-1 text-[10px] font-semibold text-muted-foreground">+{dayEvents.length - 3} more</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          <aside className="min-w-0 xl:sticky xl:top-24 xl:self-start">
            <Card className="overflow-hidden border-border/70 shadow-card">
              <div className="bg-foreground px-5 py-4 text-white">
                <p className="text-xs font-semibold uppercase tracking-wider text-white/60">Selected day</p>
                <h2 className="mt-1 text-lg font-bold">{format(parseISO(selectedDate), 'EEEE, MMMM d')}</h2>
                <p className="mt-1 text-xs text-white/70">{selectedEvents.length} {selectedEvents.length === 1 ? 'event' : 'events'}</p>
              </div>
              <CardContent className="p-4">
                {selectedEvents.length > 0 ? (
                  <div className="space-y-3">
                    {selectedEvents.map((event) => <EventDetail key={event.id} event={event} completing={completingId === event.id} onComplete={(item) => void completeEvent(item)} onReschedule={setRescheduling} />)}
                  </div>
                ) : (
                  <div className="py-8 text-center">
                    <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <CalendarDays className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <p className="mt-3 text-sm font-semibold">A clear day</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">No events match the current filters.</p>
                  </div>
                )}
                <Button type="button" variant="outline" className="mt-4 w-full" onClick={() => openReminder(selectedDate)}>
                  <Plus className="h-4 w-4" aria-hidden="true" /> Add reminder for this day
                </Button>
              </CardContent>
            </Card>
          </aside>
        </div>
      ) : (
        <Card className="overflow-hidden border-border/70 shadow-card">
          <CardContent className="p-0">
            {calendarDays.some((day) => (agendaByDate.get(format(day, 'yyyy-MM-dd')) || []).length > 0) ? (
              <div className="divide-y">
                {calendarDays.map((day) => {
                  const dateKey = format(day, 'yyyy-MM-dd');
                  const dayEvents = agendaByDate.get(dateKey) || [];
                  if (dayEvents.length === 0) return null;
                  return (
                    <section key={dateKey} className="grid gap-4 p-4 sm:grid-cols-[7rem_minmax(0,1fr)] sm:p-5">
                      <div>
                        <p className={`text-xs font-bold uppercase tracking-wider ${isToday(day) ? 'text-primary' : 'text-muted-foreground'}`}>
                          {isToday(day) ? 'Today' : format(day, 'EEE')}
                        </p>
                        <p className="mt-1 text-lg font-bold">{format(day, 'MMM d')}</p>
                      </div>
                      <div className="grid gap-3 lg:grid-cols-2">
                        {dayEvents.map((event) => <EventDetail key={event.id} event={event} completing={completingId === event.id} onComplete={(item) => void completeEvent(item)} onReschedule={setRescheduling} />)}
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="px-5 py-10 text-center">
                <SlidersHorizontal className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
                <h2 className="mt-4 font-semibold">No matching events this month</h2>
                <p className="mt-1 text-sm text-muted-foreground">Try another month or reset your filters.</p>
                <Button type="button" variant="outline" className="mt-5" onClick={resetFilters}>Reset filters</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {rescheduling && <CalendarReschedule key={rescheduling.id} event={rescheduling} onCancel={() => setRescheduling(null)} onSaved={(at) => {
        const date = rescheduling.kind === 'plan' ? parseISO(at) : new Date(at);
        setCurrentMonth(startOfMonth(date)); setSelectedDate(format(date, 'yyyy-MM-dd'));
        setRescheduling(null); setReloadToken((value) => value + 1);
        toast({ message: rescheduling.kind === 'plan' ? 'Plan date saved' : 'Reminder date saved' });
      }} />}
    </div>
  );
}
