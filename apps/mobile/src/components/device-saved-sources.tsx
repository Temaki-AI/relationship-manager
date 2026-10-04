import { useIsFocused, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { ActionButton, Eyebrow, Surface } from './design-system';
import { shareDeviceContact, unlinkDeviceContact } from '@/data/device-contacts';
import { savedDeviceSources, unlinkSharedDeviceSource, type SavedDeviceSource } from '@/data/device-source-sync';
import { pickDeviceContact } from '@/native/device-contacts';
import { useNativeSync } from '@/native/sync';
import { fonts, palette } from '@/theme';
import { readDeviceContactFacts } from '../../../../packages/domain/src/device-contact-facts';
import { readAppliedProviderFields, ProviderSourceError } from '../../../../packages/domain/src/provider-sources';
import { DeviceContactAccess } from './device-contact-access';
import { useNativeAccount } from '@/native/account';
export function DeviceSavedSources({ contactId }: { contactId: string }) {
  const db = useSQLiteContext(), focused = useIsFocused(), router = useRouter(), { revision } = useNativeSync();
  const { account } = useNativeAccount();
  const [sources, setSources] = useState<SavedDeviceSource[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let active = true; if (focused) void savedDeviceSources(db, contactId).then((rows) => { if (active) { setSources(rows); setError(''); } }, () => { if (active) setError('Unable to load saved device sources.'); }); return () => { active = false; }; }, [db, contactId, focused, revision]);
  async function choose() {
    setBusy(true); setError('');
    try { const preview = await pickDeviceContact(db); if (preview) router.push({ pathname: '/contacts/device-review', params: { preview, contact: contactId } }); }
    catch (err) { setError(err instanceof ProviderSourceError ? err.message : 'Unable to read that device contact. Choose it again or add fields manually.'); }
    finally { setBusy(false); }
  }
  function unlink(source: SavedDeviceSource) {
    Alert.alert('Unlink iPhone source?', source.shared ? 'Queue removal of this shared source from your account and synced devices. The person, accepted methods and private history stay in Everclose.' : 'Remove this source’s saved details from this phone. The person, accepted methods and private history stay in Everclose.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Unlink', style: 'destructive', onPress: () => { setBusy(true); setError('');
        const task = source.hasLocalLink ? unlinkDeviceContact(db, source) : unlinkSharedDeviceSource(db, source);
        void task.then(async () => setSources(await savedDeviceSources(db, contactId))).catch((err) => setError(err instanceof ProviderSourceError ? err.message : 'This source changed. Reopen the profile before unlinking.')).finally(() => setBusy(false));
      } },
    ]);
  }
  function share(source: SavedDeviceSource) {
    Alert.alert('Share saved iPhone source details?', 'Save this selected contact’s original and latest name, emails and phones with your Everclose account, including fields not copied to the profile. No iPhone contact is modified.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Share source', onPress: () => { setBusy(true); setError('');
        void shareDeviceContact(db, source).then(async () => setSources(await savedDeviceSources(db, contactId)))
          .catch((err) => setError(err instanceof ProviderSourceError ? err.message : 'Unable to share this source. Review the contact again.')).finally(() => setBusy(false));
      } },
    ]);
  }
  return <View style={styles.container}>
    {!!error && <Text accessibilityRole="alert" style={styles.body}>{error}</Text>}
    {sources.map((source) => { const original = readDeviceContactFacts(source.original_facts), facts = readDeviceContactFacts(source.observed_facts), audit = readAppliedProviderFields(source.applied_fields);
      return <Surface key={source.id}><Eyebrow>{source.shared ? 'iPhone Contacts · shared source' : 'iPhone Contacts · saved locally'}</Eyebrow><Text style={styles.heading}>{facts.name || 'Unnamed device contact'}</Text>
        <Text style={styles.body}>Last saved observation: {new Date(source.observed_at).toLocaleString()}</Text>
        {facts.emails.concat(facts.phones).map((method, index) => <Text key={index} style={styles.body}>{method.value}{method.label ? ` (${method.label})` : ''}</Text>)}
        {source.original_facts !== source.observed_facts && <><Text style={styles.heading}>Original details</Text><Text style={styles.body}>{original.name || 'Unnamed contact'}</Text>{original.emails.concat(original.phones).map((method, index) => <Text key={index} style={styles.body}>{method.value}</Text>)}</>}
        <Text style={styles.heading}>Fields accepted</Text>{audit.name && <Text style={styles.body}>Name: {audit.name}</Text>}{audit.methods.map((item) => <Text key={item.method.id} style={styles.body}>{item.method.kind}: {item.method.value}</Text>)}
        {!audit.name && !audit.methods.length && <Text style={styles.body}>Source details only.</Text>}
        <Text style={styles.body}>{source.shared ? source.fromThisPhone ? 'Shared from this phone. Manage recurring reads and field choices below.' : 'Shared from another phone. Updates depend on its Contacts permission and reading choices.' : 'These source details stay local until you explicitly share them.'}</Text>
        {source.queueStatus && <Text accessibilityLiveRegion="polite" style={styles.body}>{source.queueStatus === 'conflict' ? 'Source sync needs review.' : source.unlinkPending ? 'Unlink waiting for sync.' : 'Source upload waiting for sync.'}</Text>}
        {source.queueStatus === 'conflict' && <ActionButton label="Review source sync" variant="secondary" disabled={busy} onPress={() => router.push('/sync-review')} />}
        {source.fromThisPhone && source.hasLocalLink && <ActionButton label="iPhone reading and field choices" variant="secondary" disabled={busy || source.unlinkPending} onPress={() => router.push({ pathname: '/contacts/device-policy', params: { source: source.id } })} />}
        {!source.shared && <ActionButton label={source.installation_id ? 'Share source details with account' : 'Choose this contact again to share'} variant="secondary" disabled={busy || !account} onPress={() => source.installation_id ? share(source) : void choose()} />}
        <ActionButton label="Unlink iPhone source" variant="quiet" disabled={busy || source.unlinkPending} onPress={() => unlink(source)} />
      </Surface>;
    })}
    <ActionButton label="Link or review iPhone contact" variant="secondary" disabled={busy} onPress={() => void choose()} />
    <ActionButton label="Browse allowed iPhone contacts" variant="quiet" disabled={busy} onPress={() => router.push({ pathname: '/contacts/device-directory', params: { contact: contactId } })} />
    <DeviceContactAccess disabled={busy} />
  </View>;
}
const styles = StyleSheet.create({ container: { gap: 14 }, heading: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 16 }, body: { color: palette.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 21 } });
