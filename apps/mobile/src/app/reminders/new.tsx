import { useIsFocused, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ActionButton, Eyebrow } from '@/components/design-system';
import { PersonPicker } from '@/components/person-picker';
import { getContact } from '@/data/contacts';
import { createReminder, isReminderNotificationCurrent, saveReminderNotification } from '@/data/reminders';
import { journalDraftKey, reminderForm } from '@/data/journal-drafts';
import { useJournalForm } from '@/native/journal-form';
import {
  getReminderPresetDate,
  REMINDER_PRESETS,
  ReminderValidationError,
  normalizeReminderDraft,
  type ReminderPresetId,
} from '@/domain/reminder';
import { cancelReminderNotification, scheduleReminderNotification } from '@/native/notifications';
import { fonts, palette } from '@/theme';
import { useNativeAccount } from '@/native/account';
import { accountScope } from '../../../../../packages/domain/src/devices';
import { formatDateTime } from '@/lib/format';

const TITLE_SUGGESTIONS = ['Send a check-in', 'Make time to catch up', 'Follow up on our last chat'];

export default function NewReminderScreen() {
  const params = useLocalSearchParams<{ contactId?: string }>();
  const initialContactId = Array.isArray(params.contactId) ? params.contactId[0] : params.contactId;
  let key = '';
  try { key = journalDraftKey('reminder', initialContactId || ''); } catch { /* Invalid deep links cannot select a saved form. */ }
  return key ? <ReminderEditor key={key} draftKey={key} initialContactId={initialContactId || ''} />
    : <View style={styles.content}><Text accessibilityRole="alert">Open a reminder form from People or Reminders.</Text></View>;
}

