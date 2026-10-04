import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ActionButton } from '@/components/design-system';
import { getContactForEditing, updateContact, type ContactEditBase } from '@/data/contacts';
import { type ContactDraft } from '@/domain/contact';
import { fonts, palette } from '@/theme';

type Editor = { base: ContactEditBase; draft: ContactDraft; frequency: string };
export default function EditContactScreen() {
  const db = useSQLiteContext(), router = useRouter(), params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const [editor, setEditor] = useState<Editor | null>(null), [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void getContactForEditing(db, id).then((base) => {
      if (!active) return;
      if (!base) { setError('This person is no longer available.'); return; }
      setEditor({ base, frequency: String(base.contact_frequency), draft: { name: base.name, email: base.email ?? '', phone: base.phone ?? '', notes: base.notes ?? '', contactFrequency: base.contact_frequency } });
    }, () => { if (active) setError('Unable to open this person. Try again.'); });
    return () => { active = false; };
  }, [db, id]);
  function change(field: keyof ContactDraft, value: string | number) {
    setEditor((current) => current ? { ...current, draft: { ...current.draft, [field]: value } } : null);
  }
  async function save() {
    if (!editor || editor.base.id !== id) return;
    setSaving(true); setError('');
    try { await updateContact(db, editor.base, { ...editor.draft, contactFrequency: Number(editor.frequency) }); router.back(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to save. Your form is still here.'); }
    finally { setSaving(false); }
  }
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={96}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Edit contact details</Text>
      <Text style={styles.body}>Save on this phone, then sync when connected. Changes to the same field on another device may need review.</Text>
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      {!editor || editor.base.id !== id ? <ActivityIndicator color={palette.primary} /> : <>
        {(['name', 'email', 'phone', 'notes'] as const).map((field) => <View key={field} style={styles.field}>
          <Text style={styles.label}>{field === 'notes' ? 'Notes' : field.charAt(0).toUpperCase() + field.slice(1)}</Text>
          <TextInput accessibilityLabel={field} value={String(editor.draft[field] ?? '')} onChangeText={(value) => change(field, value)}
            editable={!saving} multiline={field === 'notes'} autoCapitalize={field === 'email' ? 'none' : 'sentences'}
            keyboardType={field === 'email' ? 'email-address' : field === 'phone' ? 'phone-pad' : 'default'}
            maxLength={field === 'name' ? 200 : field === 'email' ? 320 : field === 'phone' ? 100 : 50_000}
            style={[styles.input, field === 'notes' && { minHeight: 130, textAlignVertical: 'top' }]} />
        </View>)}
        <View style={styles.field}><Text style={styles.label}>Days between check-ins</Text>
          <TextInput accessibilityLabel="Days between check-ins" keyboardType="number-pad" maxLength={4} editable={!saving}
            value={editor.frequency} onChangeText={(frequency) => setEditor((current) => current ? { ...current, frequency } : null)} style={styles.input} />
        </View>
        <ActionButton label={saving ? 'Saving…' : 'Save details'} disabled={saving} onPress={() => { void save(); }} />
      </>}
      <ActionButton label="Cancel" variant="secondary" disabled={saving} onPress={() => router.back()} />
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
