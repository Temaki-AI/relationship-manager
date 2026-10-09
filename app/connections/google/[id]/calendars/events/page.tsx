import { GoogleCalendarEvents } from '@/components/google-calendar-events';
export default async function CalendarEventsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams; return <GoogleCalendarEvents connectionId={(await params).id} calendarId={typeof query.calendar_id === 'string' ? query.calendar_id : ''} />;
}
