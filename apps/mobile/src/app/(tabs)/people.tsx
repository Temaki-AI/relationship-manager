import { pickDeviceContact } from '@/native/device-contacts';
import { DeviceContactAccess } from '@/components/device-contact-access';
import { ProviderSourceError } from '../../../../../packages/domain/src/provider-sources';
import { useIsFocused, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
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

import { ActionButton, Avatar, BrandLockup, StatusPill } from '@/components/design-system';
import { listContactPage } from '@/data/contacts';
import { getRelationshipState, type ContactRecord } from '@/domain/contact';
import { formatRelativeDate } from '@/lib/format';
import { fonts, palette } from '@/theme';
import { useNativeSync } from '@/native/sync';
import { useNativeAccount } from '@/native/account';

export default function PeopleScreen() {
  const db = useSQLiteContext();
  const focused = useIsFocused();
  const { revision, syncing, error: syncError, run } = useNativeSync();
  const { account } = useNativeAccount();
  const router = useRouter();
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [loadedKey, setLoadedKey] = useState('');
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const list = useRef<FlatList<ContactRecord>>(null);
  const queryKey = JSON.stringify([search, page, revision, retry]);
  const loading = loadedKey !== queryKey;
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!focused) return;
    let active = true;
    void listContactPage(db, search, page).then((result) => {
      if (active) { setContacts(result.contacts); setMore(result.hasMore); setLoadError(''); setLoadedKey(queryKey); }
    }, () => {
      if (active) { setContacts([]); setMore(false); setLoadError('Unable to read this page. Your saved people are still on this iPhone.'); setLoadedKey(queryKey); }
    });
    return () => { active = false; };
  }, [focused, db, search, page, revision, queryKey]);

  function changePage(next: number) {
    setPage(next);
    list.current?.scrollToOffset({ offset: 0, animated: true });
  }

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
        ref={list}
        data={loading ? [] : contacts}
        refreshing={syncing}
        onRefresh={() => { void run(); setRetry((value) => value + 1); }}
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
              onChangeText={(value) => { setSearch(value); setPage(0); }}
              onSubmitEditing={() => setRetry((value) => value + 1)}
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
        ListEmptyComponent={loading || account && syncing ? (
          <View style={styles.empty}><ActivityIndicator color={palette.primary} />
            {account && <Text style={styles.emptyText}>Downloading your workspace…</Text>}
          </View>
        ) : loadError ? (
          <View style={styles.empty}>
            <Text accessibilityRole="alert" style={styles.emptyText}>{loadError}</Text>
            <ActionButton label="Try again" variant="secondary" onPress={() => setRetry((value) => value + 1)} />
          </View>
        ) : account && syncError ? (
          <View style={styles.empty}>
            <Text accessibilityRole="alert" style={styles.emptyText}>{syncError}</Text>
            <Pressable accessibilityRole="button" onPress={() => router.push('/account')} style={styles.importButton}>
              <Text style={styles.importTitle}>Open account & sync</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{page ? 'No more people on this page' : search ? 'No one matches yet' : 'Start with one person'}</Text>
            <Text style={styles.emptyText}>
              {search ? 'Try a different name or detail.' : 'Add someone manually or choose one contact from your iPhone.'}
            </Text>
          </View>
        )}
        ListFooterComponent={loading ? null : <View style={styles.pages}>
          {page > 0 && <ActionButton label="Previous people" variant="quiet" onPress={() => changePage(page - 1)} />}
          {(page > 0 || more) && <Text style={styles.emptyText}>Page {page + 1}</Text>}
          {more && <ActionButton label="Next people" variant="quiet" onPress={() => changePage(page + 1)} />}
        </View>}
        renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.name}`}
              onPress={() => router.push({ pathname: '/contacts/[id]', params: { id: item.id } })}
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
  pages: { paddingVertical: 20, gap: 12, alignItems: 'center' },
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
