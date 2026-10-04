import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, Text } from 'react-native';
import { ActionButton, SectionHeading } from '@/components/design-system';
import { CalendarEventCard } from '@/components/calendar-event-card';
import { getCalendarEvent, type NativeCalendarEvent } from '@/data/calendar-events';
import { useNativeSync } from '@/native/sync';
import { useNativeAccount } from '@/native/account';
import { palette } from '@/theme';

export default function SavedMeetingScreen() {
  const db = useSQLiteContext(), focused = useIsFocused(), router = useRouter(), { revision } = useNativeSync(), { account } = useNativeAccount();
  const params = useLocalSearchParams<{ id: string }>(), id = typeof params.id === 'string' ? params.id : '';
  const [retry, setRetry] = useState(0), [openError, setOpenError] = useState('');
  const key = JSON.stringify([id, revision, retry]);
  const [state, setState] = useState<{ key: string; event: NativeCalendarEvent | null; error: string } | null>(null);
  useEffect(() => {
    if (!focused) return; let active = true;
    void getCalendarEvent(db, id).then((event) => { if (active) setState({ key, event, error: '' }); }, () => {
      if (active) setState({ key, event: null, error: 'Unable to load this saved meeting.' });
    }); return () => { active = false; };
  }, [db, focused, id, key]);
  async function open(url: string) { try { await Linking.openURL(url); setOpenError(''); } catch { setOpenError('Unable to open that link.'); } }
  const event = state?.key === key ? state.event : null;
  return <><Stack.Screen options={{ title: 'Meeting context' }} /><ScrollView style={{ backgroundColor: palette.canvas }} contentContainerStyle={{ padding: 20, gap: 16 }}>
    {state?.key !== key ? <ActivityIndicator color={palette.primary} /> : state.error ? <><Text accessibilityRole="alert">{state.error}</Text><ActionButton label="Try again" onPress={() => setRetry(retry + 1)} /></>
      : !event ? <Text>This meeting is no longer saved on this account. Sync to check its current context.</Text> : <>
        <CalendarEventCard event={event} />
        <Text>Calendar observations stay separate from confirmed interactions. People and plan choices can be saved offline on this phone.</Text>
        <ActionButton label="Review people and plan links" onPress={() => router.push({ pathname: '/calendar/events/links', params: { id: event.id } })} />
        <SectionHeading title="Linked people" />
        {event.people.length ? event.people.map((person) => <ActionButton key={person.id} label={person.name} variant="quiet" onPress={() => router.push({ pathname: '/contacts/[id]', params: { id: person.id } })} />) : <Text>No explicit person links.</Text>}
        <SectionHeading title="Linked plans" />
        {event.plans.length ? event.plans.map((plan) => <ActionButton key={plan.id} label={`${plan.summary} · ${plan.contactName}${plan.completed ? ' · Completed' : ''}`} variant="quiet" onPress={() => router.push({ pathname: '/context/edit', params: { entity: 'plan', id: plan.id } })} />) : <Text>No available plan links.</Text>}
        {!!event.facts.google_url && <ActionButton label="Open original event" variant="secondary" onPress={() => { void open(event.facts.google_url!); }} />}
        {!!event.facts.conference_url && event.facts.status !== 'cancelled' && <ActionButton label="Open meeting link" variant="secondary" onPress={() => { void open(event.facts.conference_url!); }} />}
        {!!account && <ActionButton label="Review saved links on web" variant="quiet" onPress={() => { void open(`${account.origin}/calendar/events/${event.id}`); }} />}
      </>}
    {!!openError && <Text accessibilityRole="alert">{openError}</Text>}
  </ScrollView></>;
}
