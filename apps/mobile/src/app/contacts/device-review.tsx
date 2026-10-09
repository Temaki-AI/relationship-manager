import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FormInput as TextInput, ActionButton, Eyebrow, Surface } from '@/components/design-system';
import { PersonPicker } from '@/components/person-picker';
import { deviceContactReview, deviceImportContactRevision, saveDeviceContactReview, unlinkDeviceContact } from '@/data/device-contacts';
import { radii, fonts, palette } from '@/theme';
import { ProviderSourceError } from '../../../../../packages/domain/src/provider-sources';
import { ContactMethodError, displayContactMethodLabel } from '../../../../../packages/domain/src/contact-methods';
import { useNativeAccount } from '@/native/account';
type Review = Awaited<ReturnType<typeof deviceContactReview>>;
export default function DeviceContactReviewScreen() {
  const db = useSQLiteContext(), router = useRouter(), params = useLocalSearchParams<{ preview: string; contact?: string }>();
  const { account } = useNativeAccount();
  const id = typeof params.preview === 'string' ? params.preview : '', initialTarget = typeof params.contact === 'string' ? params.contact : null;
  const [review, setReview] = useState<Review | null>(null), [target, setTarget] = useState<string | null>(initialTarget);
  const [name, setName] = useState(''), [useName, setUseName] = useState(false), [emails, setEmails] = useState<number[]>([]), [phones, setPhones] = useState<number[]>([]);
  const [shareSource, setShareSource] = useState(Boolean(account));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const sequence = useRef(0);
  useEffect(() => {
    let active = true; const current = ++sequence.current;
    void deviceContactReview(db, id, target ?? undefined).then((value) => {
      if (!active || current !== sequence.current) return; setReview(value); if (value.target && value.target.id !== target) setTarget(value.target.id); setError(''); setName((previous) => previous || value.facts.name || '');
    }, (err) => { if (active && current === sequence.current) setError(err instanceof ProviderSourceError ? err.message : 'Unable to load this review. Choose the device contact again.'); });
    return () => { active = false; };
  }, [db, id, target]);
  async function refresh() {
    setBusy(true); setError('');
    try { setReview(await deviceContactReview(db, id, target ?? undefined)); }
    catch (err) { setError(err instanceof ProviderSourceError ? err.message : 'Could not refresh this review.'); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!review || busy) return; setBusy(true); setError('');
    try {
      const result = await saveDeviceContactReview(db, id, { contact_id: review.target?.id ?? null, create_name: review.target ? null : name.trim(), use_name: useName,
        emails, phones, expected_person: review.target ? deviceImportContactRevision(review.target) : null, expected_source_revision: review.link?.revision ?? null,
        publish_source: Boolean(account && (review.link?.shared || shareSource)) });
      router.replace({ pathname: '/contacts/[id]', params: { id: result.contact_id } });
    } catch (err) { setError(err instanceof ProviderSourceError || err instanceof ContactMethodError ? err.message : 'Your choices were not saved. Refresh while keeping your choices and try again.'); }
    finally { setBusy(false); }
  }
  function removeRetiredSource() {
    if (!review?.link || busy) return;
    const source = review.link;
    Alert.alert('Release this iPhone source?', 'Remove its saved source details from this phone so you can explicitly import it again. This does not restore or change the removed Everclose person.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Release source', style: 'destructive', onPress: () => {
        setBusy(true); setError('');
        void unlinkDeviceContact(db, source).then(() => deviceContactReview(db, id)).then(setReview)
          .catch(() => setError('Unable to release this source. Refresh the review and try again.')).finally(() => setBusy(false));
      } },
    ]);
  }
  function cancel() {
    if (review?.completed) { router.back(); return; }
    Alert.alert('Discard this review?', 'No contact fields are saved until you confirm.', [
      { text: 'Keep review', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => {
        setBusy(true); setError('');
        void db.runAsync('DELETE FROM device_contact_previews WHERE id = ? AND fingerprint IS NULL', id).then(() => router.back())
          .catch(() => setError('Unable to discard this review. Try again.')).finally(() => setBusy(false));
      } },
    ]);
  }
  function choose(personId: string | null) { if (busy) return; setUseName(false); setTarget(personId); }
  function toggle(index: number, selected: number[], change: (value: number[]) => void) { change(selected.includes(index) ? selected.filter((i) => i !== index) : [...selected, index]); }
  const targetLoaded = (review?.target?.id ?? null) === target;
  return <SafeAreaView style={styles.safe} edges={['bottom']}><Stack.Screen options={{ title: 'Review iPhone contact' }} /><KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={96}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Eyebrow>iPhone Contacts</Eyebrow><Text style={styles.title}>Choose how to save this person</Text>
      {!!error && <Surface><Text accessibilityRole="alert" style={styles.body}>{error}</Text><ActionButton label="Refresh review" disabled={busy} variant="secondary" onPress={() => void refresh()} /></Surface>}
      {!review ? <ActivityIndicator color={palette.primary} /> : <>
        <Surface><Text style={styles.heading}>{review.facts.name || 'Unnamed device contact'}</Text><Text style={styles.body}>Only the selected contact was read. Choose fields to use; private notes, history and existing preferred methods stay yours.</Text></Surface>
        {review.completed ? <Surface><Text style={styles.heading}>This review was already saved</Text><Text style={styles.body}>{review.saved ? `Your choices were saved to ${review.saved.name}.` : 'The saved person or source is no longer available. Choose the iPhone contact again for another review.'}</Text>{review.saved && <ActionButton label={`Open ${review.saved.name}`} onPress={() => router.replace({ pathname: '/contacts/[id]', params: { id: review.saved!.id } })} />}</Surface>
          : review.retired ? <Surface><Text accessibilityRole="alert" style={styles.body}>This source belongs to a removed relationship. Its saved details are retained; release the source explicitly before importing it again.</Text><ActionButton label="Release source for another import" variant="secondary" disabled={busy} onPress={removeRetiredSource} /></Surface> : <>
          {review.linked && <Surface><Text style={styles.body}>This device contact was previously linked or copied to {review.linked.name}.</Text><ActionButton label={`Review fields for ${review.linked.name}`} disabled={busy} variant="secondary" onPress={() => choose(review.linked!.id)} /></Surface>}
          <Surface><Text style={styles.heading}>Create or attach</Text>
            {review.target && targetLoaded ? <><Text style={styles.body}>Attach to {review.target.name}</Text><ActionButton label="Create a new person instead" variant="quiet" disabled={busy || Boolean(review.link)} onPress={() => choose(null)} /></>
              : !target ? <><Text style={styles.body}>New person’s name</Text><TextInput accessibilityLabel="New person’s name" value={name} maxLength={200} editable={!busy} onChangeText={setName} style={styles.input} /></> : <ActivityIndicator color={palette.primary} />}
            {!!review.matches.length && <><Text style={styles.body}>Possible matches by email or international phone. Confirm who this is before attaching.</Text>{review.matches.map((person) => <ActionButton key={person.id} variant="secondary" label={`Attach to ${person.name}`} disabled={busy || Boolean(review.link && review.link.contact_id !== person.id)} onPress={() => choose(person.id)} />)}</>}
            <PersonPicker label="Find an existing Everclose person" value={target} onChange={choose} disabled={busy || Boolean(review.link)} />
          </Surface>
          <Surface><Text style={styles.heading}>Fields to use</Text>
            {review.target && review.facts.name && <Choice label={`Use the device name: ${review.facts.name}`} checked={useName} disabled={busy || !targetLoaded} onPress={() => setUseName(!useName)} />}
            {(['emails', 'phones'] as const).map((kind) => <View key={kind} style={styles.fields}><Text style={styles.heading}>{kind === 'emails' ? 'Email addresses' : 'Phone numbers'}</Text>{review.facts[kind].map((method, index) => <Choice key={index} label={method.value + (method.label ? ` (${displayContactMethodLabel(method.label)})` : '')} checked={(kind === 'emails' ? emails : phones).includes(index)} disabled={busy} onPress={() => toggle(index, kind === 'emails' ? emails : phones, kind === 'emails' ? setEmails : setPhones)} />)}{!review.facts[kind].length && <Text style={styles.body}>None provided.</Text>}</View>)}
          </Surface>
          <Surface><Text style={styles.heading}>Saved source details</Text>
            {review.link?.shared ? <Text style={styles.body}>This source already syncs with your account. Unlink it explicitly to remove shared source details.</Text>
              : <Choice label="Save source details with my Everclose account" checked={Boolean(account && shareSource)} disabled={busy || !account} onPress={() => setShareSource(!shareSource)} />}
            <Text style={styles.body}>{account && (shareSource || review.link?.shared)
              ? 'The selected contact’s saved name, emails and phones will be available on web and your other phones, including fields you keep out of the person profile.'
              : account ? 'Source details stay on this phone. You can choose to share them later.' : 'Source details stay on this phone. Sign in to share them with your account.'}</Text>
          </Surface>
          <Text style={styles.body}>{account ? 'Accepted names, emails and phones sync with your Everclose person.' : 'Accepted fields are saved on this phone.'} Your iPhone address book stays as it is. Later source changes require another review.</Text>
          <ActionButton label={busy ? 'Saving…' : review.target ? 'Attach source and selected fields' : 'Create person and save source'} disabled={busy || !targetLoaded || !review.target && !name.trim()} onPress={() => void save()} />
        </>}
      </>}
      <ActionButton label={review?.completed ? 'Close review' : 'Cancel review'} variant="quiet" disabled={busy} onPress={cancel} />
    </ScrollView></KeyboardAvoidingView></SafeAreaView>;
}
function Choice({ label, checked, disabled, onPress }: { label: string; checked: boolean; disabled: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={onPress} style={styles.choice}><Text style={styles.check}>{checked ? '✓' : '○'}</Text><Text style={[styles.body, styles.choiceText]}>{label}</Text></Pressable>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.canvas }, content: { padding: 20, paddingBottom: 40, gap: 18 },
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 30, fontWeight: '700' }, heading: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 16 },
  body: { color: palette.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 21 }, fields: { gap: 8, marginTop: 14 },
  input: { minHeight: 50, borderWidth: 1, borderColor: palette.input, borderRadius: radii.control, padding: 12, color: palette.ink, fontFamily: fonts.body },
  choice: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }, check: { fontSize: 22, color: palette.primary }, choiceText: { flex: 1 },
});
