import { useIsFocused, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Text, View } from 'react-native';
import { ActionButton, SectionHeading, Surface } from './design-system';
import { useNativeAccount } from '@/native/account';
import { useNativeSync } from '@/native/sync';
import { readGmailContext, refreshGmailPerson } from '@/data/gmail-context';
import { palette } from '@/theme';

export function PersonGmailContext({ contactId }: { contactId: string }) {
  const db = useSQLiteContext(), focused = useIsFocused(), router = useRouter(), { account } = useNativeAccount(), { revision, gmailError } = useNativeSync();
  const [sourceId, setSourceId] = useState(''), [reload, setReload] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const key = JSON.stringify([contactId, account?.origin, account?.workspaceId, account?.userId, sourceId, revision, reload]);
  const [saved, setSaved] = useState<{ key: string; value: Awaited<ReturnType<typeof readGmailContext>> } | null>(null);
  const generation = useRef(0);
  const [visible, setVisible] = useState(5);
  useEffect(() => {
    const current = ++generation.current;
    if (!focused || !account) return; let active = true;
    void (async () => {
      let value = await readGmailContext(db, account, sourceId, contactId);
      if (active) setError('');
      if (value.manifest?.sources.length && !value.manifest.sources.some((source) => source.id === sourceId)) {
        if (active) setSourceId(value.manifest.sources[0].id); return;
      }
      if (value.manifest && sourceId && !value.cached) {
        try { await refreshGmailPerson(db, account, sourceId, contactId, null, { isCurrent: () => active }); }
        catch (err) { if (active) setError(err instanceof Error ? err.message : 'Could not refresh email context.'); }
        value = await readGmailContext(db, account, sourceId, contactId);
      }
      if (active) setSaved({ key, value });
    })().catch(() => { if (active) { setSaved(null); setError('Could not read saved email context.'); } });
    return () => { active = false; generation.current = current + 1; };
  }, [db, account, focused, contactId, sourceId, key]);
  async function fetchPage(after: string | null) {
    if (!account || busy) return;
    setBusy(true); setError('');
    const current = generation.current;
    try { await refreshGmailPerson(db, account, sourceId, contactId, after, { isCurrent: () => generation.current === current && focused }); }
    catch (err) { if (generation.current === current) setError(err instanceof Error ? err.message : 'Could not refresh email context.'); }
    finally { setBusy(false); if (generation.current === current) setReload((value) => value + 1); }
  }
  if (!account) return null;
  const value = saved?.key === key ? saved.value : null;
  return <View style={{ gap: 12 }}><SectionHeading title="Email context" />
    <Text style={{ color: palette.muted }}>Reviewed Gmail metadata. Observed email does not mark this person as contacted.</Text>
    {!value && !error && <ActivityIndicator color={palette.primary} />}
    {(error || gmailError) && <Text accessibilityRole="alert">{error || gmailError}</Text>}
    {value && !value.enabled ? <><Text style={{ color: palette.muted }}>Choose whether to save reviewed email metadata on this phone.</Text><ActionButton label="Email storage settings" variant="quiet" onPress={() => router.push('/account')} /></>
      : value?.pendingIdentity ? <Text style={{ color: palette.muted }}>Email matching is on hold while contact changes sync.</Text>
      : value?.preparing ? <Text style={{ color: palette.muted }}>Matching contact email identities. Refresh shortly.</Text>
      : value && !value.manifest ? <Text style={{ color: palette.muted }}>Connect to refresh the email review before displaying cached messages.</Text>
      : value?.manifest && <>
        <View style={{ gap: 8 }}>{value.manifest.sources.map((source) => <ActionButton key={source.id} label={source.email} selected={source.id === sourceId} variant={source.id === sourceId ? 'secondary' : 'quiet'} disabled={busy} onPress={() => { setVisible(5); setSourceId(source.id); }} />)}</View>
        {value.checkedAt !== null && <Text style={{ color: palette.muted }}>Saved {new Date(value.checkedAt).toLocaleString()}. Permission review is valid for at most 24 hours offline.</Text>}
        {value.messages.length ? value.messages.slice(0, visible).map((message) => <Surface key={message.id} style={{ padding: 14, gap: 8 }}>
          <Text style={{ color: palette.ink }}>{message.direction === 'incoming' ? 'Received email' : message.direction === 'outgoing' ? 'Sent email' : 'Observed email'} · {new Date(message.received_at).toLocaleString()}</Text>
          <Text style={{ color: palette.muted }}>{message.subject ?? 'Subject not retained'}</Text>
          <Text style={{ color: palette.muted }}>{message.linked_addresses.join(', ')}</Text>
        </Surface>) : <Text style={{ color: palette.muted }}>No reviewed correspondence in this mailbox’s saved window.</Text>}
        {visible < value.messages.length && <ActionButton label="Show more saved email context" variant="quiet" onPress={() => setVisible((count) => count + 20)} />}
        {sourceId && <ActionButton label={busy ? 'Refreshing…' : 'Refresh email context'} variant="quiet" disabled={busy} onPress={() => { void fetchPage(null); }} />}
        {value.next && !value.limitReached && visible >= value.messages.length && <ActionButton label="Older reviewed messages" variant="quiet" disabled={busy} onPress={() => { void fetchPage(value.next); }} />}
        {value.limitReached && value.next && <Text style={{ color: palette.muted }}>The offline cache holds up to 500 messages. Review older messages on the web.</Text>}
      </>}
    <ActionButton label="Connect or review Gmail on the web" variant="quiet" onPress={() => { void Linking.openURL(`${account.origin}/connections/google/gmail`); }} />
  </View>;
}
