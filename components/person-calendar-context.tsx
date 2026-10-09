'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SavedCalendarEvent } from '@/packages/domain/src/calendar-events';
import { getResponseErrorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SavedCalendarEventCard } from '@/components/saved-calendar-event-card';

export function PersonCalendarContext({ contactId, refreshKey }: { contactId: string; refreshKey: object }) {
  const [data, setData] = useState<{ events: SavedCalendarEvent[]; more: boolean } | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true); setError('');
      try {
        const response = await fetch('/api/calendar/events?' + new URLSearchParams({ contact_id: contactId, limit: '3' }), { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not read saved meetings.'));
        const fresh = await response.json();
        if (!controller.signal.aborted) setData(fresh);
      } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not read saved meetings.'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => controller.abort();
  }, [contactId, refreshKey, retry]);
  return <Card className="border-border/70 shadow-card"><CardContent className="space-y-3 pt-5 pb-4">
    <h2 className="text-sm font-semibold">Saved meetings</h2>
    <p className="text-xs text-muted-foreground">Latest saved context linked to this person or their plans. Invitations do not count as confirmed interactions.</p>
    {loading && <p role="status" className="text-sm">Loading saved meetings…</p>}
    {error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button variant="outline" disabled={loading} onClick={() => setRetry((value) => value + 1)}>Retry saved meetings</Button></div>}
    {!loading && !error && data && <>{data.events.length ? <ul className="space-y-3">{data.events.map((event) => <li key={event.public_id}><SavedCalendarEventCard event={event} /></li>)}</ul> : <p className="text-sm text-muted-foreground">No saved meetings for this person yet. Save a downloaded calendar event and review its links.</p>}</>}
    <Link className="inline-flex min-h-11 items-center text-sm underline" href={`/calendar/events?${new URLSearchParams({ contact_id: contactId })}`}>{data?.more ? 'All saved meetings for this person' : 'Review calendar context for this person'}</Link>
  </CardContent></Card>;
}
