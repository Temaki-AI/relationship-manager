import { CalendarEventLinkReview } from '@/components/calendar-event-context';
export default async function EventLinkPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams; return <CalendarEventLinkReview connectionId={(await params).id} calendarId={typeof query.calendar_id === 'string' ? query.calendar_id : ''} eventId={typeof query.event_id === 'string' ? query.event_id : ''} />;
}
