import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ActionButton } from './design-system';
import { fonts, palette } from '@/theme';

type Person = { id: string; name: string; email: string | null; phone: string | null };
export function PersonPicker({ value, onChange, excludeId, optional = false, disabled = false, label = 'Choose a person' }: {
  value: string | null; onChange: (id: string | null) => void; excludeId?: string; optional?: boolean; disabled?: boolean; label?: string;
}) {
  const db = useSQLiteContext();
  const [search, setSearch] = useState(''), [page, setPage] = useState(0), [people, setPeople] = useState<Person[]>([]);
  const [selected, setSelected] = useState<Person | null>(null), [loadedKey, setLoadedKey] = useState(''), [error, setError] = useState('');
  const queryKey = JSON.stringify([search, page, value, excludeId]), loading = loadedKey !== queryKey;
  useEffect(() => {
    let active = true;
    const pattern = `%${search.trim().replace(/[\\%_]/gu, '\\$&')}%`;
    void Promise.all([
      db.getAllAsync<Person>(`SELECT id, name, email, phone FROM contacts WHERE deleted_at IS NULL AND id <> ?
        AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(contact_methods) WHERE json_extract(value, '$.value') LIKE ? ESCAPE '\\')) ORDER BY name COLLATE NOCASE, id LIMIT 50 OFFSET ?`, excludeId ?? '', pattern, pattern, pattern, pattern, page * 50),
      value ? db.getFirstAsync<Person>('SELECT id, name, email, phone FROM contacts WHERE id = ?', value) : Promise.resolve(null),
    ]).then(([rows, current]) => { if (active) { setPeople(rows); setSelected(current); setLoadedKey(queryKey); setError(''); } },
      () => { if (active) { setPeople([]); setError('Unable to load your people.'); setLoadedKey(queryKey); } });
    return () => { active = false; };
  }, [db, search, page, value, excludeId, queryKey]);
  return <View style={styles.container}>
    <Text style={styles.label}>{label}</Text>
    <Text style={styles.body}>{value ? loading ? 'Loading profile…' : selected?.name ?? 'Unavailable profile' : optional ? 'No linked profile' : 'No person selected'}</Text>
    {!disabled && <>
      <TextInput accessibilityLabel={`Search people for ${label.toLowerCase()}`} placeholder="Search by name, email or phone" value={search}
        onChangeText={(next) => { setSearch(next); setPage(0); }} style={styles.input} />
      {optional && <ActionButton label="Use no linked profile" variant="quiet" onPress={() => onChange(null)} />}
      {!loading && error && <Text accessibilityRole="alert" style={styles.body}>{error}</Text>}
      {loading ? <ActivityIndicator color={palette.primary} /> : people.map((person) => <Pressable accessibilityRole="radio"
        accessibilityLabel={`${person.name}${person.email ? `, ${person.email}` : person.phone ? `, ${person.phone}` : ''}`}
        accessibilityState={{ checked: person.id === value }} key={person.id} onPress={() => onChange(person.id)} style={styles.choice}>
        <Text style={styles.label}>{person.id === value ? '✓ ' : ''}{person.name}</Text>
        {(person.email || person.phone) && <Text style={styles.body}>{person.email || person.phone}</Text>}
      </Pressable>)}
      {!loading && people.length === 0 && <Text style={styles.body}>No matching people.</Text>}
      <View style={styles.pages}>
        {page > 0 && <ActionButton label="Previous people" variant="quiet" disabled={loading} onPress={() => setPage(page - 1)} />}
        {!loading && people.length === 50 && <ActionButton label="Next people" variant="quiet" onPress={() => setPage(page + 1)} />}
      </View>
    </>}
  </View>;
}
const styles = StyleSheet.create({
  container: { gap: 12 }, label: { fontFamily: fonts.bodyDemi, fontSize: 15, color: palette.ink },
  body: { fontFamily: fonts.body, fontSize: 14, color: palette.muted }, pages: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { padding: 14, minHeight: 48, borderRadius: 12, backgroundColor: palette.surface, gap: 4 },
  input: { minHeight: 50, padding: 12, color: palette.ink, fontFamily: fonts.body, backgroundColor: palette.surface, borderRadius: 12, borderWidth: 1, borderColor: palette.line },
});
