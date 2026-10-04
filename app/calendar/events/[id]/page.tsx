import { CalendarEventLinkReview } from '@/components/calendar-event-context';
export default async function SavedEventPage({ params }: { params: Promise<{ id: string }> }) { return <CalendarEventLinkReview savedId={(await params).id} />; }
