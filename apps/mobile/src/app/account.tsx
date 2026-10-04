import { useState } from 'react';
import { Alert, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ActionButton, Surface } from '@/components/design-system';
import { useNativeAccount } from '@/native/account';
import { useNativeSync } from '@/native/sync';
import { useRouter } from 'expo-router';
import { fonts, palette } from '@/theme';

export default function AccountScreen() {
  const { account, signIn, pending, resume, disconnect } = useNativeAccount();
  const sync = useNativeSync(), router = useRouter();
  const [server, setServer] = useState(process.env.EXPO_PUBLIC_EVERCLOSE_API_URL || 'https://everclosecrm.com');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to finish this action. Try again.'); }
    finally { setBusy(false); }
  }
  async function confirmDisconnect() {
    const revoked = await disconnect();
    if (!revoked) Alert.alert('Disconnected on this phone', 'Cloud revocation could not be confirmed. Revoke this phone from Settings on the website when you reconnect.');
  }
  return <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Surface style={styles.card}>
      <Text style={styles.title}>{account ? account.name : 'Your Everclose account'}</Text>
      {account ? <>
        <Text style={styles.body}>{account.email}</Text>
        <Text style={styles.body}>{account.origin}</Text>
        <Text style={styles.body}>Contacts captured for this account stay separate from other accounts and local-only data.</Text>
        <Text style={styles.body}>Phone session ends {new Date(account.expiresAt).toLocaleDateString()}.</Text>
        <Text style={styles.body}>{sync.syncing ? 'Syncing contacts…' : sync.summary.lastSuccess
          ? `Contacts last synced ${new Date(sync.summary.lastSuccess).toLocaleString()}.` : 'Contacts have not synced yet.'}</Text>
        {sync.summary.pending > 0 && <Text style={styles.body}>{sync.summary.pending} contact changes waiting to sync.</Text>}
        {sync.error && <Text accessibilityRole="alert" style={styles.error}>{sync.error}</Text>}
        <ActionButton label={sync.syncing ? 'Syncing…' : 'Sync now'} variant="secondary" disabled={busy || sync.syncing} onPress={() => { void sync.run(); }} />
        {sync.summary.conflicts > 0 && <ActionButton label={`Review ${sync.summary.conflicts} offline changes`} variant="secondary" onPress={() => router.push('/sync-review')} />}
        <ActionButton label="Manage phones on the web" variant="secondary" disabled={busy} onPress={() => { void Linking.openURL(`${account.origin}/settings/devices`); }} />
        <ActionButton label="Sign in again" variant="secondary" disabled={busy} onPress={() => { void run(() => signIn(account.origin)); }} />
        <ActionButton label="Disconnect this phone" variant="quiet" disabled={busy} onPress={() => Alert.alert('Disconnect this phone?',
          'Its offline data will stay on this phone. Cloud access will be revoked when reachable.', [
            { text: 'Cancel', style: 'cancel' }, { text: 'Disconnect', style: 'destructive', onPress: () => { void run(confirmDisconnect); } },
          ])} />
      </> : <>
        <Text style={styles.body}>Sign in to the same account you use on the web. Your existing local-only data stays separate on this phone.</Text>
        <Text style={styles.label}>Everclose server</Text>
        <TextInput accessibilityLabel="Everclose server" autoCapitalize="none" autoCorrect={false} keyboardType="url" value={server} onChangeText={setServer} style={styles.input} />
        <ActionButton label={busy ? 'Signing in…' : 'Continue with Google'} disabled={busy || Platform.OS === 'web'} onPress={() => { void run(() => signIn(server)); }} />
        {Platform.OS === 'web' && <Text style={styles.body}>Open the hosted Everclose website for browser sign-in.</Text>}
        {pending && <ActionButton label="Retry sign-in exchange" disabled={busy} variant="secondary" onPress={() => { void run(resume); }} />}
      </>}
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </Surface>
    <View><Text style={styles.body}>{account ? 'Contacts, interaction history and reminders sync with the web while this app is open. Offline changes wait here until the cloud confirms them.'
      : 'People, interaction history and reminders are stored on this phone until you sign in. Local-only data stays separate from account data.'}</Text></View>
  </ScrollView>;
}
const styles = StyleSheet.create({
  content: { padding: 24, gap: 20 }, card: { padding: 22, gap: 16 },
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 25 },
  body: { color: palette.muted, fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
  label: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 14 },
  input: { borderWidth: 1, borderColor: palette.line, borderRadius: 14, padding: 14, color: palette.ink, fontSize: 15 },
  error: { color: palette.primary, fontFamily: fonts.body, fontSize: 14 },
});
