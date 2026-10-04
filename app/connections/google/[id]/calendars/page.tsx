import { GoogleCalendarChoices } from '@/components/google-calendar-choices';
export default async function CalendarChoicesPage({ params }: { params: Promise<{ id: string }> }) { return <GoogleCalendarChoices connectionId={(await params).id} />; }
