import { GoogleOwnedCalendarSetup } from '@/components/google-owned-calendar-setup';
export default async function GoogleOwnedCalendarPage({ params }: { params: Promise<{ id: string }> }) {
  return <GoogleOwnedCalendarSetup connectionId={(await params).id} />;
}
