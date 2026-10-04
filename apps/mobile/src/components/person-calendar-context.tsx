import { useIsFocused, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { ActionButton, SectionHeading } from './design-system';
import { CalendarEventCard } from './calendar-event-card';
import { listCalendarEvents, type NativeCalendarEvent } from '@/data/calendar-events';
import { useNativeSync } from '@/native/sync';
import { palette } from '@/theme';

export function PersonCalendarContext({ contactId }: { contactId: string }) {
  const db = useSQLiteContext(), focused = useIsFocused(), router = useRouter(), { revision } = useNativeSync();
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([contactId, revision, retry]);
  const [result, setResult] = useState<{ key: string; events: NativeCalendarEvent[]; error: string } | null>(null);
  useEffect(() => {
    if (!focused) return; let active = true;
    void listCalendarEvents(db, contactId, 0, 3).then((value) => { if (active) setResult({ key, events: value.events.slice(0, 3), error: '' }); }, () => {
      if (active) setResult({ key, events: [], error: 'Unable to load saved meeting context.' });
    });
    return () => { active = false; };
  }, [db, focused, contactId, key, retry]);
  return <View style={{ gap: 12 }}>
    <SectionHeading title="Calendar context" />
    {result?.key !== key ? <ActivityIndicator color={palette.primary} /> : result.error ? <>
      <Text accessibilityRole="alert">{result.error}</Text><ActionButton label="Try again" variant="quiet" onPress={() => setRetry(retry + 1)} />
    </> : result.events.length ? result.events.map((event) => <CalendarEventCard key={event.id} event={event} onOpen={() => router.push({ pathname: '/calendar/events/[id]', params: { id: event.id } })} />)
      : <Text style={{ color: palette.muted }}>No saved meetings linked to this person or their plans.</Text>}
    <ActionButton label="All saved meetings" variant="quiet" onPress={() => router.push({ pathname: '/calendar/events', params: { contactId } })} />
  </View>;
}
