import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActionButton, Eyebrow, Surface } from '@/components/design-system';
import { changeDevicePolicy, devicePolicyReview } from '@/data/device-contact-reconciliation';
import { runDeviceContactReads } from '@/native/device-contact-sync';
import { useNativeSync } from '@/native/sync';
import { fonts, palette } from '@/theme';
import { readContactMethods, displayContactMethodLabel } from '../../../../../packages/domain/src/contact-methods';
import { readDeviceContactFacts } from '../../../../../packages/domain/src/device-contact-facts';
import { observeDeviceMethod } from '../../../../../packages/domain/src/device-contact-rules';
import { ProviderSourceError } from '../../../../../packages/domain/src/provider-sources';
type Review = Awaited<ReturnType<typeof devicePolicyReview>>;
type Mode = 'keep' | 'follow';
export default function DevicePolicyScreen() {
  const db = useSQLiteContext(), router = useRouter(), params = useLocalSearchParams<{ source: string }>(), sync = useNativeSync();
  const sourceId = typeof params.source === 'string' ? params.source : '';
  const [review, setReview] = useState<Review | null>(null), [enabled, setEnabled] = useState(false), [nameMode, setNameMode] = useState<Mode>('keep');
  const [modes, setModes] = useState<Record<string, Mode>>({}), [resets, setResets] = useState<string[]>([]), [slots, setSlots] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void devicePolicyReview(db, sourceId).then((value) => { if (!active) return; setReview(value); setEnabled(Boolean(value.policy.enabled));
      setNameMode(value.fields.name.mode); setModes(Object.fromEntries(value.fields.methods.map((rule) => [rule.id, rule.mode]))); setResets([]); setSlots({});
    }, (err) => { if (active) setError(err instanceof Error ? err.message : 'Unable to read these settings.'); });
    return () => { active = false; };
  }, [db, sourceId]);
  async function refresh() {
    setBusy(true); setError('');
    try { setReview(await devicePolicyReview(db, sourceId)); }
    catch (err) { setError(err instanceof ProviderSourceError ? err.message : 'Unable to refresh these settings.'); } finally { setBusy(false); }
  }
  async function save() {
    if (!review || busy) return; setBusy(true); setError('');
    try {
      await changeDevicePolicy(db, sourceId, { expected_policy_revision: review.policy.revision, expected_source_revision: review.source.revision, expected_person: review.personRevision,
        enabled, name: nameMode, methods: review.fields.methods.map((rule) => ({ id: rule.id, mode: modes[rule.id] ?? rule.mode, ...(slots[rule.id] !== undefined ? { slot_index: slots[rule.id] } : {}) })), reset: resets });
      await sync.run(); setReview(await devicePolicyReview(db, sourceId)); setResets([]); setSlots({});
    } catch (err) { setError(err instanceof ProviderSourceError ? err.message : 'Settings were not confirmed. Refresh while keeping your choices and try again.'); }
    finally { setBusy(false); }
  }
  function confirmSave() {
    if (!review) return;
    if (enabled || resets.length) Alert.alert('Apply iPhone source choices?', `${enabled ? 'Everclose will read this linked entry while this iPhone app is in use, at most once an hour unless you check now. ' : ''}${resets.length ? 'Fields marked Use iPhone value will replace the displayed person values now. ' : ''}Future reads follow only approved fields. Private history stays intact and no iPhone contact is changed.`, [
      { text: 'Cancel', style: 'cancel' }, { text: 'Apply choices', onPress: () => void save() },
    ]); else void save();
  }
  async function checkNow() {
    if (!review || busy) return; setBusy(true); setError('');
    try { await runDeviceContactReads(db, { forceSource: sourceId }); await sync.run(); setReview(await devicePolicyReview(db, sourceId)); }
    catch { setError('Unable to check this source. Saved relationship data stays intact.'); } finally { setBusy(false); }
  }
  function toggleReset(key: string) { setResets((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]); }
  const facts = review ? readDeviceContactFacts(review.source.observed_facts) : null;
  const methods = review ? readContactMethods(review.person.contact_methods) : [];
  return <SafeAreaView style={styles.safe} edges={['bottom']}><Stack.Screen options={{ title: 'iPhone source updates' }} /><ScrollView contentContainerStyle={styles.content}>
    <Eyebrow>iPhone Contacts</Eyebrow><Text style={styles.title}>Keep this person updated</Text>
    <Text style={styles.body}>These reading choices belong to this phone. They do not import other people, expand Contacts access or write to the address book. Shared source facts and accepted field updates use your normal Everclose sync.</Text>
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!review && !error && <ActivityIndicator color={palette.primary} />}
    {review && facts && <>
      <Surface><Text style={styles.heading}>{review.person.name}</Text>
        <Choice label="Read this linked contact while the iPhone app is in use" checked={enabled} disabled={busy} onPress={() => setEnabled(!enabled)} />
        <Text style={styles.body}>{review.policy.state === 'needs_review' ? 'Reading paused after a merge or restore. Review the current person before enabling it again.'
          : review.policy.state === 'access_lost' ? 'Contacts access is off or changed. Saved data has been kept.'
            : review.policy.state === 'unavailable' ? 'The source is outside your allowed selection or could not be read. This does not prove deletion.'
              : review.policy.state === 'error' ? 'The last read could not be saved. Review the source and its size.' : review.policy.last_success_at ? `Last checked: ${new Date(review.policy.last_success_at).toLocaleString()}` : 'Not checked automatically yet.'}</Text>
      </Surface>
      <Surface><Text style={styles.heading}>Name</Text><Text style={styles.body}>Person: {review.person.name}</Text><Text style={styles.body}>iPhone: {facts.name || 'Not provided'}</Text>
        <Choice label="Follow the iPhone name" checked={nameMode === 'follow'} disabled={busy || !facts.name} onPress={() => setNameMode(nameMode === 'keep' ? 'follow' : 'keep')} />
        {(review.fields.name.overridden || nameMode === 'follow' && review.fields.name.last_applied !== review.person.name) && <Text style={styles.body}>The current name is kept until you explicitly reset it.</Text>}
        <Choice label="Use the displayed iPhone name now" checked={resets.includes('name')} disabled={busy || !facts.name} onPress={() => toggleReset('name')} />
      </Surface>
      {review.fields.methods.map((rule) => { const method = methods.find((item) => item.id === rule.id), observation = observeDeviceMethod(rule, facts), index = slots[rule.id] ?? observation.index;
        const sourceSlots = rule.kind === 'email' ? facts.emails : facts.phones, sourceSlot = index === null ? null : sourceSlots[index];
        return <Surface key={rule.id}><Text style={styles.heading}>{displayContactMethodLabel(method?.label) || rule.kind}</Text><Text style={styles.body}>Person: {method?.value || 'Removed from person'}</Text>
          <Text style={styles.body}>iPhone: {sourceSlot?.value || 'Missing or ambiguous'}</Text>
          <Choice label={`Follow this ${rule.kind} from iPhone`} checked={(modes[rule.id] ?? rule.mode) === 'follow'} disabled={busy || !method || !sourceSlot} onPress={() => setModes((previous) => ({ ...previous, [rule.id]: previous[rule.id] === 'follow' ? 'keep' : 'follow' }))} />
          {(rule.overridden || method?.value !== rule.last_applied) && <Text style={styles.body}>Your correction is kept until you explicitly reset this value.</Text>}
          <Choice label="Use the displayed iPhone value now" checked={resets.includes(rule.id)} disabled={busy || !method || !sourceSlot} onPress={() => toggleReset(rule.id)} />
          {(observation.issue || slots[rule.id] !== undefined) && method && <View style={styles.slots}><Text style={styles.body}>Choose the exact iPhone field to review:</Text>
            {sourceSlots.map((slot, slotIndex) => <Choice key={slotIndex} label={`${displayContactMethodLabel(slot.label) || rule.kind}: ${slot.value}`} checked={slots[rule.id] === slotIndex} disabled={busy} onPress={() => { setSlots((previous) => ({ ...previous, [rule.id]: slotIndex })); setResets((previous) => previous.includes(rule.id) ? previous : [...previous, rule.id]); }} />)}
          </View>}
          {rule.issue && <Text style={styles.body}>Source field needs review: {rule.issue}.</Text>}
        </Surface>;
      })}
      <ActionButton label={busy ? 'Working…' : 'Apply source choices'} disabled={busy} onPress={confirmSave} />
      <ActionButton label="Check saved reading choices now" variant="secondary" disabled={busy || !review.policy.enabled} onPress={() => void checkNow()} />
      <ActionButton label="Refresh while keeping draft choices" variant="quiet" disabled={busy} onPress={() => void refresh()} />
    </>}
    <ActionButton label="Back to person" variant="quiet" disabled={busy} onPress={() => router.back()} />
  </ScrollView></SafeAreaView>;
}
function Choice({ label, checked, disabled, onPress }: { label: string; checked: boolean; disabled: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={onPress} style={styles.choice}><Text style={styles.check}>{checked ? '✓' : '○'}</Text><Text style={[styles.body, styles.choiceText]}>{label}</Text></Pressable>;
}
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: palette.canvas }, content: { padding: 20, paddingBottom: 40, gap: 16 }, title: { color: palette.ink, fontFamily: fonts.display, fontSize: 28, fontWeight: '700' },
  heading: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 16 }, body: { color: palette.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 21 }, error: { color: palette.primary, fontFamily: fonts.body },
  choice: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }, check: { color: palette.primary, fontSize: 22 }, choiceText: { flex: 1 }, slots: { gap: 6 } });
