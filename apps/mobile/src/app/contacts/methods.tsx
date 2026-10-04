import * as Crypto from 'expo-crypto';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { ActionButton, Surface } from '@/components/design-system';
import { getContactForEditing, type ContactEditBase } from '@/data/contacts';
import { updateContactMethods } from '@/data/contact-methods';
import { readContactMethods, type ContactMethod, type ContactMethodKind } from '../../../../../packages/domain/src/contact-methods';
import { fonts, palette } from '@/theme';

type Editor = { base: ContactEditBase; draft: ContactMethod[]; initial: string };
export default function ContactMethodsScreen() {
  const db = useSQLiteContext(), router = useRouter(), navigation = useNavigation(), params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const [editor, setEditor] = useState<Editor | null>(null), [error, setError] = useState(''), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const dirty = Boolean(editor && JSON.stringify(editor.draft) !== editor.initial);
  usePreventRemove((dirty || saving) && !saved, ({ data }) => saving ? Alert.alert('Saving your changes', 'Please wait until saving finishes.')
    : Alert.alert('Discard these changes?', 'Your unsaved contact methods will be removed.', [{ text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(data.action) }]));
  useEffect(() => { if (saved) router.back(); }, [saved, router]);
  useEffect(() => {
    let active = true;
    void getContactForEditing(db, id).then((base) => {
      if (!base) throw new Error('This person is no longer available.');
      const draft = readContactMethods(base.contact_methods);
      if (active) setEditor({ base, draft, initial: JSON.stringify(draft) });
    }).catch((error) => { if (active) setError(error instanceof Error ? error.message : 'Unable to open these methods.'); });
    return () => { active = false; };
  }, [db, id]);
  function update(methodId: string, fields: Partial<ContactMethod>) { setEditor((current) => current ? { ...current, draft: current.draft.map((method) => ({ ...method,
    ...(method.id === methodId ? fields : fields.preferred && current.draft.find((item) => item.id === methodId)?.kind === method.kind ? { preferred: false } : {}) })) } : null); }
  function add(kind: ContactMethodKind) { setEditor((current) => current ? { ...current, draft: [...current.draft, { id: Crypto.randomUUID(), kind, value: '', label: null, country: null,
    preferred: !current.draft.some((item) => item.kind === kind && item.preferred), source: 'manual', source_value: null, user_override: true }] } : null); }
  async function save() {
    if (!editor) return; setSaving(true); setError('');
    try { await updateContactMethods(db, editor.base, editor.draft); setSaved(true); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to save. Your draft is still here.'); }
    finally { setSaving(false); }
  }
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={96}>
    <Stack.Screen options={{ title: 'Contact methods' }} />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{editor?.base.name ?? 'Contact methods'}</Text>
      <Text style={styles.body}>Keep personal and work addresses, numbers and profiles together. Save on this phone and sync when connected.</Text>
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      {!editor && !error && <ActivityIndicator color={palette.primary} />}
      {editor?.draft.map((method) => <Surface key={method.id} style={styles.card}>
        <Text style={styles.label}>{method.kind === 'profile' ? 'Profile link' : method.kind === 'phone' ? 'Phone number' : 'Email address'}</Text>
        <TextInput accessibilityLabel={`${method.label ?? method.kind} value`} value={method.value} onChangeText={(value) => update(method.id, { value })}
          editable={!saving} autoCapitalize="none" keyboardType={method.kind === 'email' ? 'email-address' : method.kind === 'phone' ? 'phone-pad' : 'url'}
          maxLength={method.kind === 'profile' ? 2048 : method.kind === 'email' ? 320 : 100} style={styles.input} />
        <Text style={styles.label}>Label</Text><TextInput accessibilityLabel={`${method.kind} label`} value={method.label ?? ''} placeholder="Personal, work…" editable={!saving}
          maxLength={80} onChangeText={(label) => update(method.id, { label })} style={styles.input} />
        {method.kind === 'phone' && <><Text style={styles.label}>Country code, if known</Text><TextInput accessibilityLabel="Phone country code" value={method.country ?? ''} placeholder="PT"
          maxLength={2} autoCapitalize="characters" editable={!saving} onChangeText={(country) => update(method.id, { country })} style={styles.input} />
          <Text style={styles.body}>International numbers starting with + are easier to match. Local numbers keep their country context.</Text></>}
        <View style={styles.preference}><Text style={styles.label}>Preferred {method.kind}</Text><Switch accessibilityLabel={`Preferred ${method.label ?? method.kind}`} disabled={saving}
          value={method.preferred} onValueChange={(preferred) => update(method.id, { preferred })} /></View>
        <Text style={styles.body}>{method.source === 'legacy' ? 'From existing data' : 'User supplied'}{method.source === 'legacy' && (method.user_override || method.value !== JSON.parse(editor.initial).find((item: ContactMethod) => item.id === method.id)?.value) ? ' · value edited' : ''}</Text>
        {method.source_value !== null && <Text style={styles.body}>Original value: {method.source_value}</Text>}
        <ActionButton label="Remove this method" disabled={saving} variant="secondary" onPress={() => setEditor({ ...editor, draft: editor.draft.filter((item) => item.id !== method.id) })} />
      </Surface>)}
      {editor && <><View style={styles.additions}>{(['email', 'phone', 'profile'] as const).map((kind) => <ActionButton key={kind} label={`Add ${kind}`} variant="secondary" disabled={saving} onPress={() => add(kind)} />)}</View>
        <ActionButton label={saving ? 'Saving…' : 'Save methods'} disabled={saving || !dirty} onPress={() => { void save(); }} /></>}
      <ActionButton label="Cancel" variant="secondary" disabled={saving} onPress={() => router.back()} />
    </ScrollView>
  </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({
  content: { padding: 24, paddingBottom: 44, gap: 20 }, card: { padding: 18, gap: 12 }, additions: { gap: 10 }, preference: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  title: { fontFamily: fonts.display, fontSize: 28, color: palette.ink }, label: { fontFamily: fonts.bodyDemi, fontSize: 15, color: palette.ink },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22, color: palette.muted }, error: { fontFamily: fonts.body, fontSize: 15, color: palette.primary },
  input: { backgroundColor: palette.surface, borderColor: palette.line, borderWidth: 1, borderRadius: 12, padding: 14, minHeight: 48, fontFamily: fonts.body, fontSize: 16, color: palette.ink },
});
