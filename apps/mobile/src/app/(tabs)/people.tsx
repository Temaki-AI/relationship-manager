import { pickDeviceContact } from '@/native/device-contacts';
import { DeviceContactAccess } from '@/components/device-contact-access';
import { ProviderSourceError } from '../../../../../packages/domain/src/provider-sources';
import { Link, useIsFocused, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar, BrandLockup, StatusPill } from '@/components/design-system';
import { listContacts } from '@/data/contacts';
import { getRelationshipState, type ContactRecord } from '@/domain/contact';
import { formatRelativeDate } from '@/lib/format';
import { fonts, palette } from '@/theme';
import { useNativeSync } from '@/native/sync';

export default function PeopleScreen() {
  const db = useSQLiteContext();
  const focused = useIsFocused();
  const { revision } = useNativeSync();
  const router = useRouter();
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  const loadContacts = useCallback(async () => {
    const rows = await listContacts(db, search);
    setContacts(rows);
    setLoading(false);
  }, [db, search]);

  useEffect(() => {
    if (!focused) return;
    let active = true;
    void listContacts(db, search).then((rows) => { if (active) { setContacts(rows); setLoading(false); } });
    return () => { active = false; };
  }, [focused, db, search, revision]);

  async function importOneContact() {
    if (Platform.OS === 'web') {
      Alert.alert('Available on iPhone', 'Open Everclose on iPhone to choose a system contact.');
      return;
    }

    setImporting(true);
    try {
      const preview = await pickDeviceContact(db);
      if (preview) router.push({ pathname: '/contacts/device-review', params: { preview } });
    } catch (err) {
      Alert.alert('Contact unavailable', err instanceof ProviderSourceError ? err.message : 'Everclose could not read that contact for review. Try again.');
    } finally {
      setImporting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <FlatList
        data={contacts}
        keyExtractor={(contact) => contact.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={(
          <View style={styles.header}>
            <BrandLockup />
            <View style={styles.headingRow}>
              <View style={styles.headingCopy}>
                <Text style={styles.title}>Your people</Text>
                <Text style={styles.subtitle}>Context for the relationships that matter.</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add someone"
                onPress={() => router.push('/contacts/new')}
                style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
              >
                <Text style={styles.addButtonText}>+</Text>
              </Pressable>
            </View>
            <TextInput
              accessibilityLabel="Search people"
              autoCapitalize="none"
              onChangeText={setSearch}
              onSubmitEditing={() => void loadContacts()}
              placeholder="Search names, details, notes"
              placeholderTextColor={palette.faint}
              returnKeyType="search"
              style={styles.search}
              value={search}
            />
            <Pressable
              accessibilityRole="button"
              disabled={importing}
              onPress={() => void importOneContact()}
              style={({ pressed }) => [styles.importButton, pressed && styles.pressed]}
            >
              {importing ? <ActivityIndicator color={palette.primary} /> : (
                <>
                  <Text style={styles.importTitle}>Choose from iPhone Contacts</Text>
                  <Text style={styles.importDetail}>Choose one person and review the fields to use.</Text>
                </>
              )}
            </Pressable>
            <Pressable accessibilityRole="button" disabled={importing} onPress={() => router.push('/contacts/device-directory')} style={styles.importButton}>
              <Text style={styles.importTitle}>Browse allowed iPhone contacts</Text><Text style={styles.importDetail}>Read a page of allowed people, then confirm each import.</Text>
            </Pressable>
            <DeviceContactAccess disabled={importing} />
          </View>
        )}
        ListEmptyComponent={loading ? (
          <View style={styles.empty}><ActivityIndicator color={palette.primary} /></View>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{search ? 'No one matches yet' : 'Start with one person'}</Text>
            <Text style={styles.emptyText}>
              {search ? 'Try a different name or detail.' : 'Add someone manually or choose one contact from your iPhone.'}
            </Text>
          </View>
        )}
        renderItem={({ item }) => (
          <Link href={{ pathname: '/contacts/[id]', params: { id: item.id } }} asChild>
            <Pressable
              accessibilityLabel={`Open ${item.name}`}
              style={({ pressed }) => [styles.personRow, pressed && styles.personRowPressed]}
            >
              <Avatar name={item.name} />
              <View style={styles.personCopy}>
                <Text style={styles.personName}>{item.name}</Text>
                <Text numberOfLines={1} style={styles.personMeta}>
                  {item.email || item.phone || formatRelativeDate(item.last_contacted)}
                </Text>
              </View>
              <RelationshipPill contact={item} />
            </Pressable>
          </Link>
        )}
      />
    </SafeAreaView>
  );
}

function RelationshipPill({ contact }: { contact: ContactRecord }) {
  const state = getRelationshipState(contact);
  if (state === 'steady') return <StatusPill tone="moss" label="Steady" />;
  if (state === 'due') return <StatusPill tone="amber" label="Due" />;
  if (state === 'overdue') return <StatusPill tone="rose" label="Reach out" />;
  return <StatusPill tone="amber" label="New" />;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 30 },
  header: { gap: 18, marginBottom: 18 },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  headingCopy: { flex: 1, gap: 4 },
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 36, fontWeight: '700', letterSpacing: -0.8 },
  subtitle: { color: palette.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  addButton: {
    width: 50,
    height: 50,
    borderRadius: 18,
    backgroundColor: palette.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonText: { color: palette.white, fontFamily: fonts.body, fontSize: 30, lineHeight: 33 },
  search: {
    height: 50,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
    color: palette.ink,
    fontFamily: fonts.body,
    fontSize: 15,
    paddingHorizontal: 16,
  },
  importButton: {
    minHeight: 66,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: '#EFC9D3',
    backgroundColor: palette.primarySoft,
    paddingHorizontal: 16,
    paddingVertical: 13,
    justifyContent: 'center',
    gap: 2,
  },
  importTitle: { color: palette.primary, fontFamily: fonts.bodyDemi, fontSize: 14, fontWeight: '700' },
  importDetail: { color: '#76545D', fontFamily: fonts.body, fontSize: 11, lineHeight: 16 },
  pressed: { opacity: 0.76, transform: [{ scale: 0.99 }] },
  empty: { paddingVertical: 54, alignItems: 'center', gap: 6, paddingHorizontal: 24 },
  emptyTitle: { color: palette.ink, fontFamily: fonts.display, fontSize: 23, fontWeight: '700' },
  emptyText: { color: palette.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  personRow: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.line,
  },
  personRowPressed: { opacity: 0.64 },
  personCopy: { flex: 1, minWidth: 0, gap: 2 },
  personName: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 16, fontWeight: '700' },
  personMeta: { color: palette.muted, fontFamily: fonts.body, fontSize: 12 },
});
