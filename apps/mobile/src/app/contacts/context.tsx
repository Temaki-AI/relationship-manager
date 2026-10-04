import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Platform, Text, View, StyleSheet } from 'react-native';
import { ActionButton } from '@/components/design-system';
import { ContextCard } from '@/components/context-card';
import { completePlan, deleteContext, listContext, type ContextRecord } from '@/data/context';
import type { ContextEntity } from '../../../../../packages/domain/src/relationship-context';
import { useNativeSync } from '@/native/sync';
import { fonts, palette } from '@/theme';

const labels = { plan: 'Plans', family: 'Family', relationship: 'Relationships' };
export default function PersonContextScreen() {
  const db = useSQLiteContext(), router = useRouter(), focused = useIsFocused(), { revision } = useNativeSync();
  const { contactId } = useLocalSearchParams<{ contactId: string }>();
  const id = typeof contactId === 'string' ? contactId : '';
  const [entity, setEntity] = useState<ContextEntity>('plan'), [rows, setRows] = useState<ContextRecord[]>([]), [name, setName] = useState('');
  const [page, setPage] = useState(0), [more, setMore] = useState(false), [loadedKey, setLoadedKey] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const queryKey = JSON.stringify([id, entity, page, revision]), loading = loadedKey !== queryKey;
  const load = useCallback(async () => {
    const person = await db.getFirstAsync<{ name: string }>('SELECT name FROM contacts WHERE id = ? AND deleted_at IS NULL', id);
    if (!person) throw new Error('This person is no longer available.');
    const records = await listContext(db, entity, id, page * 50);
    return { person, records };
  }, [db, entity, id, page]);
  useEffect(() => {
    if (!focused) return;
    let active = true;
    void load().then(({ person, records }) => {
      if (active) { setName(person.name); setRows(records); setMore(records.length === 50); setLoadedKey(queryKey); setError(''); }
    }, (error) => { if (active) { setError(error instanceof Error ? error.message : 'Unable to load this page.'); setLoadedKey(queryKey); } });
    return () => { active = false; };
  }, [focused, load, revision, queryKey]);
  async function change(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); const { person, records } = await load(); setName(person.name); setRows(records); setMore(records.length === 50); setLoadedKey(queryKey); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to save this change.'); }
    finally { setBusy(false); }
  }
  return <>
    <Stack.Screen options={{ title: name ? `${name} · ${labels[entity]}` : labels[entity] }} />
    <FlatList data={loading || error ? [] : rows} keyExtractor={(item) => item.id} contentContainerStyle={styles.content}
      ListHeaderComponent={<View style={styles.header}>
        <View style={styles.options}>{(Object.keys(labels) as ContextEntity[]).map((choice) => <ActionButton key={choice} label={`${entity === choice ? '✓ ' : ''}${labels[choice]}`}
          variant="secondary" onPress={() => { setEntity(choice); setPage(0); }} />)}</View>
        <ActionButton label={`Add ${entity === 'family' ? 'family entry' : entity}`} disabled={!name || busy}
          onPress={() => router.push({ pathname: '/context/edit', params: { entity, contactId: id } })} />
        {!loading && !!error && <><Text accessibilityRole="alert" style={styles.body}>{error}</Text><ActionButton label="Try again" variant="secondary" onPress={() => { void change(async () => {}); }} /></>}
      </View>}
      ListEmptyComponent={loading ? <ActivityIndicator color={palette.primary} /> : !error ? <Text style={styles.body}>{page ? 'No more items.' : `No ${labels[entity].toLowerCase()} yet.`}</Text> : null}
      ListFooterComponent={<View style={styles.options}>
        {page > 0 && <ActionButton label="Previous page" variant="quiet" disabled={loading || busy} onPress={() => setPage(page - 1)} />}
        {more && <ActionButton label="Next page" variant="quiet" disabled={loading || busy} onPress={() => setPage(page + 1)} />}
      </View>}
      renderItem={({ item }) => <ContextCard entity={entity} record={item} busy={busy} onPerson={(personId) => router.push({ pathname: '/contacts/[id]', params: { id: personId } })}
        onEdit={() => router.push({ pathname: '/context/edit', params: { entity, id: item.id } })}
        onCalendar={entity === 'plan' && Platform.OS === 'ios' ? () => router.push({ pathname: '/calendar/apple/[id]', params: { id: item.id } }) : undefined}
        onRemove={() => Alert.alert('Remove this item?', 'Remove it from your CRM. Confirmed interaction history is retained.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => { void change(() => deleteContext(db, entity, item.id)); } },
        ])}
        onComplete={() => Alert.alert('Did this plan happen?', 'Completing it adds one confirmed interaction to this person’s history.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'It happened', onPress: () => { void change(() => completePlan(db, item.id)); } },
        ])} />}
    />
  </>;
}
const styles = StyleSheet.create({
  content: { padding: 20, gap: 16, paddingBottom: 40 }, header: { gap: 16 }, options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  body: { fontFamily: fonts.body, color: palette.muted, fontSize: 15, lineHeight: 22 },
});
