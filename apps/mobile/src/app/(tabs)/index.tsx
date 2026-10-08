import { useIsFocused, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton, Avatar, Eyebrow, SectionHeading, StatusPill, Surface } from '@/components/design-system';
import { Disclosure } from '@/components/disclosure';
import { getContact, getDashboardSnapshot, logInteraction, type DashboardSnapshot, type InteractionType } from '@/data/contacts';
import { getTodayQueue, type TodayPerson } from '@/data/today';
import { getPromptReview, listSnoozedPrompts, resolvePromptReview, savePromptSnooze, type SnoozedPrompt } from '@/data/today-snoozes';
import { formatDateTime, getGreeting } from '@/lib/format';
import { fonts, palette } from '@/theme';
import { useNativeSync } from '@/native/sync';
import { useNativeAccount } from '@/native/account';
import { useReminderActions } from '@/native/reminder-actions';
import { useChoiceSheet } from '@/components/choice-sheet';
import { contactMethodHref, displayContactMethodLabel, readContactMethods } from '../../../../../packages/domain/src/contact-methods';
import { promptUntil, type PromptKind } from '../../../../../packages/domain/src/today-snoozes';

const LOG_OPTIONS: { type: InteractionType; label: string }[] = [
  { type: 'message', label: 'Messaged' }, { type: 'call', label: 'Called' },
  { type: 'meetup', label: 'Met up' }, { type: 'email', label: 'Emailed' },
];
type HomeState = { snapshot: DashboardSnapshot; queue: TodayPerson[]; snoozes: SnoozedPrompt[] };
const promptLabel = (kind: PromptKind) => kind === 'birthday' ? 'Birthday' : kind === 'overdue' ? 'Check-in' : 'Reminder';
const showDay = (day: string | null) => day ? new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Available now';

