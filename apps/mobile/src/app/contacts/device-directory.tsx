import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActionButton, Eyebrow } from '@/components/design-system';
import { DeviceContactAccess } from '@/components/device-contact-access';
import { readDeviceContactPage, readLinkedDeviceContact } from '@/native/device-contacts';
import { stageDeviceContact } from '@/data/device-contacts';
import { fonts, palette } from '@/theme';
import type { DeviceContactFacts } from '../../../../../packages/domain/src/device-contact-facts';
export default function DeviceDirectoryScreen() {
  const db = useSQLiteContext(), router = useRouter(), params = useLocalSearchParams<{ contact?: string }>();
  const [consented, setConsented] = useState(false), [search, setSearch] = useState(''), [rows, setRows] = useState<DeviceContactFacts[]>([]);
  const [offset, setOffset] = useState(0), [more, setMore] = useState(false), [limited, setLimited] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), selecting = useRef(false);
  useEffect(() => () => { generation.current++; }, []);
  async function load(pageOffset = 0, requestPermission = false) {
    if (selecting.current) return;
    const current = ++generation.current; setBusy(true); setError('');
    try {
      const page = await readDeviceContactPage(search, pageOffset, requestPermission);
      if (current !== generation.current) return; setConsented(true); setLimited(page.limited); setMore(page.more); setOffset(pageOffset);
      setRows((previous) => pageOffset ? [...previous, ...page.rows.filter((row) => !previous.some((old) => old.device_id === row.device_id))] : page.rows);
    } catch (err) { if (current === generation.current) { setError(err instanceof Error ? err.message : 'Unable to read allowed Contacts.'); setMore(false); } }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function choose(person: DeviceContactFacts) {
    if (busy || selecting.current) return; selecting.current = true; setBusy(true); setError('');
    const current = ++generation.current;
    try {
      const selected = await readLinkedDeviceContact(person.device_id);
      if (current !== generation.current) return;
      if (selected.state !== 'available') throw new Error('This contact is no longer readable. Review Contacts permissions and refresh.');
      const preview = await stageDeviceContact(db, selected.facts);
      if (current === generation.current) router.push({ pathname: '/contacts/device-review', params: { preview, ...(typeof params.contact === 'string' ? { contact: params.contact } : {}) } });
    }
    catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : 'This review could not be started. Refresh the page and choose the person again.'); }
    finally { selecting.current = false; if (current === generation.current) setBusy(false); }
  }
  return <SafeAreaView style={styles.safe} edges={['bottom']}><Stack.Screen options={{ title: 'Browse iPhone Contacts' }} /><FlatList data={rows} keyExtractor={(row) => row.device_id} contentContainerStyle={styles.content}
    keyboardShouldPersistTaps="handled" ListHeaderComponent={<View style={styles.header}><Eyebrow>iPhone Contacts</Eyebrow><Text style={styles.title}>Choose someone to review</Text>
      <Text style={styles.body}>Browse names, emails and phone numbers that iOS allows this app to read. Nothing is imported until you select a person and confirm the review. Notes, addresses and photos are not read.</Text>
      {!consented && <ActionButton label="Allow reading and browse Contacts" disabled={busy || Platform.OS !== 'ios'} onPress={() => void load(0, true)} />}
      {consented && <><Text style={styles.body}>{limited ? 'Showing only the people allowed by limited Contacts access.' : 'Showing the address book allowed by iOS.'}</Text>
        <TextInput accessibilityLabel="Search allowed iPhone contacts" value={search} onChangeText={setSearch} placeholder="Search a name" placeholderTextColor={palette.faint} style={styles.input} returnKeyType="search" onSubmitEditing={() => void load()} />
        <ActionButton label="Search or refresh allowed people" variant="secondary" disabled={busy} onPress={() => void load()} /></>}
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}<DeviceContactAccess disabled={busy} /></View>}
    renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`Review ${item.name || 'unnamed contact'}`} disabled={busy} onPress={() => void choose(item)} style={styles.row}><Text style={styles.heading}>{item.name || 'Unnamed contact'}</Text>
      <Text style={styles.body}>{item.emails[0]?.value || item.phones[0]?.value || 'No email or phone'}</Text><Text style={styles.body}>Review fields and possible Everclose matches</Text></Pressable>}
    ListEmptyComponent={consented && !busy && !error ? <Text style={styles.body}>No allowed contacts match this page.</Text> : null}
    ListFooterComponent={<View style={styles.header}>{busy && <ActivityIndicator color={palette.primary} />}{more && <ActionButton label="Load next Contacts page" variant="secondary" disabled={busy} onPress={() => void load(offset + 50)} />}<ActionButton label="Back" variant="quiet" disabled={busy} onPress={() => router.back()} /></View>} />
  </SafeAreaView>;
}
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: palette.canvas }, content: { padding: 20, paddingBottom: 40, gap: 12 }, header: { gap: 14 }, title: { color: palette.ink, fontFamily: fonts.display, fontSize: 28, fontWeight: '700' },
  heading: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 16 }, body: { color: palette.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 21 }, error: { color: palette.primary, fontFamily: fonts.body },
  row: { gap: 6, padding: 16, minHeight: 80, borderWidth: 1, borderColor: palette.line, borderRadius: 14, backgroundColor: palette.surface }, input: { minHeight: 48, padding: 12, borderWidth: 1, borderColor: palette.line, borderRadius: 12, color: palette.ink, fontFamily: fonts.body } });
