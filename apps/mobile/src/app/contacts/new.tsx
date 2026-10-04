import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
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

import { ActionButton, Eyebrow } from '@/components/design-system';
import { createContact } from '@/data/contacts';
import {
  CONTACT_FREQUENCY_OPTIONS,
  ContactValidationError,
} from '@/domain/contact';
import { fonts, palette } from '@/theme';

export default function NewContactScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [frequency, setFrequency] = useState(14);
  const [saving, setSaving] = useState(false);

  async function saveContact() {
    setSaving(true);
    try {
      const contact = await createContact(db, {
        name,
        email,
        phone,
        notes,
        contactFrequency: frequency,
      });
      router.replace({ pathname: '/contacts/[id]', params: { id: contact.id } });
    } catch (error) {
      Alert.alert(
        'Could not add contact',
        error instanceof ContactValidationError ? error.message : 'Your changes were not saved. Try again.'
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
          <Eyebrow>Relationship journal</Eyebrow>
          <Text style={styles.title}>Who do you want to remember well?</Text>
          <Text style={styles.subtitle}>Start light. You can add richer context as the relationship unfolds.</Text>
        </View>

        <Field label="Name" required>
          <TextInput
            accessibilityLabel="Name"
            autoCapitalize="words"
            autoComplete="name"
            autoFocus
            maxLength={200}
            onChangeText={setName}
            placeholder="Maya Chen"
            placeholderTextColor={palette.faint}
            returnKeyType="next"
            style={styles.input}
            value={name}
          />
        </Field>

        <Field label="Email">
          <TextInput
            accessibilityLabel="Email"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            maxLength={320}
            onChangeText={setEmail}
            placeholder="maya@example.com"
            placeholderTextColor={palette.faint}
            style={styles.input}
            value={email}
          />
        </Field>

        <Field label="Phone">
          <TextInput
            accessibilityLabel="Phone"
            autoComplete="tel"
            keyboardType="phone-pad"
            maxLength={100}
            onChangeText={setPhone}
            placeholder="+49 30 1234 5678"
            placeholderTextColor={palette.faint}
            style={styles.input}
            value={phone}
          />
        </Field>

        <Field label="A detail worth remembering">
          <TextInput
            accessibilityLabel="Notes"
            maxLength={50_000}
            multiline
            onChangeText={setNotes}
            placeholder="What matters to them, how you met, what is happening lately..."
            placeholderTextColor={palette.faint}
            style={[styles.input, styles.textarea]}
            textAlignVertical="top"
            value={notes}
          />
        </Field>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Ideal rhythm</Text>
          <Text style={styles.helper}>How often would staying in touch feel natural?</Text>
          <View style={styles.frequencyRow}>
            {CONTACT_FREQUENCY_OPTIONS.map((option) => {
              const selected = frequency === option.days;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  key={option.days}
                  onPress={() => setFrequency(option.days)}
                  style={({ pressed }) => [
                    styles.frequency,
                    selected && styles.frequencySelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.frequencyText, selected && styles.frequencyTextSelected]}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.actions}>
          <ActionButton label={saving ? 'Adding...' : 'Add to Everclose'} disabled={saving} onPress={() => void saveContact()} />
          <ActionButton label="Cancel" variant="secondary" disabled={saving} onPress={() => router.back()} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({
  label,
  required = false,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{label}{required ? ' *' : ''}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.canvas },
  content: { padding: 22, paddingBottom: 44, gap: 20 },
  intro: { gap: 7, marginBottom: 4 },
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 32, lineHeight: 37, fontWeight: '700', letterSpacing: -0.6 },
  subtitle: { color: palette.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 21 },
  fieldGroup: { gap: 8 },
  label: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 13, fontWeight: '700' },
  helper: { color: palette.muted, fontFamily: fonts.body, fontSize: 12, marginTop: -3 },
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
  textarea: { minHeight: 116, lineHeight: 21 },
  frequencyRow: { flexDirection: 'row', gap: 8 },
  frequency: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
  },
  frequencySelected: { borderColor: palette.primary, backgroundColor: palette.primarySoft },
  frequencyText: { color: palette.muted, fontFamily: fonts.bodyMedium, fontSize: 12 },
  frequencyTextSelected: { color: palette.primary, fontFamily: fonts.bodyDemi, fontWeight: '700' },
  actions: { gap: 10, marginTop: 4 },
  pressed: { opacity: 0.72 },
});
