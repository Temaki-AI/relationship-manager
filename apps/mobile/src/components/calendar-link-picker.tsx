import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ActionButton } from './design-system';
import { calendarLinkChoices, type CalendarLinkChoice } from '@/data/calendar-event-links';
import { useNativeSync } from '@/native/sync';
import { fonts, palette } from '@/theme';

export function CalendarLinkPicker({ eventId, kind, selected, onChange, disabled }: {
  eventId: string; kind: 'person' | 'plan'; selected: string[]; onChange: (ids: string[]) => void; disabled: boolean;
}) {
  const db = useSQLiteContext(), { revision } = useNativeSync(), noun = kind === 'person' ? 'people' : 'plans';
  const [search, setSearch] = useState(''), [page, setPage] = useState(0), [retry, setRetry] = useState(0), [limitError, setLimitError] = useState('');
  const key = JSON.stringify([eventId, kind, selected, search, page, retry, revision]);
  const [state, setState] = useState<{ key: string; rows: CalendarLinkChoice[]; selected: CalendarLinkChoice[]; more: boolean; error: string } | null>(null);
  useEffect(() => {
    let active = true;
    void calendarLinkChoices(db, eventId, kind, search, page * 50, selected).then((result) => {
      if (active) setState({ key, rows: result.choices, selected: result.selected, more: result.more, error: '' });
    }, () => { if (active) setState({ key, rows: [], selected: [], more: false, error: `Unable to load ${noun}.` }); });
    return () => { active = false; };
  }, [db, eventId, kind, search, page, selected, key, noun]);
  const current = state?.key === key ? state : null;
  function choose(row: CalendarLinkChoice) {
    const checked = selected.includes(row.id);
    if (!checked && selected.length >= 20) { setLimitError(`Choose at most 20 ${noun}.`); return; }
    setLimitError(''); onChange(checked ? selected.filter((id) => id !== row.id) : [...selected, row.id]);
  }
  function choice(row: CalendarLinkChoice) {
    const checked = selected.includes(row.id), unavailable = !!row.unavailable, elsewhere = !!row.linkedElsewhere;
    const locked = disabled || !checked && (unavailable || elsewhere);
    return <Pressable key={row.id} accessibilityRole="checkbox" accessibilityLabel={`${row.label}${unavailable ? ', unavailable' : elsewhere ? ', linked to another meeting' : ''}`}
      accessibilityState={{ checked, disabled: locked }} disabled={locked} onPress={() => choose(row)} style={[styles.choice, locked && { opacity: 0.65 }]}>
      <Text style={styles.label}>{checked ? '✓ ' : ''}{row.label}</Text>
      {!!row.detail && <Text style={styles.body}>{row.detail}</Text>}
      {unavailable && <Text style={styles.body}>Remove this unavailable selection before saving.</Text>}
      {elsewhere && <Text style={styles.body}>Linked or queued for another meeting. Review that link first.</Text>}
    </Pressable>;
  }
  return <View style={styles.container}>
    <Text style={styles.label}>Selected {noun}: {selected.length} of 20</Text>
    {!current ? <ActivityIndicator color={palette.primary} /> : current.error ? <><Text accessibilityRole="alert">{current.error}</Text><ActionButton label={`Retry ${noun}`} variant="quiet" onPress={() => setRetry(retry + 1)} /></> : <>
      {current.selected.map(choice)}
      {!selected.length && <Text style={styles.body}>No explicit {kind === 'person' ? 'person' : 'plan'} links.</Text>}
    </>}
    <TextInput accessibilityLabel={`Search meeting ${noun}`} placeholder={kind === 'person' ? 'Search names, email or phone' : 'Search plans, people or dates'} value={search} maxLength={200}
      editable={!disabled} onChangeText={(value) => { setSearch(value); setPage(0); }} style={styles.input} />
    {current && !current.error && <>
      {current.rows.filter((row) => !selected.includes(row.id)).map(choice)}
      {!current.rows.length && <Text style={styles.body}>No matching {noun}.</Text>}
      <View style={styles.pages}>
        {page > 0 && <ActionButton label={`Previous ${noun}`} variant="quiet" disabled={disabled} onPress={() => setPage(page - 1)} />}
        {current.more && <ActionButton label={`Next ${noun}`} variant="quiet" disabled={disabled} onPress={() => setPage(page + 1)} />}
      </View>
    </>}
    {!!limitError && <Text accessibilityRole="alert" style={styles.body}>{limitError}</Text>}
  </View>;
}
const styles = StyleSheet.create({
  container: { gap: 12 }, label: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 15 },
  body: { color: palette.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 21 },
  choice: { minHeight: 48, padding: 14, borderRadius: 12, backgroundColor: palette.surface, gap: 4 },
  input: { minHeight: 50, padding: 12, color: palette.ink, fontFamily: fonts.body, backgroundColor: palette.surface, borderRadius: 12, borderWidth: 1, borderColor: palette.line },
  pages: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
