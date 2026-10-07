import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback } from 'react';
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

import { ActionButton } from '@/components/design-system';
import { createContact } from '@/data/contacts';
import { contactDraftKey, contactForm } from '@/data/contact-drafts';
import { CONTACT_FREQUENCY_OPTIONS } from '@/domain/contact';
import { useContactForm } from '@/native/contact-form';
import { fonts, palette } from '@/theme';

export default function NewContactScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const key = contactDraftKey();
  const initial = useCallback(async () => contactForm(), []);
  const form = useContactForm(db, key, initial);
  const { name, email, phone, notes, frequency } = form.draft?.fields ?? contactForm().fields;
  const saving = form.saving;

  async function saveContact() {
    const contact = await form.save(({ fields }) => createContact(db, {
      name: fields.name, email: fields.email, phone: fields.phone, notes: fields.notes,
      contactFrequency: Number(fields.frequency),
    }, key));
    if (contact) router.replace({ pathname: '/contacts/[id]', params: { id: contact.id } });
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
          <Text accessibilityRole="header" style={styles.title}>Add a person</Text>
          <Text style={styles.subtitle}>Start with a name. Everything else is optional.</Text>
        </View>

        {!!form.error && <Text accessibilityRole="alert" style={styles.subtitle}>{form.error}</Text>}
        {!form.draft ? <>
          {!form.error ? <ActivityIndicator color={palette.primary} accessibilityLabel="Opening your form" /> : <ActionButton label="Try again" onPress={form.retry} />}
          {!!form.error && <ActionButton label="Discard saved form" variant="quiet" disabled={saving} onPress={() => Alert.alert('Discard the saved form?', 'Remove this unfinished form from this phone.', [
            { text: 'Keep form', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void form.discard().then((done) => { if (done) router.back(); }); } },
          ])} />}
          <ActionButton label="Close" variant="secondary" disabled={saving} onPress={() => { void form.close().then((done) => { if (done) router.back(); }); }} />
        </> : <>
        {form.resumed && <Text style={styles.helper}>Resumed your saved draft.</Text>}

        <Field label="Name" required>
          <TextInput
            accessibilityLabel="Name"
            autoCapitalize="words"
            autoComplete="name"
            autoFocus
            maxLength={200}
            editable={!saving}
            onChangeText={(name) => form.change({ name })}
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
            editable={!saving}
            onChangeText={(email) => form.change({ email })}
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
            editable={!saving}
            onChangeText={(phone) => form.change({ phone })}
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
            editable={!saving}
            onChangeText={(notes) => form.change({ notes })}
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
              const selected = Number(frequency) === option.days;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: saving }}
                  key={option.days}
                  disabled={saving}
                  onPress={() => form.change({ frequency: String(option.days) })}
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
          <Text style={styles.helper}>Closing keeps your draft on this phone. It is uploaded only after you add the person.</Text>
          {!!form.error && <ActionButton label="Retry keeping draft" variant="secondary" disabled={saving} onPress={() => form.change({})} />}
          <ActionButton label="Close and keep draft" variant="secondary" disabled={saving} onPress={() => { void form.close().then((done) => { if (done) router.back(); }); }} />
          <ActionButton label="Discard draft" variant="quiet" disabled={saving} onPress={() => Alert.alert('Discard this draft?', 'Remove this unfinished form from this phone.', [
            { text: 'Keep draft', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void form.discard().then((done) => { if (done) router.back(); }); } },
          ])} />
        </View>
        </>}
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
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 28, lineHeight: 35, fontWeight: '700', letterSpacing: -0.6 },
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
