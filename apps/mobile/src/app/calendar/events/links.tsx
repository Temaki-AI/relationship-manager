import { Stack, useIsFocused, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from 'react-native';
import { ActionButton, SectionHeading } from '@/components/design-system';
import { CalendarEventCard } from '@/components/calendar-event-card';
import { CalendarLinkPicker } from '@/components/calendar-link-picker';
import { getCalendarLinkReview, saveCalendarLinks, discardCalendarLinkReview, type CalendarLinkReview } from '@/data/calendar-event-links';
import { useNativeAccount } from '@/native/account';
import { useNativeSync } from '@/native/sync';
import { accountScope } from '../../../../../../packages/domain/src/devices';
import { fonts, palette } from '@/theme';

type Editor = { identity: string; epoch: string | null; fingerprint: string | null; queueId: string | null;
  contactIds: string[]; planIds: string[]; initial: string; reviewed: boolean };
export default function MeetingLinksScreen() {
  const db = useSQLiteContext(), { account } = useNativeAccount(), sync = useNativeSync(), router = useRouter(), navigation = useNavigation(), focused = useIsFocused();
  const params = useLocalSearchParams<{ id: string }>(), id = typeof params.id === 'string' ? params.id : '';
  const identity = JSON.stringify([id, account ? accountScope(account) : '']), active = useRef<{ db: typeof db; account: typeof account } | null>(null);
  useLayoutEffect(() => { active.current = { db, account }; return () => { active.current = null; }; }, [db, account]);
  const [retry, setRetry] = useState(0), [error, setError] = useState(''), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null), [state, setState] = useState<{ key: string; review: CalendarLinkReview | null; error: string } | null>(null);
  const key = JSON.stringify([identity, sync.revision, retry]);
  const latest = state?.key === key ? state.review : null, form = editor?.identity === identity ? editor : null;
  const dirty = Boolean(form && JSON.stringify([form.contactIds, form.planIds]) !== form.initial);
  usePreventRemove((dirty || saving) && !saved, ({ data }) => saving ? Alert.alert('Saving your choices', 'Please wait for the phone save to finish.') : Alert.alert('Discard these unsaved choices?', 'Your saved meeting and earlier queued choices stay intact.', [
    { text: 'Keep editing', style: 'cancel' }, { text: 'Discard form', style: 'destructive', onPress: () => navigation.dispatch(data.action) },
  ]));
  useEffect(() => { if (saved) router.back(); }, [saved, router]);
  useEffect(() => {
    if (!focused) return; let current = true;
    void getCalendarLinkReview(db, id).then((review) => {
      if (!current) return;
      setState({ key, review, error: '' });
      setEditor((previous) => previous?.identity === identity ? previous : {
        identity, epoch: review.epoch, fingerprint: review.queue?.base_fingerprint ?? review.currentFingerprint, queueId: review.queue?.id ?? null,
        contactIds: review.contactIds, planIds: review.planIds, initial: JSON.stringify([review.contactIds, review.planIds]),
        reviewed: !review.queue || review.queue.status === 'pending' && review.queue.epoch === review.epoch && review.queue.base_fingerprint === review.currentFingerprint,
      });
    }, () => { if (current) setState({ key, review: null, error: 'Unable to load this meeting and its phone choices.' }); });
    return () => { current = false; };
  }, [db, id, focused, identity, key]);
  const locked = !!latest?.queue?.request_json && latest.queue.status === 'pending';
  const needsReview = !!form && !!latest && (!form.reviewed || form.epoch !== latest.epoch || form.fingerprint !== latest.currentFingerprint || form.queueId !== (latest.queue?.id ?? null));
  const unavailable = !latest?.event || !latest.epoch || !latest.currentFingerprint;
  const disabled = saving || locked || !latest || unavailable || !account;
  function reviewCurrent() {
    if (!latest?.event || !form || locked) return;
    setEditor({ ...form, epoch: latest.epoch, fingerprint: latest.currentFingerprint, queueId: latest.queue?.id ?? null, reviewed: true }); setError('');
  }
  async function save() {
    if (!account || !form?.epoch || !form.fingerprint || disabled || needsReview) return;
    const captured = account, isCurrent = () => active.current?.db === db && active.current.account === captured;
    setSaving(true); setError('');
    try {
      await saveCalendarLinks(db, captured, { eventId: id, epoch: form.epoch, fingerprint: form.fingerprint, queueId: form.queueId }, form.contactIds, form.planIds, isCurrent);
      if (isCurrent()) setSaved(true);
    } catch (issue) { if (isCurrent()) { setError(issue instanceof Error ? issue.message : 'Unable to save. Your choices are still here.'); setRetry((value) => value + 1); } }
    finally { if (isCurrent()) setSaving(false); }
  }
  async function discard() {
    if (!account || !latest?.queue) return;
    const captured = account, isCurrent = () => active.current?.db === db && active.current.account === captured;
    setSaving(true); setError('');
    try { await discardCalendarLinkReview(db, captured, latest.queue.id, isCurrent); if (isCurrent()) setSaved(true); }
    catch (issue) { if (isCurrent()) setError(issue instanceof Error ? issue.message : 'Unable to discard these choices.'); }
    finally { if (isCurrent()) setSaving(false); }
  }
  return <><Stack.Screen options={{ title: 'Meeting links' }} /><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={96}>
    <ScrollView style={{ backgroundColor: palette.canvas }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>People and plans</Text>
      <Text style={styles.body}>Save your choices on this phone, then sync when connected. Linking sends no invitations, changes no meeting or plan dates, and logs no interaction.</Text>
      {state?.key !== key ? <ActivityIndicator color={palette.primary} /> : state.error ? <><Text accessibilityRole="alert" style={styles.body}>{state.error}</Text><ActionButton label="Try again" onPress={() => setRetry(retry + 1)} /></> : <>
        {!!latest?.event && <CalendarEventCard event={latest.event} />}
        {unavailable && <Text style={styles.body}>This meeting is no longer saved or its first account download is incomplete. Sync to check. Removed meetings are not recreated by these choices.</Text>}
        {locked && <><Text accessibilityRole="alert" style={styles.body}>The previous request is still unconfirmed. Its choices are locked until an unchanged retry confirms the result or reports a conflict.</Text>
          <ActionButton label="Retry unchanged request" variant="secondary" disabled={sync.syncing || saving} onPress={() => { void sync.run(); }} /></>}
        {!locked && needsReview && !unavailable && <><Text accessibilityRole="alert" style={styles.body}>The meeting, account data or previous choices changed. Review the current meeting above, then keep or adjust your selections.</Text>
          <ActionButton label="I reviewed the current meeting" variant="secondary" disabled={saving} onPress={reviewCurrent} /></>}
        {latest?.queue?.status === 'conflict' && <Text style={styles.body}>{latest.queue.last_error_code === 'epoch_changed'
          ? 'Account data was restored. Review these earlier choices against the restored meeting.'
          : latest.queue.last_error_code === 'target_changed' ? 'A selected person or plan is unavailable or merged. Remove it and choose the current record.'
          : latest.queue.last_error_code === 'plan_linked' ? 'A selected plan has another meeting link. Review that link first.'
          : 'These earlier choices were held. Review the current meeting and selected links before saving again.'}</Text>}
        {form && <>
          <SectionHeading title="People" />
          <CalendarLinkPicker eventId={id} kind="person" selected={form.contactIds} disabled={disabled} onChange={(contactIds) => setEditor({ ...form, contactIds })} />
          <ActionButton label="Create a person, then return to link them" variant="quiet" disabled={saving || locked} onPress={() => router.push('/contacts/new')} />
          <SectionHeading title="Plans" />
          <CalendarLinkPicker eventId={id} kind="plan" selected={form.planIds} disabled={disabled} onChange={(planIds) => setEditor({ ...form, planIds })} />
          <ActionButton label={saving ? 'Saving…' : 'Save links on this phone'} disabled={disabled || needsReview} onPress={() => Alert.alert('Save these meeting links?',
            `${form.contactIds.length} people and ${form.planIds.length} plans will be linked after sync. Source details, plan dates and private history stay as they are.`, [
              { text: 'Keep editing', style: 'cancel' }, { text: 'Save links', onPress: () => { void save(); } },
            ])} />
        </>}
        {latest?.queue?.status === 'conflict' && <ActionButton label="Discard held phone choices" variant="quiet" disabled={saving} onPress={() => Alert.alert('Discard held choices?', 'Remove this held phone intent and show the cloud links. The meeting, people, plans and history stay intact.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Discard choices', style: 'destructive', onPress: () => { void discard(); } },
        ])} />}
      </>}
      {!!error && <Text accessibilityRole="alert" style={styles.body}>{error}</Text>}
      {!!sync.error && <Text style={styles.body}>{sync.error}</Text>}
      <ActionButton label="Back to meeting" variant="secondary" disabled={saving} onPress={() => router.back()} />
    </ScrollView>
  </KeyboardAvoidingView></>;
}
const styles = StyleSheet.create({ content: { padding: 20, paddingBottom: 44, gap: 16 },
  title: { fontFamily: fonts.display, fontSize: 28, color: palette.ink }, body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22, color: palette.muted } });