export default function TodayScreen() {
  const db = useSQLiteContext();
  const focused = useIsFocused();
  const { revision, promptError } = useNativeSync();
  const { account } = useNativeAccount();
  const router = useRouter();
  const [state, setState] = useState<HomeState | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0), [workingId, setWorkingId] = useState<string | null>(null);
  const [showSnoozes, setShowSnoozes] = useState(false), [snoozeLimit, setSnoozeLimit] = useState(10);
  const visible = useRef(focused), working = useRef(false), requestState = useRef({ generation: 0 });
  const refresh = useCallback(async () => {
    if (!visible.current) return;
    const current = requestState.current, request = ++current.generation;
    try {
      const [snapshot, queue, snoozes] = await Promise.all([getDashboardSnapshot(db), getTodayQueue(db), listSnoozedPrompts(db)]);
      if (visible.current && request === current.generation) { setState({ snapshot, queue, snoozes }); setError(''); }
    } catch {
      if (visible.current && request === current.generation) setError('Unable to read today’s list. Your saved people are still here. Try again.');
    }
  }, [db]);
  const reminderActions = useReminderActions(refresh, () => working.current);
  const choices = useChoiceSheet();
  const busy = workingId !== null || reminderActions.busyId !== null;

  useEffect(() => {
    visible.current = focused;
    if (!focused) return;
    const current = requestState.current;
    void Promise.resolve().then(refresh);
    return () => { visible.current = false; current.generation++; };
  }, [focused, refresh, revision, reload]);
  useEffect(() => {
    if (!focused) return;
    const subscription = AppState.addEventListener('change', (value) => { if (value === 'active') void refresh(); });
    const timer = setInterval(() => { if (AppState.currentState === 'active') void refresh(); }, 60_000);
    return () => { subscription.remove(); clearInterval(timer); };
  }, [focused, refresh]);

  function tell(title: string, message: string) { if (visible.current) Alert.alert(title, message); }
  function begin(id: string) {
    if (!visible.current || working.current || reminderActions.isBusy()) return false;
    working.current = true; setWorkingId(id); setNotice(''); return true;
  }
  function finish() { working.current = false; setWorkingId(null); }
  async function record(person: TodayPerson, type: InteractionType) {
    if (!begin(person.contact.id)) return;
    try {
      await logInteraction(db, person.contact.id, type);
      if (visible.current) setNotice(`Conversation with ${person.contact.name} recorded.`);
      await refresh();
    } catch { tell('Could not record this conversation', 'Nothing changed. Please try again.'); }
    finally { finish(); }
  }
  function chooseLog(person: TodayPerson) {
    if (busy) return;
    choices.present('Record a conversation', `What happened with ${person.contact.name}? This records a conversation now.`, [
      ...LOG_OPTIONS.map(({ type, label }) => ({ label, onPress: () => { void record(person, type); } })),
    ]);
  }
  async function changePrompt(kind: PromptKind, targetId: string, contactId: string, untilDate: string | null) {
    if (!begin(contactId)) return;
    try {
      await savePromptSnooze(db, account, kind, targetId, untilDate, { isCurrent: () => visible.current });
      if (visible.current) setNotice(untilDate ? `${promptLabel(kind)} prompt snoozed until ${showDay(untilDate)}.` : `${promptLabel(kind)} prompt brought back.`);
      await refresh();
    } catch (cause) { tell('Could not change this prompt', cause instanceof Error ? cause.message : 'Nothing changed. Please try again.'); }
    finally { finish(); }
  }
  function choosePrompt(person: TodayPerson, kind: 'birthday' | 'overdue') {
    if (busy) return;
    choices.present(`Snooze ${promptLabel(kind).toLowerCase()} prompt`, `Only this reason for ${person.contact.name} is snoozed. Other reminders stay available. No conversation is recorded.`,
      [{ days: 1, label: 'Tomorrow' }, { days: 7, label: 'In a week' }, { days: 30, label: 'In 30 days' }].map(({ days, label }) => ({ label,
        onPress: () => { void changePrompt(kind, person.contact.id, person.contact.id, promptUntil(days)); } })));
  }
  async function reviewPrompt(item: SnoozedPrompt) {
    if (!account || !begin(item.contact_id)) return;
    try {
      const review = await getPromptReview(db, item.kind, item.target_id);
      if (!review.cloudKnown) throw new Error('Sync to load the current web choice before reviewing this prompt. Your iPhone choice is preserved.');
      choices.present(`Review ${promptLabel(item.kind).toLowerCase()} choice`, `${item.contact_name}\nOn this iPhone: ${showDay(review.until_date)}\nOn the web: ${showDay(review.remote_until_date)}\nChoose which preference to keep.`,
        [{ choice: 'cloud' as const, label: 'Use web choice', until: undefined },
          ...(!review.until_date || review.until_date >= promptUntil(1) ? [{ choice: 'phone' as const, label: 'Keep iPhone choice', until: undefined }] : []),
          ...[1, 7, 30].map((days) => ({ choice: 'phone' as const, label: `Snooze until ${showDay(promptUntil(days))}`, until: promptUntil(days) }))]
          .map(({ choice, label, until }) => ({ label, onPress: () => {
          if (!begin(item.contact_id)) return;
          void resolvePromptReview(db, account, review, choice, () => visible.current, until).then(async () => {
            if (visible.current) setNotice('Prompt choice reviewed.'); await refresh();
          }).catch((cause: unknown) => tell('Could not save this choice', cause instanceof Error ? cause.message : 'Review this prompt again.')).finally(finish);
        } })));
    } catch (cause) { tell('Could not review this choice', cause instanceof Error ? cause.message : 'Please try again.'); }
    finally { finish(); }
  }
  async function reachOut(person: TodayPerson) {
    if (!begin(person.contact.id)) return;
    try {
      const contact = await getContact(db, person.contact.id);
      if (!contact) throw new Error('This person is no longer available.');
      const methods = readContactMethods(contact.contact_methods);
      if (!methods.length) {
        tell('Add a way to reach them', 'Open their relationship to add a phone number, email or profile.'); return;
      }
      // The picker opens another app. Only an explicit Log action writes history.
      choices.present(`Reach out to ${contact.name}`, 'Opening another app does not record a conversation.', [
        ...methods.slice().sort((a, b) => Number(b.preferred) - Number(a.preferred)).slice(0, 6).map((method) => ({
          label: `${displayContactMethodLabel(method.label) || method.kind}: ${method.value}`,
          onPress: () => { void openMethod(contact.id, method.id, method.value); },
        })),
        ...(methods.length > 6 ? [{ label: 'All contact methods', onPress: () => {
          if (visible.current) router.push({ pathname: '/contacts/[id]', params: { id: contact.id } });
        } }] : []),
      ]);
    } catch (cause) { tell('Could not open contact options', cause instanceof Error ? cause.message : 'Please try again.'); }
    finally { finish(); }
  }
  async function openMethod(contactId: string, methodId: string, shownValue: string) {
    if (!begin(contactId)) return;
    try {
      const contact = await getContact(db, contactId);
      const method = contact && readContactMethods(contact.contact_methods).find((item) => item.id === methodId && item.value === shownValue);
      if (!method) throw new Error('This contact method changed. Open Reach out again to choose its current value.');
      const href = contactMethodHref(method);
      if (!href) throw new Error('Open this relationship to review the contact method.');
      await Linking.openURL(href);
    } catch (cause) { tell('Could not open another app', cause instanceof Error ? cause.message : 'Check that an app is available for this contact method.'); }
    finally { finish(); }
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.topBar}>
          <Text accessibilityRole="header" maxFontSizeMultiplier={2} style={styles.title}>Today</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Account and sync" style={styles.accountButton}
            onPress={() => router.push('/settings')}>
            <StatusPill tone={account ? 'moss' : 'amber'} label={account ? 'Account & sync' : 'Sign in'} />
          </Pressable>
        </View>
        <View style={styles.heroCopy}>
          <Eyebrow>{getGreeting()}</Eyebrow>
        </View>
        {!!error && <Surface style={styles.messageCard}>
          <Text accessibilityRole="alert" style={styles.subtitle}>{error}</Text>
          <ActionButton label="Try Today again" variant="secondary" onPress={() => setReload((value) => value + 1)} />
        </Surface>}
        {!!notice && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
        {!!account && !!promptError && !!state?.snoozes.length && <Text accessibilityRole="alert" style={styles.reasonDetail}>{promptError}</Text>}
        {!state && !error ? <View style={styles.loading}><ActivityIndicator accessibilityLabel="Loading Today" color={palette.primary} /></View> : state && <>
          <View style={styles.sectionBlock}>
            <SectionHeading title="Next up" />
            {state.queue.length ? state.queue.map((person) => <Surface key={person.contact.id} style={styles.personCard}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Open ${person.contact.name} from Today`}
                onPress={() => router.push({ pathname: '/contacts/[id]', params: { id: person.contact.id } })}
                style={({ pressed }) => [styles.identity, pressed && styles.pressed]}>
                <Avatar name={person.contact.name} size={44} />
                <Text style={styles.personName}>{person.contact.name}</Text>
              </Pressable>
              {person.reasons.map((reason) => <View key={reason.kind} style={styles.reason}>
                <Text accessibilityLabel={`${reason.title} for ${person.contact.name}`} style={styles.reasonTitle}>{reason.title}</Text>
                <Text style={styles.reasonDetail}>{reason.kind === 'reminder' && person.reminder
                  ? formatDateTime(person.reminder.remind_at) : reason.detail}</Text>
                {reason.kind !== 'reminder' && <View style={styles.actions}>
                  <QueueAction label={`Snooze ${reason.kind === 'birthday' ? 'birthday' : 'check-in'}`} disabled={busy}
                    accessibilityLabel={`Snooze ${reason.kind} prompt for ${person.contact.name}`}
                    onPress={() => choosePrompt(person, reason.kind === 'birthday' ? 'birthday' : 'overdue')} />
                </View>}
              </View>)}
              <Text numberOfLines={3} style={styles.lastConversation}>{person.latestInteraction
                ? `Last recorded: ${LOG_OPTIONS.find((item) => item.type === person.latestInteraction!.type)?.label || 'Connected'} · ${person.latestInteraction.date}${person.latestInteraction.summary ? `\n${person.latestInteraction.summary}` : ''}`
                : 'No conversation recorded yet.'}</Text>
              <View style={styles.actions}>
                <QueueAction label="Reach out" accessibilityLabel={`Reach out to ${person.contact.name}`} disabled={busy} onPress={() => { void reachOut(person); }} />
                <QueueAction label="Log" accessibilityLabel={`Log conversation with ${person.contact.name}`} disabled={busy} onPress={() => chooseLog(person)} />
                {!!person.reminder && <>
                  <QueueAction label="Done" accessibilityLabel={`Complete reminder for ${person.contact.name}: ${person.reminder.title}`} disabled={busy}
                    onPress={() => { void reminderActions.markComplete(person.reminder!); }} />
                  <QueueAction label="Snooze" accessibilityLabel={`Snooze reminder for ${person.contact.name}: ${person.reminder.title}`} disabled={busy}
                    onPress={() => reminderActions.chooseSnooze(person.reminder!)} />
                </>}
              </View>
              {!!person.reminder && <Text style={styles.actionHint}>Done completes this reminder. Log records a conversation.</Text>}
            </Surface>) : <Surface style={styles.messageCard}>
              <Text style={styles.personName}>Your day is clear</Text>
              <Text style={styles.subtitle}>{state.snapshot.contactCount === 0
                ? 'Add the first person you want to stay close to.' : 'Nothing needs your attention today. A small hello is always welcome.'}</Text>
              <ActionButton label={state.snapshot.contactCount === 0 ? 'Add someone' : 'Set a reminder'}
                onPress={() => router.push(state.snapshot.contactCount === 0 ? '/contacts/new' : '/reminders/new')} />
            </Surface>}
            {!!state.queue.length && <ActionButton label="See all reminders" variant="quiet" onPress={() => router.push('/reminders')} />}
          </View>
          {!!state.snoozes.length && <Surface style={styles.messageCard}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Snoozed prompts, ${state.snoozes.length}`}
              accessibilityState={{ expanded: showSnoozes }} style={styles.accountButton} onPress={() => setShowSnoozes((value) => !value)}>
              <Text style={styles.privacyTitle}>Snoozed prompts ({state.snoozes.length})</Text>
            </Pressable>
            {showSnoozes && <>
              {state.snoozes.slice(0, snoozeLimit).map((item) => <View key={`${item.kind}:${item.target_id}`} style={styles.reason}>
                <Text style={styles.reasonTitle}>{item.contact_name} · {item.reminder_title || promptLabel(item.kind)}</Text>
                <Text style={styles.reasonDetail}>{item.conflict ? 'Web and iPhone choices need review.'
                  : `Returns ${showDay(item.until_date)}${account && item.pending ? ' · Saved on this iPhone; waiting to sync.' : ''}`}</Text>
                <View style={styles.actions}><QueueAction label={item.conflict ? 'Review choice' : 'Bring back'} disabled={busy}
                  accessibilityLabel={`${item.conflict ? 'Review' : 'Bring back'} ${promptLabel(item.kind).toLowerCase()} prompt for ${item.contact_name}`}
                  onPress={() => { if (item.conflict) void reviewPrompt(item); else void changePrompt(item.kind, item.target_id, item.contact_id, null); }} /></View>
              </View>)}
              {state.snoozes.length > snoozeLimit && <ActionButton label="More snoozed prompts" variant="quiet" onPress={() => setSnoozeLimit((value) => value + 10)} />}
            </>}
          </Surface>}
          <Disclosure title="Relationship overview">
            <View style={styles.metrics}>
              <Metric value={state.snapshot.contactCount} label="People" />
              <Metric value={state.snapshot.touchesThisWeek} label="Conversations this week" />
            </View>
            <Text style={styles.reasonDetail}>{account ? 'Your private workspace syncs with Everclose. An offline copy stays on this iPhone.'
              : 'Your relationship data stays on this iPhone. Sign in to connect your existing workspace.'}</Text>
          </Disclosure>
        </>}
      </ScrollView>
      {choices.sheet}
      {reminderActions.sheet}
    </SafeAreaView>
  );
}

