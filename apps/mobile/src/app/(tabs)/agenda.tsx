import { useIsFocused, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Platform, Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActionButton } from '@/components/design-system';
import { CalendarEventCard } from '@/components/calendar-event-card';
import { listAgendaEntries, type AgendaEntry } from '@/data/calendar-events';
import { ContextCard } from '@/components/context-card';
import { completePlan, deleteContext } from '@/data/context';
import { useNativeSync } from '@/native/sync';
import { fonts, palette, typeScale } from '@/theme';

export default function AgendaScreen() {
  const db = useSQLiteContext(), router = useRouter(), focused = useIsFocused(), { revision } = useNativeSync();
  const [rows, setRows] = useState<AgendaEntry[]>([]), [page, setPage] = useState(0), [more, setMore] = useState(false);
  const [loadedKey, setLoadedKey] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const queryKey = JSON.stringify([page, revision, refresh]), loading = loadedKey !== queryKey;
  useEffect(() => {
    if (!focused) return;
    let active = true;
    void listAgendaEntries(db, page * 50).then((result) => {
      if (active) { setRows(result.entries); setMore(result.more); setLoadedKey(queryKey); setError(''); }
    }, () => { if (active) { setError('Unable to load your agenda.'); setLoadedKey(queryKey); } });
    return () => { active = false; };
  }, [db, focused, page, revision, refresh, queryKey]);
  async function change(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); setRefresh((value) => value + 1); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to save this change.'); }
    finally { setBusy(false); }
  }
  return <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: palette.canvas }}>
    <FlatList data={loading ? [] : rows} keyExtractor={(item) => item.kind + ':' + (item.kind === 'plan' ? item.record.id : item.event.id)} contentContainerStyle={styles.content}
      ListHeaderComponent={<View style={styles.header}>
        <Text accessibilityRole="header" maxFontSizeMultiplier={2} style={styles.title}>Calendar</Text>
        <Text style={styles.body}>Upcoming plans and saved meetings.</Text>
        <View style={styles.options}>
        <ActionButton label="New plan" onPress={() => router.push({ pathname: '/context/edit', params: { entity: 'plan' } })} />
        <ActionButton label="All reminders" variant="quiet" onPress={() => router.push('/reminders')} />
        </View>
        {!loading && !!error && <><Text accessibilityRole="alert" style={styles.body}>{error}</Text><ActionButton label="Try again" variant="secondary" onPress={() => setRefresh((value) => value + 1)} /></>}
      </View>}
      ListEmptyComponent={loading ? <ActivityIndicator color={palette.primary} /> : !error ? <Text style={styles.body}>{page ? 'No more agenda items.' : 'No plans or saved meetings yet. Create a plan or review Calendar meetings on the web.'}</Text> : null}
      ListFooterComponent={<View style={styles.options}>
        {page > 0 && <ActionButton label="Previous page" variant="quiet" disabled={loading || busy} onPress={() => setPage(page - 1)} />}
        {more && <ActionButton label="Next page" variant="quiet" disabled={loading || busy} onPress={() => setPage(page + 1)} />}
      </View>}
      renderItem={({ item }) => item.kind === 'source_event' ? <CalendarEventCard event={item.event} onOpen={() => router.push({ pathname: '/calendar/events/[id]', params: { id: item.event.id } })} /> : <ContextCard entity="plan" record={item.record} busy={busy} onPerson={(id) => router.push({ pathname: '/contacts/[id]', params: { id } })}
        onEdit={() => router.push({ pathname: '/context/edit', params: { entity: 'plan', id: item.record.id } })}
        onCalendar={Platform.OS === 'ios' ? () => router.push({ pathname: '/calendar/apple/[id]', params: { id: item.record.id } }) : undefined}
        onRemove={() => Alert.alert('Remove this plan?', 'Remove it from your CRM. Confirmed history is retained.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => { void change(() => deleteContext(db, 'plan', item.record.id)); } },
        ])}
        onComplete={() => Alert.alert('Did this plan happen?', 'Completing it adds one confirmed interaction to this person’s history.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'It happened', onPress: () => { void change(() => completePlan(db, item.record.id)); } },
        ])} />}
    />
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  content: { padding: 20, gap: 16, paddingBottom: 40 }, header: { gap: 16 }, options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  title: { fontFamily: fonts.display, color: palette.ink, ...typeScale.title }, body: { fontFamily: fonts.body, color: palette.muted, fontSize: 15, lineHeight: 22 },
});
