import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ActionButton } from '@/components/design-system';
import { getContactForEditing, updateContact } from '@/data/contacts';
import { contactDraftKey, contactForm } from '@/data/contact-drafts';
import { useContactForm } from '@/native/contact-form';
import { fonts, palette } from '@/theme';

export default function EditContactScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  return <ContactEditor key={id} id={id} />;
}

function ContactEditor({ id }: { id: string }) {
  const db = useSQLiteContext(), router = useRouter();
  const key = contactDraftKey(id || 'unavailable');
  const initial = useCallback(async () => {
    const base = await getContactForEditing(db, id);
    if (!base || base.id !== id) throw new Error('This person is no longer available. Open the current person from People.');
    return contactForm(base);
  }, [db, id]);
  const form = useContactForm(db, key, initial), editor = form.draft, { saving, error } = form;
  async function save() {
    const result = await form.save(async ({ base, fields }) => {
      if (!base || base.id !== id) throw new Error('Reopen this person from People. Your draft is still here.');
      await updateContact(db, base, { name: fields.name, email: fields.email, phone: fields.phone,
        notes: fields.notes, contactFrequency: Number(fields.frequency) }, key);
      return true;
    });
    if (result) router.back();
  }
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={96}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Edit contact details</Text>
      <Text style={styles.body}>Save on this phone, then sync when connected. Changes to the same field on another device may need review.</Text>
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      {!editor || editor.base?.id !== id ? error ? <ActionButton label="Try again" onPress={form.retry} /> : <ActivityIndicator color={palette.primary} accessibilityLabel="Opening your form" /> : <>
        {form.resumed && <Text style={styles.body}>Resumed your saved draft. Its original version is kept so cloud changes can be reviewed.</Text>}
        {(['name', 'email', 'phone', 'notes'] as const).map((field) => <View key={field} style={styles.field}>
          <Text style={styles.label}>{field === 'notes' ? 'Notes' : field.charAt(0).toUpperCase() + field.slice(1)}</Text>
          <TextInput accessibilityLabel={field} value={editor.fields[field]} onChangeText={(value) => form.change({ [field]: value })}
            editable={!saving} multiline={field === 'notes'} autoCapitalize={field === 'email' ? 'none' : 'sentences'}
            keyboardType={field === 'email' ? 'email-address' : field === 'phone' ? 'phone-pad' : 'default'}
            maxLength={field === 'name' ? 200 : field === 'email' ? 320 : field === 'phone' ? 100 : 50_000}
            style={[styles.input, field === 'notes' && { minHeight: 130, textAlignVertical: 'top' }]} />
        </View>)}
        <View style={styles.field}><Text style={styles.label}>Days between check-ins</Text>
          <TextInput accessibilityLabel="Days between check-ins" keyboardType="number-pad" maxLength={4} editable={!saving}
            value={editor.fields.frequency} onChangeText={(frequency) => form.change({ frequency })} style={styles.input} />
        </View>
        <ActionButton label={saving ? 'Saving…' : 'Save details'} disabled={saving} onPress={() => { void save(); }} />
        {!!error && <ActionButton label="Retry keeping draft" variant="secondary" disabled={saving} onPress={() => form.change({})} />}
        <Text style={styles.body}>Closing keeps your draft on this phone. Drafts are uploaded only when you save.</Text>
        <ActionButton label="Discard draft" variant="quiet" disabled={saving} onPress={() => Alert.alert('Discard this draft?', 'Remove the unfinished form. Saved contact details stay as they are.', [
          { text: 'Keep draft', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void form.discard().then((done) => { if (done) router.back(); }); } },
        ])} />
      </>}
      {!editor && !!error && <ActionButton label="Discard saved form" variant="quiet" disabled={saving} onPress={() => Alert.alert('Discard the saved form?', 'Remove the unfinished form. Saved contact details stay as they are.', [
        { text: 'Keep form', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void form.discard().then((done) => { if (done) router.back(); }); } },
      ])} />}
      <ActionButton label={editor ? 'Close and keep draft' : 'Close'} variant="secondary" disabled={saving} onPress={() => { void form.close().then((done) => { if (done) router.back(); }); }} />
    </ScrollView>
  </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({
  content: { padding: 24, paddingBottom: 44, gap: 18 }, field: { gap: 8 },
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 28 },
  body: { color: palette.muted, fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
  label: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 14 },
  error: { color: palette.primary, fontFamily: fonts.body, fontSize: 15 },
  input: { color: palette.ink, backgroundColor: palette.surface, fontFamily: fonts.body, fontSize: 15,
    minHeight: 51, borderWidth: 1, borderColor: palette.line, borderRadius: 16, padding: 14 },
});