function QueueAction({ label, accessibilityLabel, disabled, onPress }: { label: string; accessibilityLabel: string; disabled: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={styles.actionText}>{label}</Text>
  </Pressable>;
}
function Metric({ value, label }: { value: number; label: string }) {
  return <Surface style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></Surface>;
}
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24, gap: 16 },
  topBar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  accountButton: { minHeight: 44, justifyContent: 'center' },
  heroCopy: { gap: 4 },
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 28, fontWeight: '700', lineHeight: 35, letterSpacing: -0.4 },
  subtitle: { color: palette.muted, fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
  loading: { minHeight: 260, alignItems: 'center', justifyContent: 'center' },
  sectionBlock: { gap: 13 },
  personCard: { padding: 18, gap: 13 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  personName: { flex: 1, color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 20, fontWeight: '700' },
  reason: { gap: 3 },
  reasonTitle: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 15 },
  reasonDetail: { color: palette.muted, fontFamily: fonts.body, fontSize: 13, lineHeight: 20 },
  lastConversation: { color: palette.muted, fontFamily: fonts.body, fontSize: 12, lineHeight: 18, borderTopWidth: 1, borderTopColor: palette.line, paddingTop: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { minWidth: 64, minHeight: 44, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 13, backgroundColor: palette.primarySoft, alignItems: 'center', justifyContent: 'center' },
  actionText: { color: palette.primary, fontFamily: fonts.bodyDemi, fontSize: 13 },
  actionHint: { color: palette.muted, fontFamily: fonts.body, fontSize: 11, lineHeight: 17 },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.72 },
  notice: { color: palette.moss, fontFamily: fonts.bodyMedium, fontSize: 14, lineHeight: 21 },
  messageCard: { padding: 18, gap: 12 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metric: { flex: 1, minWidth: 120, padding: 16, borderRadius: 20, gap: 4 },
  metricValue: { color: palette.ink, fontFamily: fonts.display, fontSize: 27, fontWeight: '700' },
  metricLabel: { color: palette.muted, fontFamily: fonts.bodyMedium, fontSize: 12 },
  privacyTitle: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 14 },
});
