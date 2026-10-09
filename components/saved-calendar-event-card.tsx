'use client';

import Link from 'next/link';
import { CalendarDays } from 'lucide-react';
import type { CalendarEventCardContext } from '@/lib/calendar-directory';
import { calendarEventWhen } from '@/packages/domain/src/calendar-event-display';

export function SavedCalendarEventCard({ event }: { event: CalendarEventCardContext }) {
  const { facts } = event;
  return <article aria-label={facts.title} className="min-w-0 space-y-2 rounded-xl border border-violet-200 bg-violet-50/50 p-3.5 text-foreground">
    <p className="inline-flex items-center gap-2 text-xs font-semibold text-violet-800"><CalendarDays className="h-4 w-4 shrink-0" aria-hidden="true" />Google Calendar</p>
    <h3 className="break-words text-sm font-semibold">{facts.title}</h3>
    <p className="break-words text-xs">{calendarEventWhen({ start: facts.start ?? facts.original_start, end: facts.end }, event.calendar_time_zone)}</p>
    {facts.status === 'cancelled' && <p className="text-sm font-semibold">Cancelled meeting</p>}
    {facts.status === 'tentative' && <p className="text-sm">Tentative meeting</p>}
    {facts.recurring_id && <p className="text-xs">Recurring occurrence</p>}
    {facts.redacted && <p className="text-xs">Private details were not saved.</p>}
    {facts.location && <p className="break-words text-xs">{facts.location}</p>}
    <p className="break-words text-xs">{event.calendar_label} · {event.account_email} · Source {event.source_status.replaceAll('_', ' ')} · Last observed {new Date(event.observed_at).toLocaleString()}.</p>
    {event.source_status !== 'available' && <p className="text-xs">Retained context may be out of date. Reconnect and download the calendar to check it.</p>}
    <p className="break-words text-xs">Linked people: {event.people.length ? event.people.slice(0, 3).map((person, index) => <span key={person.id}>{index > 0 && ', '}<Link className="underline" href={`/contacts/${person.id}`}>{person.name}</Link></span>) : 'none'}{event.people.length > 3 && ` · ${event.people.length - 3} more in saved context`}.</p>
    <p className="break-words text-xs">Linked plans: {event.plans.length ? event.plans.slice(0, 3).map((plan, index) => <span key={plan.id}>{index > 0 && '; '}<Link className="underline" href={`/contacts/${plan.contact_id}`}>{plan.summary} · {plan.contact_name} · {plan.planned_date}</Link></span>) : 'none'}{event.plans.length > 3 && ` · ${event.plans.length - 3} more in saved context`}.</p>
    <div className="flex flex-wrap gap-x-3 text-xs">
      <Link className="inline-flex min-h-11 items-center underline" href={`/calendar/events/${event.public_id}`}>Review saved links</Link>
      {facts.google_url && <a className="inline-flex min-h-11 items-center underline" href={facts.google_url} target="_blank" rel="noopener noreferrer">Open in Google Calendar</a>}
      {facts.conference_url && facts.status !== 'cancelled' && <a className="inline-flex min-h-11 items-center underline" href={facts.conference_url} target="_blank" rel="noopener noreferrer">Meeting link</a>}
    </div>
  </article>;
}
