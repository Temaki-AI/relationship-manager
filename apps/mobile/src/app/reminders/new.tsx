import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ActionButton, Avatar, Eyebrow } from '@/components/design-system';
import { listContacts } from '@/data/contacts';
import { createReminder } from '@/data/reminders';
import type { ContactRecord } from '@/domain/contact';
import {
  getReminderPresetDate,
  REMINDER_PRESETS,
  ReminderValidationError,
  type ReminderPresetId,
} from '@/domain/reminder';
import { cancelReminderNotification, scheduleReminderNotification } from '@/native/notifications';
import { fonts, palette } from '@/theme';

const TITLE_SUGGESTIONS = ['Send a check-in', 'Make time to catch up', 'Follow up on our last chat'];

export default function NewReminderScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const params = useLocalSearchParams<{ contactId?: string }>();
  const initialContactId = Array.isArray(params.contactId) ? params.contactId[0] : params.contactId;
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [contactId, setContactId] = useState(initialContactId || '');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [preset, setPreset] = useState<ReminderPresetId>('tomorrow');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void listContacts(db).then((rows) => {
      if (active) {
        setContacts(rows);
        if (!contactId && rows.length === 1) setContactId(rows[0].id);
      }
    });
    return () => { active = false; };
  }, [contactId, db]);

  async function saveReminder() {
    const contact = contacts.find((candidate) => candidate.id === contactId);
    if (!contact) {
      Alert.alert('Choose someone', 'A reminder needs a person before it can be saved.');
      return;
    }

    setSaving(true);
    const remindAt = getReminderPresetDate(preset);
    let notificationId: string | null = null;
    try {
      const notification = await scheduleReminderNotification({
        reminderTitle: title.trim() || 'Reach out',
        contactId: contact.id,
        contactName: contact.name,
        remindAt,
      });
      notificationId = notification.id;
      await createReminder(db, {
        contactId: contact.id,
        title,
        notes,
        remindAt,
      }, notificationId);

      if (notification.permission === 'denied') {
        Alert.alert(
          'Reminder saved without an alert',
          'You can enable Bonds notifications later in iPhone Settings.'
        );
      }
      router.replace('/reminders');
    } catch (error) {
      await cancelReminderNotification(notificationId);
      Alert.alert(
        'Could not save reminder',
        error instanceof ReminderValidationError ? error.message : 'Nothing changed. Please try again.'
      );
    } finally {
      setSaving(false);
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
          <Text style={styles.subtitle}>Bonds stores it here and asks iOS to deliver it even when the app is closed.</Text>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>For whom?</Text>
          {contacts.length === 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/contacts/new')}
              style={styles.noContacts}
            >
              <Text style={styles.noContactsTitle}>Add someone first</Text>
              <Text style={styles.noContactsText}>A relationship reminder always belongs to a person.</Text>
            </Pressable>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.peopleRow}>
              {contacts.map((contact) => {
                const selected = contact.id === contactId;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    key={contact.id}
                    onPress={() => setContactId(contact.id)}
                    style={({ pressed }) => [
                      styles.personChoice,
                      selected && styles.personChoiceSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Avatar name={contact.name} size={38} />
                    <Text numberOfLines={1} style={[styles.personName, selected && styles.personNameSelected]}>
                      {contact.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>What should you remember?</Text>
          <TextInput
            accessibilityLabel="Reminder title"
            autoCapitalize="sentences"
            maxLength={200}
            onChangeText={setTitle}
            placeholder="Ask how the new role is going"
            placeholderTextColor={palette.faint}
            style={styles.input}
            value={title}
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.suggestions}>
            {TITLE_SUGGESTIONS.map((suggestion) => (
              <Pressable
                key={suggestion}
                onPress={() => setTitle(suggestion)}
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
                  accessibilityState={{ checked: selected }}
                  key={option.id}
                  onPress={() => setPreset(option.id)}
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
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Private note (optional)</Text>
          <TextInput
            accessibilityLabel="Reminder notes"
            maxLength={10_000}
            multiline
            onChangeText={setNotes}
            placeholder="A little context for when the reminder arrives"
            placeholderTextColor={palette.faint}
            style={[styles.input, styles.textarea]}
            textAlignVertical="top"
            value={notes}
          />
        </View>

        <View style={styles.actions}>
          <ActionButton label={saving ? 'Saving...' : 'Save reminder'} disabled={saving || contacts.length === 0} onPress={() => void saveReminder()} />
          <ActionButton label="Cancel" variant="secondary" disabled={saving} onPress={() => router.back()} />
        </View>
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
