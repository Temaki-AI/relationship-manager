import { SavedCalendarEventsList } from '@/components/calendar-event-context';
export default async function SavedEventsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams; return <SavedCalendarEventsList contactId={typeof query.contact_id === 'string' ? query.contact_id : undefined} />;
}
