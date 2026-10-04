import { Redirect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton, BrandLockup, Surface } from '@/components/design-system';
import { useNativeAccount } from '@/native/account';
import { fonts, palette } from '@/theme';

export default function IndexRedirect() {
  const db = useSQLiteContext();
  const router = useRouter();
  const { account, signIn, pending, resume } = useNativeAccount();
  const [hasLocalPeople, setHasLocalPeople] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM contacts WHERE deleted_at IS NULL')
      .then((row) => { if (active) setHasLocalPeople(Boolean(row?.count)); })
      .catch(() => { if (active) setHasLocalPeople(false); });
    return () => { active = false; };
  }, [db]);
  async function connect(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to sign in. Try again.'); }
    finally { setBusy(false); }
  }
  if (account || hasLocalPeople) return <Redirect href="/(tabs)" />;
  if (hasLocalPeople === null) return <ActivityIndicator color={palette.primary} />;
  return <SafeAreaView style={styles.safeArea}>
    <ScrollView contentContainerStyle={styles.content}>
      <BrandLockup />
      <View style={styles.intro}>
        <Text style={styles.title}>Your people, wherever you are.</Text>
        <Text style={styles.body}>Sign in to Everclose to bring your contacts, notes, plans and reminders from the web to your iPhone.</Text>
      </View>
      <Surface style={styles.card}>
        <Text style={styles.cardTitle}>Continue with your account</Text>
        <Text style={styles.body}>Google sign-in opens in your browser. Approve this iPhone to connect it to your existing Everclose workspace.</Text>
        <ActionButton label={busy ? 'Signing in…' : 'Continue with Google'} disabled={busy || Platform.OS === 'web'}
          onPress={() => { void connect(() => signIn(process.env.EXPO_PUBLIC_EVERCLOSE_API_URL || 'https://everclosecrm.com')); }} />
        {pending && <ActionButton label="Finish connecting" variant="secondary" disabled={busy} onPress={() => { void connect(resume); }} />}
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      </Surface>
      <Text style={styles.body}>After your first sync, you can work offline. Changes sync when you reconnect and open Everclose.</Text>
      <ActionButton label="Use only on this iPhone" variant="quiet" disabled={busy} onPress={() => router.replace('/(tabs)')} />
      <Text style={styles.caption}>Local-only data stays separate from your signed-in account.</Text>
      <ActionButton label="Account settings" variant="secondary" disabled={busy} onPress={() => router.push('/account')} />
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  content: { padding: 24, gap: 20, flexGrow: 1, justifyContent: 'center' },
  intro: { gap: 12, marginTop: 16 },
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 37, fontWeight: '700', lineHeight: 43 },
  card: { padding: 22, gap: 16 },
  cardTitle: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 18 },
  body: { color: palette.muted, fontFamily: fonts.body, fontSize: 15, lineHeight: 23 },
  caption: { color: palette.muted, fontFamily: fonts.body, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  error: { color: palette.danger, fontFamily: fonts.body, fontSize: 14, lineHeight: 21 },
});