function ReminderEditor({ draftKey, initialContactId }: { draftKey: string; initialContactId: string }) {
  const db = useSQLiteContext();
  const { account } = useNativeAccount();
  const router = useRouter(), navigation = useNavigation();
  const focused = useIsFocused();
  const visible = useRef(true);
  useEffect(() => { visible.current = focused; return () => { visible.current = false; }; }, [focused]);
  const [hasPeople, setHasPeople] = useState<boolean | null>(null);
  const initial = useCallback(async () => {
    const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM contacts WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, id LIMIT 2');
    return reminderForm(initialContactId || (rows.length === 1 ? rows[0].id : ''));
  }, [db, initialContactId]);
  const form = useJournalForm(db, draftKey, initial);
  const { contactId, title, notes, preset } = form.draft ?? { contactId: '', title: '', notes: '', preset: 'tomorrow' };
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!focused) return;
    const tick = () => setClock(Date.now());
    void Promise.resolve().then(tick);
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [focused]);
  const [deliveryBusy, setDeliveryBusy] = useState(false), [saved, setSaved] = useState(false);
  const saving = form.saving || deliveryBusy;
  const [exitAction, setExitAction] = useState<(() => void) | null>(null);
  function close(action: () => void) { void form.close().then((done) => { if (done) setExitAction(() => action); }); }
  usePreventRemove((!!form.draft || saving) && !saved && !exitAction, ({ data }) => saving
    ? Alert.alert('Saving your reminder', 'Please wait for saving to finish.') : close(() => navigation.dispatch(data.action)));
  useEffect(() => { exitAction?.(); }, [exitAction]);
  function choosePreset(preset: ReminderPresetId) {
    form.change((current) => ({ ...current, preset, remindAt: getReminderPresetDate(preset).toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
  }

  useEffect(() => {
    if (!focused) return;
    let active = true;
    void db.getAllAsync<{ id: string }>('SELECT id FROM contacts WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, id LIMIT 2').then((rows) => {
      if (active) {
        setHasPeople(rows.length > 0);
      }
    }, () => { if (active) setHasPeople(true); });
    return () => { active = false; };
  }, [db, focused]);

  async function saveReminder() {
    const reminder = await form.save(async (current) => {
      const input = normalizeReminderDraft({ contactId: current.contactId, title: current.title, notes: current.notes, remindAt: current.remindAt });
      const contact = await getContact(db, input.contactId);
      if (!contact) throw new ReminderValidationError('This person is no longer available. Choose someone else.');
      // Commit the reminder and clear its draft before touching the OS scheduler.
      return createReminder(db, { ...input, contactId: contact.id }, null, draftKey);
    });
    if (!reminder) return;
    setSaved(true); setDeliveryBusy(true);
    let notificationId: string | null = null;
    try {
      const notification = await scheduleReminderNotification({
        accountScope: accountScope(account),
        reminderTitle: reminder.title,
        contactId: reminder.contact_id,
        contactName: reminder.contact_name,
        remindAt: new Date(reminder.remind_at),
        reminderId: reminder.id,
        isCurrent: () => isReminderNotificationCurrent(db, reminder),
      });
      notificationId = notification.id;
      if (!await saveReminderNotification(db, reminder, notificationId)) await cancelReminderNotification(notificationId);

      if (notification.permission === 'denied' && visible.current) {
        Alert.alert(
          'Reminder saved without an alert',
          'The reminder is saved. An alert was not confirmed. Check Everclose notification permission and reopen the app to retry.'
        );
      }
    } catch {
      await cancelReminderNotification(notificationId);
      if (visible.current) Alert.alert(
        'Reminder saved without an alert',
        'The reminder is saved. iOS scheduling could not be confirmed. Reopen Everclose to retry the alert; do not create the reminder again.'
      );
    } finally {
      setDeliveryBusy(false);
      if (visible.current) router.replace('/reminders');
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={96}
      style={styles.container}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.intro}>
          <Eyebrow>Future you will remember</Eyebrow>
          <Text style={styles.title}>Create one gentle nudge.</Text>
          <Text style={styles.subtitle}>Everclose stores it here and asks iOS to deliver it even when the app is closed.</Text>
        </View>

        {!!form.error && <Text accessibilityRole="alert" style={styles.subtitle}>{form.error}</Text>}
        {!form.draft ? <>
          {!form.error ? <ActivityIndicator color={palette.primary} /> : <ActionButton label="Try again" onPress={form.retry} />}
        </> : <>
        {form.resumed && <Text style={styles.subtitle}>Resumed your saved draft.</Text>}

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>For whom?</Text>
          {hasPeople === false ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/contacts/new')}
              style={styles.noContacts}
            >
              <Text style={styles.noContactsTitle}>Add someone first</Text>
              <Text style={styles.noContactsText}>A relationship reminder always belongs to a person.</Text>
            </Pressable>
          ) : (
            <PersonPicker label="Reminder person" value={contactId || null} disabled={saving}
              onChange={(id) => form.change((current) => ({ ...current, contactId: id ?? '' }))} />
          )}
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>What should you remember?</Text>
          <TextInput
            accessibilityLabel="Reminder title"
            autoCapitalize="sentences"
            maxLength={200}
            editable={!saving}
            onChangeText={(title) => form.change((current) => ({ ...current, title }))}
            placeholder="Ask how the new role is going"
            placeholderTextColor={palette.faint}
            style={styles.input}
            value={title}
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.suggestions}>
            {TITLE_SUGGESTIONS.map((suggestion) => (
              <Pressable
                key={suggestion}
                accessibilityRole="button"
                disabled={saving}
                onPress={() => form.change((current) => ({ ...current, title: suggestion }))}
                style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}
              >
                <Text style={styles.suggestionText}>{suggestion}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>When?</Text>
          <View style={styles.presets} accessibilityRole="radiogroup">
            {REMINDER_PRESETS.map((option) => {
              const selected = option.id === preset;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: saving }}
                  key={option.id}
                  disabled={saving}
                  onPress={() => choosePreset(option.id)}
                  style={({ pressed }) => [
                    styles.preset,
                    selected && styles.presetSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.presetLabel, selected && styles.presetLabelSelected]}>{option.label}</Text>
                  <Text style={[styles.presetDetail, selected && styles.presetDetailSelected]}>{option.detail}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.subtitle}>Selected time: {formatDateTime(form.draft.remindAt)} · {form.draft.timeZone}</Text>
          {Date.parse(form.draft.remindAt) <= clock && <Text accessibilityRole="alert" style={styles.subtitle}>This saved time has passed. Choose a new time before saving.</Text>}
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Private note (optional)</Text>
          <TextInput
            accessibilityLabel="Reminder notes"
            maxLength={10_000}
            multiline
            editable={!saving}
            onChangeText={(notes) => form.change((current) => ({ ...current, notes }))}
            placeholder="A little context for when the reminder arrives"
            placeholderTextColor={palette.faint}
            style={[styles.input, styles.textarea]}
            textAlignVertical="top"
            value={notes}
          />
        </View>

        <View style={styles.actions}>
          <ActionButton label={saving ? 'Saving...' : 'Save reminder'} disabled={saving || !contactId || hasPeople === null} onPress={() => void saveReminder()} />
          {!!form.error && <ActionButton label="Retry keeping draft" disabled={saving} variant="secondary" onPress={() => form.change((current) => current)} />}
        </View>
        </>}
        <Text style={styles.subtitle}>Closing keeps this unfinished form on this phone. No reminder or alert is created until Save.</Text>
        <ActionButton label="Close and keep draft" variant="secondary" disabled={saving} onPress={() => close(() => router.back())} />
        <ActionButton label="Discard draft" variant="quiet" disabled={saving} onPress={() => Alert.alert('Discard this draft?', 'Remove this unfinished form from this phone.', [
          { text: 'Keep draft', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void form.discard().then((done) => { if (done) setExitAction(() => () => router.back()); }); } },
        ])} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.canvas },
  content: { padding: 22, paddingBottom: 44, gap: 22 },
  intro: { gap: 7, marginBottom: 2 },
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 32, lineHeight: 37, fontWeight: '700', letterSpacing: -0.6 },
  subtitle: { color: palette.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 21 },
  fieldGroup: { gap: 9 },
  label: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 13, fontWeight: '700' },
  peopleRow: { gap: 9, paddingRight: 12 },
  personChoice: {
    width: 112,
    minHeight: 76,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
    padding: 10,
    gap: 7,
  },
  personChoiceSelected: { borderColor: palette.primary, backgroundColor: palette.primarySoft },
  personName: { color: palette.ink, fontFamily: fonts.bodyMedium, fontSize: 11 },
  personNameSelected: { color: palette.primary, fontFamily: fonts.bodyDemi, fontWeight: '700' },
  noContacts: { borderRadius: 18, borderWidth: 1, borderColor: '#EFC9D3', backgroundColor: palette.primarySoft, padding: 16, gap: 3 },
  noContactsTitle: { color: palette.primary, fontFamily: fonts.bodyDemi, fontSize: 14, fontWeight: '700' },
  noContactsText: { color: '#76545D', fontFamily: fonts.body, fontSize: 12, lineHeight: 18 },
  input: {
    minHeight: 51,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
    color: palette.ink,
    fontFamily: fonts.body,
    fontSize: 15,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  textarea: { minHeight: 96, lineHeight: 21 },
  suggestions: { gap: 7, paddingRight: 12 },
  suggestion: { borderRadius: 999, backgroundColor: palette.surfaceWarm, paddingHorizontal: 12, paddingVertical: 8 },
  suggestionText: { color: '#76545D', fontFamily: fonts.bodyMedium, fontSize: 11 },
  presets: { flexDirection: 'row', gap: 8 },
  preset: { flex: 1, minHeight: 67, borderRadius: 17, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, padding: 11, gap: 3 },
  presetSelected: { borderColor: palette.primary, backgroundColor: palette.primary },
  presetLabel: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 11, fontWeight: '700' },
  presetLabelSelected: { color: palette.white },
  presetDetail: { color: palette.muted, fontFamily: fonts.body, fontSize: 10 },
  presetDetailSelected: { color: '#FFE8EE' },
  actions: { gap: 10 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
});
