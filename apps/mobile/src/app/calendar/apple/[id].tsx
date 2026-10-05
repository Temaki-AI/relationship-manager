import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { ActionButton, Surface } from '@/components/design-system';
import { appleCalendarReview, prepareAppleCalendar, discardAppleCalendar, openAppleCalendarEditor, verifyAppleCalendar, findAppleCalendar, disableAppleCalendarReads, editAppleCalendar } from '@/data/apple-calendar';
import { appleCalendarAdapter as adapter } from '@/native/apple-calendar';
import { useNativeAccount } from '@/native/account';
import { useNativeSync } from '@/native/sync';
import { accountScope } from '../../../../../../packages/domain/src/devices';
import { appleCalendarDraft, readAppleCalendarFacts, type AppleCalendarDraft, type AppleCalendarFacts } from '../../../../../../packages/domain/src/apple-calendar';
import { fonts, palette } from '@/theme';

type Review = Awaited<ReturnType<typeof appleCalendarReview>>;
function dayAfter(day: string) { const date = new Date(day); if (!Number.isFinite(date.valueOf())) return ''; date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); }
function Field({ label, value, change }: { label: string; value: string; change: (text: string) => void }) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={change} style={styles.input} autoCapitalize="none" /></View>;
}
function Choice({ label, value, change }: { label: string; value: boolean; change: (value: boolean) => void }) {
  return <View style={styles.choice}><Text style={styles.choiceLabel}>{label}</Text><Switch accessibilityLabel={label} value={value} onValueChange={change} /></View>;
}
const statusLabels: Record<string, string> = { prepared: 'Ready for the system editor', unknown: 'Editor result unconfirmed', saved: 'Editor closed · verification needed', verified: 'Event verified', cancelled: 'Creation cancelled', held: 'Updates paused · review required', missing: 'Event unavailable · review required', discarded: 'Unopened review discarded' };

