import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { ActionButton } from '@/components/design-system';
import { CalendarEventCard } from '@/components/calendar-event-card';
import { listCalendarEvents, type NativeCalendarEvent } from '@/data/calendar-events';
import { useNativeSync } from '@/native/sync';
import { palette } from '@/theme';

export default function SavedMeetingsScreen() {
  const db = useSQLiteContext(), focused = useIsFocused(), router = useRouter(), { revision } = useNativeSync();
  const params = useLocalSearchParams<{ contactId?: string }>(), person = typeof params.contactId === 'string' ? params.contactId : undefined;
  const [selection, setSelection] = useState({ person, page: 0 }), [retry, setRetry] = useState(0);
  const page = selection.person === person ? selection.page : 0;
  const setPage = (value: number) => setSelection({ person, page: value });
  const key = JSON.stringify([person, page, revision, retry]);
  const [state, setState] = useState<{ key: string; events: NativeCalendarEvent[]; more: boolean; error: string } | null>(null);
  const loading = state?.key !== key;
  useEffect(() => {
    if (!focused) return; let active = true;
    void listCalendarEvents(db, person, page * 50).then((value) => { if (active) setState({ key, ...value, error: '' }); }, () => {
      if (active) setState({ key, events: [], more: false, error: 'Unable to load saved meetings.' });
    }); return () => { active = false; };
  }, [db, focused, person, page, key]);
  return <><Stack.Screen options={{ title: 'Saved meetings' }} /><FlatList data={loading ? [] : state!.events} contentContainerStyle={{ padding: 20, gap: 16 }} style={{ backgroundColor: palette.canvas }}
    keyExtractor={(event) => event.id} renderItem={({ item }) => <CalendarEventCard event={item} onOpen={() => router.push({ pathname: '/calendar/events/[id]', params: { id: item.id } })} />}
    ListHeaderComponent={<Text style={{ color: palette.muted }}>Reviewed Calendar context saved to this account. Available offline after sync; source changes require a new download.</Text>}
    ListEmptyComponent={loading ? <ActivityIndicator color={palette.primary} /> : state!.error ? <Text accessibilityRole="alert">{state!.error}</Text> : <Text>No saved meetings on this page.</Text>}
    ListFooterComponent={<View style={{ gap: 12 }}>
      {!!state?.error && <ActionButton label="Try again" onPress={() => setRetry(retry + 1)} />}
      {page > 0 && <ActionButton label="Previous page" variant="quiet" disabled={loading} onPress={() => setPage(page - 1)} />}
      {state?.more && <ActionButton label="Next page" variant="quiet" disabled={loading} onPress={() => setPage(page + 1)} />}
    </View>} /></>;
}