export default function AppleCalendarScreen() {
  const db = useSQLiteContext(), focused = useIsFocused(), router = useRouter(), { account } = useNativeAccount(), { revision } = useNativeSync();
  const params = useLocalSearchParams<{ id: string; receipt?: string }>(), id = typeof params.id === 'string' ? params.id : '';
  const receiptId = typeof params.receipt === 'string' ? params.receipt : undefined;
  const [review, setReview] = useState<Review | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(''), [location, setLocation] = useState(''), [start, setStart] = useState(''), [end, setEnd] = useState('');
  const [zone, setZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone), [allDay, setAllDay] = useState(true);
  const [reads, setReads] = useState(false), [follow, setFollow] = useState(false), [calendars, setCalendars] = useState<{ id: string; title: string }[]>([]);
  const [calendarId, setCalendarId] = useState(''), [searchStart, setSearchStart] = useState(''), [searchEnd, setSearchEnd] = useState(''), [candidate, setCandidate] = useState<AppleCalendarFacts | null>(null);
  const [calendarPage, setCalendarPage] = useState(0);
  const scope = accountScope(account), active = useRef(false), currentScope = useRef(scope), busyRef = useRef(false), initialized = useRef('');
  useEffect(() => { currentScope.current = scope; active.current = true; return () => { active.current = false; }; }, [scope]);
  const isCurrent = useCallback(() => active.current && currentScope.current === scope, [scope]);
  const load = useCallback(async () => {
    const value = await appleCalendarReview(db, id, receiptId);
    if (!isCurrent()) return;
    setReview(value);
    const key = `${scope}:${id}:${value.receipt?.id ?? ''}`;
    if (initialized.current !== key) {
      initialized.current = key;
      const draft = value.receipt ? (JSON.parse(value.receipt.request_json) as { draft: AppleCalendarDraft }).draft : null;
      const day = String(value.plan?.planned_date ?? new Date().toISOString().slice(0, 10));
      const kind = String(value.plan?.type || 'Meeting');
      setTitle(draft?.title ?? kind.charAt(0).toUpperCase() + kind.slice(1)); setLocation(draft?.location ?? '');
      setAllDay(draft ? draft.start.date !== null : true); setStart(draft?.start.date ?? draft?.start.date_time ?? day); setEnd(draft?.end.date ?? draft?.end.date_time ?? dayAfter(day));
      if (draft?.start.time_zone) setZone(draft.start.time_zone);
      setReads(Boolean(value.receipt?.read_enabled)); setFollow(Boolean(value.receipt?.follow_date));
      setSearchStart(day); setSearchEnd(dayAfter(day)); setCandidate(null); setCalendars([]); setCalendarId(''); setCalendarPage(0);
    }
  }, [db, id, receiptId, scope, isCurrent]);
  useEffect(() => {
    if (!focused) return;
    void Promise.resolve().then(load).catch((failure) => { if (isCurrent()) setError(failure instanceof Error ? failure.message : 'Unable to load this review.'); });
  }, [focused, revision, load, isCurrent]);
  async function run(action: () => Promise<unknown>) {
    if (busyRef.current || !isCurrent()) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await action(); if (isCurrent()) await load(); }
    catch (failure) {
      if (isCurrent()) { setError(failure instanceof Error ? failure.message : 'Unable to complete this Calendar action.'); await load().catch(() => {}); }
    } finally { busyRef.current = false; if (isCurrent()) setBusy(false); }
  }
  if (Platform.OS !== 'ios') return <Text style={styles.content}>The system Calendar bridge is available on iPhone and iPad.</Text>;
  if (!account) return <View style={styles.content}>
    <Stack.Screen options={{ title: 'Plan in Calendar' }} />
    <Text style={styles.title}>Connect your workspace</Text>
    <Text style={styles.body}>Sign in before linking a plan to Calendar. Your local-only people and plans stay separate from your account.</Text>
    <ActionButton label="Open account & sign in" onPress={() => router.push('/account')} />
  </View>;
  if (!review) return <View style={styles.content}>{error ? <Text accessibilityRole="alert">{error}</Text> : <ActivityIndicator />}</View>;
  const receipt = review.receipt, open = Boolean(review.plan && !review.plan.completed_at), canPrepare = open && !review.linkedEventId && (!receipt || ['cancelled', 'discarded'].includes(receipt.status));
  const saved = receipt?.facts ? readAppleCalendarFacts(JSON.parse(receipt.facts)) : null;
  const proof = { revision: receipt?.revision ?? 0, epoch: review.epoch, planFingerprint: review.planFingerprint };
  async function verify(selected?: AppleCalendarFacts) {
    if (!account || !receipt) return;
    await verifyAppleCalendar(db, account, receipt.id, { ...proof, reads, follow }, adapter, isCurrent, selected);
    setCandidate(null);
  }
  return <>
    <Stack.Screen options={{ title: 'Plan in Calendar' }} />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{review.person?.name ?? 'Saved plan'}</Text>
      <Text style={styles.body}>Save selected event fields in Apple’s system editor. Your private CRM notes and completion history stay in Everclose. The editor lets you choose the calendar and any invitees.</Text>
      {!!error && <Text accessibilityRole="alert" style={styles.body}>{error}</Text>}
      {!open && <Text style={styles.body}>This plan is completed or unavailable. Its original Calendar receipt remains here; automatic date updates are paused.</Text>}
      {!!review.linkedEventId && <Text style={styles.body}>This plan already has a saved Calendar association. Review that meeting before publishing another event.</Text>}
      {canPrepare && <Surface style={styles.panel}>
        <Field label="Event title" value={title} change={setTitle} /><Field label="Location" value={location} change={setLocation} />
        <Choice label="All-day event" value={allDay} change={(value) => { setAllDay(value); const day = String(review.plan!.planned_date); setStart(value ? day : day + 'T09:00:00'); setEnd(value ? dayAfter(day) : day + 'T10:00:00'); }} />
        <Field label={allDay ? 'Start date (YYYY-MM-DD)' : 'Start time (YYYY-MM-DDTHH:mm:ss)'} value={start} change={setStart} />
        <Field label={allDay ? 'End date, exclusive (YYYY-MM-DD)' : 'End time (YYYY-MM-DDTHH:mm:ss)'} value={end} change={setEnd} />
        {!allDay && <><Field label="Timezone (for example Europe/Lisbon)" value={zone} change={setZone} /><Text style={styles.body}>For a time repeated when clocks change, add its UTC offset, such as +01:00.</Text></>}
        <ActionButton label="Review for Calendar" disabled={busy} onPress={() => { void run(async () => {
          const draft = appleCalendarDraft({ title, location, start: { date: allDay ? start : null, date_time: allDay ? null : start, time_zone: allDay ? null : zone }, end: { date: allDay ? end : null, date_time: allDay ? null : end, time_zone: allDay ? null : zone } }).draft;
          const prepared = await prepareAppleCalendar(db, account, id, { operationId: Crypto.randomUUID(), epoch: review.epoch, planFingerprint: review.planFingerprint, draft }, isCurrent);
          if (isCurrent()) router.setParams({ receipt: prepared.id });
        }); }} />
      </Surface>}
      {receipt && <Surface style={styles.panel}>
        <Text style={styles.heading}>{statusLabels[receipt.status] ?? 'Calendar receipt'}</Text>
        <Text style={styles.body}>Last review: {title} · {start} → {end}</Text>
        {saved && <Text style={styles.body}>Last verified event: {saved.title} · {saved.start} → {saved.end} · {saved.time_zone}{saved.all_day ? ' · All day' : ''}{saved.cancelled ? ' · Cancelled' : ''}</Text>}
        {receipt.status === 'prepared' && !receipt.attempted && <ActionButton label="Open system event editor" disabled={busy || !open} onPress={() => Alert.alert('Open Calendar’s event editor?', `${title}\n${start} → ${end}\n\nReview the calendar, visibility and invitees in Apple’s editor before saving. On iOS 16, Calendar access is required.`, [
          { text: 'Cancel', style: 'cancel' }, { text: 'Open editor', onPress: () => { void run(() => openAppleCalendarEditor(db, account, receipt.id, receipt.revision, adapter, isCurrent)); } },
        ])} />}
        {!receipt.attempted && ['prepared', 'held'].includes(receipt.status) && <ActionButton label="Discard unopened review" variant="quiet" disabled={busy} onPress={() => { void run(() => discardAppleCalendar(db, account, receipt.id, receipt.revision, isCurrent)); }} />}
        {!!receipt.attempted && !['cancelled', 'discarded'].includes(receipt.status) && <>
          <Text style={styles.body}>Verification needs full Calendar read access. A saved or unconfirmed event is never created again automatically. These event facts stay on this phone; an approved plan-date change syncs to Everclose.</Text>
          {open && <><Choice label="Keep this event’s facts updated on this phone" value={reads} change={(value) => { setReads(value); if (!value) setFollow(false); }} />
            <Choice label="Follow the event date for this plan" value={follow} change={(value) => { setFollow(value); if (value) setReads(true); }} /></>}
          {!!receipt.event_id && <ActionButton label="Verify original event" disabled={busy} onPress={() => Alert.alert('Read the original Calendar event?', `Allow Calendar reading to verify this receipt.${reads ? ' Keep its facts updated while this phone is running.' : ''}${follow ? ' Use its date for this plan now and follow later date changes.' : ''} Notes and completion history are retained.`, [
            { text: 'Cancel', style: 'cancel' }, { text: 'Verify', onPress: () => { void run(() => verify()); } },
          ])} />}
          <ActionButton label="Find original event in a calendar" variant="secondary" disabled={busy} onPress={() => Alert.alert('Choose a calendar to search?', 'Allow Calendar reading, then choose one calendar and a date window. Only the event matching this receipt can be accepted.', [
            { text: 'Cancel', style: 'cancel' }, { text: 'Choose calendar', onPress: () => { void run(async () => { if (!await adapter.permission(true)) throw new Error('Calendar reading was not allowed.'); if (!isCurrent()) throw new Error('The active account changed.'); const values = await adapter.calendars(); if (isCurrent()) { setCalendars(values); setCalendarPage(0); } }); } },
          ])} />
          {!!calendars.length && <>
            {calendars.slice(calendarPage * 50, calendarPage * 50 + 50).map((calendar) => <ActionButton key={calendar.id} label={`${calendarId === calendar.id ? '✓ ' : ''}${calendar.title}`} variant="secondary" disabled={busy} onPress={() => { setCalendarId(calendar.id); setCandidate(null); }} />)}
            <Text style={styles.body}>Calendar page {calendarPage + 1} of {Math.ceil(calendars.length / 50)}{calendarId ? ` · Selected: ${calendars.find((calendar) => calendar.id === calendarId)?.title ?? 'Original calendar'}` : ''}</Text>
            {calendarPage > 0 && <ActionButton label="Previous calendar page" variant="quiet" disabled={busy} onPress={() => setCalendarPage(calendarPage - 1)} />}
            {(calendarPage + 1) * 50 < calendars.length && <ActionButton label="Next calendar page" variant="quiet" disabled={busy} onPress={() => setCalendarPage(calendarPage + 1)} />}
            <Field label="Search from (YYYY-MM-DD)" value={searchStart} change={setSearchStart} /><Field label="Search until, exclusive (YYYY-MM-DD)" value={searchEnd} change={setSearchEnd} />
            <Text style={styles.body}>Search dates use this phone’s timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</Text>
            <ActionButton label="Search for original receipt" disabled={busy || !calendarId} onPress={() => { void run(async () => {
              const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
              const window = appleCalendarDraft({ title: 'Find original event', location: '', start: { date: null, date_time: searchStart + 'T00:00:00', time_zone: timeZone }, end: { date: null, date_time: searchEnd + 'T00:00:00', time_zone: timeZone } }).event;
              const value = await findAppleCalendar(db, account, receipt.id, calendarId, window.startDate, window.endDate, adapter, isCurrent); if (isCurrent()) setCandidate(value);
            }); }} />
          </>}
          {candidate && <><Text style={styles.body}>Found: {candidate.title} · {candidate.start} → {candidate.end} · {candidate.time_zone}</Text>
            <ActionButton label="Verify and link this original event" disabled={busy} onPress={() => Alert.alert('Verify this event?', `${candidate.title}\n${candidate.start} → ${candidate.end}${follow ? '\nUse and follow its date for this plan.' : ''}${reads ? '\nKeep facts updated on this phone.' : ''}`, [
              { text: 'Cancel', style: 'cancel' }, { text: 'Verify', onPress: () => { void run(() => verify(candidate)); } },
            ])} /></>}
          {receipt.status === 'verified' && open && !review.linkedEventId && <ActionButton label="Edit original event in Calendar" variant="secondary" disabled={busy} onPress={() => Alert.alert('Edit the original event?', 'Apple’s editor controls the calendar, guests and invitation effects. Date updates pause until you verify the event again.', [
            { text: 'Cancel', style: 'cancel' }, { text: 'Open editor', onPress: () => { void run(() => editAppleCalendar(db, account, receipt.id, proof, adapter, isCurrent)); } },
          ])} />}
          {!!receipt.read_enabled && <ActionButton label="Stop event reads and date following" variant="quiet" disabled={busy} onPress={() => { void run(async () => { await disableAppleCalendarReads(db, account, receipt.id, receipt.revision, isCurrent); setReads(false); setFollow(false); }); }} />}
        </>}
      </Surface>}
    </ScrollView>
  </>;
}
const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 48, gap: 16 }, panel: { padding: 20, gap: 16 }, field: { gap: 8 }, choice: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  title: { fontFamily: fonts.display, fontSize: 30, color: palette.ink }, heading: { fontFamily: fonts.bodyDemi, fontSize: 20, color: palette.ink },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22, color: palette.muted }, label: { fontFamily: fonts.bodyDemi, color: palette.ink },
  choiceLabel: { flex: 1, fontFamily: fonts.body, fontSize: 15, color: palette.ink }, input: { borderWidth: 1, borderColor: palette.line, borderRadius: 12, padding: 12, color: palette.ink, fontFamily: fonts.body, minHeight: 48 },
});
