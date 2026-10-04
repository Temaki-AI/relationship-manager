import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ActionButton } from '@/components/design-system';
import { PersonPicker } from '@/components/person-picker';
import { contextForEditing, createContext, updateContext, type ContextRecord } from '@/data/context';
import { type ContextEntity } from '../../../../../packages/domain/src/relationship-context';
import { fonts, palette } from '@/theme';

type Editor = { base: ContextRecord | null; draft: Record<string, unknown>; initial: string; owner: string; contactId: string };
export default function ContextEditorScreen() {
  const db = useSQLiteContext(), router = useRouter(), navigation = useNavigation();
  const params = useLocalSearchParams<{ entity: string; contactId: string; id?: string }>();
  const entity: ContextEntity | null = ['plan', 'family', 'relationship'].includes(String(params.entity)) ? params.entity as ContextEntity : null;
  const id = typeof params.id === 'string' ? params.id : '', contactId = typeof params.contactId === 'string' ? params.contactId : '';
  const [editor, setEditor] = useState<Editor | null>(null), [error, setError] = useState(''), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const dirty = Boolean(editor && JSON.stringify([editor.contactId, editor.draft]) !== editor.initial);
  usePreventRemove((dirty || saving) && !saved, ({ data }) => saving ? Alert.alert('Saving your changes', 'Please wait for saving to finish.') : Alert.alert('Discard these changes?', 'Your unsaved form will be removed.', [
    { text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(data.action) },
  ]));
  useEffect(() => { if (saved) router.back(); }, [saved, router]);
  useEffect(() => {
    let active = true;
    void (async () => {
      if (!entity) throw new Error('Choose an available record type.');
      const base = id ? await contextForEditing(db, entity, id) : null;
      if (id && !base) throw new Error('This item is no longer available.');
      const ownerId = base?.contact_id ?? contactId;
      const owner = ownerId ? await db.getFirstAsync<{ name: string }>('SELECT name FROM contacts WHERE id = ? AND deleted_at IS NULL', ownerId) : null;
      if (ownerId && !owner) throw new Error('This person is no longer available.');
      const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const draft = entity === 'plan' ? { type: base?.type ?? 'meetup', planned_date: base?.planned_date ?? today, summary: base?.summary ?? '', notes: base?.notes ?? '' }
        : entity === 'family' ? { name: base?.name ?? '', birthday: base?.birthday ?? '', linked_contact_id: base?.linked_contact_id ?? null }
          : { related_contact_id: base?.related_contact_id ?? null, relationship_label: base?.relationship_label ?? '', reciprocal_label: base?.reciprocal_label ?? '' };
      if (active) setEditor({ base, draft, initial: JSON.stringify([ownerId, draft]), owner: owner?.name ?? 'Selected person', contactId: ownerId });
    })().catch((error) => { if (active) setError(error instanceof Error ? error.message : 'Unable to open this form.'); });
    return () => { active = false; };
  }, [db, entity, id, contactId]);
  function change(field: string, value: unknown) { setEditor((current) => current ? { ...current, draft: { ...current.draft, [field]: value } } : null); }
  async function save() {
    if (!editor || !entity || saving) return; setSaving(true); setError('');
    try {
      if (editor.base) await updateContext(db, entity, editor.base, editor.draft);
      else await createContext(db, entity, editor.contactId, editor.draft);
      setSaved(true);
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save. Your form is still here.'); }
    finally { setSaving(false); }
  }
  const title = entity === 'plan' ? 'Plan' : entity === 'family' ? 'Family entry' : 'Relationship';
  function field(key: string, label: string, limit: number, multiline = false, placeholder?: string) {
    return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} maxLength={limit}
      placeholder={placeholder} value={String(editor?.draft[key] ?? '')} onChangeText={(value) => change(key, value)} editable={!saving}
      multiline={multiline} style={[styles.input, multiline && { minHeight: 110, textAlignVertical: 'top' }]} /></View>;
  }
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={96}>
    <Stack.Screen options={{ title: `${id ? 'Edit' : 'New'} ${title.toLowerCase()}` }} />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{title}{editor?.contactId ? ` · ${editor.owner}` : ''}</Text>
      {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
      {!editor ? !error && <ActivityIndicator color={palette.primary} /> : <>
        {!contactId && !editor.base && <PersonPicker value={editor.contactId || null} onChange={(selected) => {
          setEditor((current) => current ? { ...current, contactId: selected ?? '', owner: 'Selected person' } : null);
          if (selected) void db.getFirstAsync<{ name: string }>('SELECT name FROM contacts WHERE id = ?', selected).then((person) => {
            setEditor((current) => current?.contactId === selected ? { ...current, owner: person?.name ?? 'Selected person' } : current);
          }).catch(() => { /* The picker still shows the selected person's name. */ });
        }} disabled={saving} />}
        {entity === 'plan' && <>
          <View style={styles.types}>{(['call', 'message', 'meetup', 'email'] as const).map((type) => <ActionButton label={`${editor.draft.type === type ? '✓ ' : ''}${type}`}
            variant="secondary" key={type} disabled={saving} onPress={() => change('type', type)} />)}</View>
          {field('planned_date', 'Planned date', 10, false, 'YYYY-MM-DD')}{field('summary', 'Summary', 500)}{field('notes', 'Notes', 10_000, true)}
        </>}
        {entity === 'family' && <>{field('name', 'Child name', 200)}{field('birthday', 'Birthday', 10, false, 'YYYY-MM-DD')}
          <PersonPicker label="Linked profile (optional)" value={editor.draft.linked_contact_id as string | null} optional excludeId={editor.contactId}
            disabled={saving} onChange={(selected) => change('linked_contact_id', selected)} />
        </>}
        {entity === 'relationship' && <>
          <PersonPicker label="Related person" value={editor.draft.related_contact_id as string | null} excludeId={editor.contactId}
            disabled={saving || Boolean(editor.base)} onChange={(selected) => change('related_contact_id', selected)} />
          {field('relationship_label', `Label on ${editor.owner}'s profile`, 80)}{field('reciprocal_label', 'Label on their profile', 80)}
        </>}
        <ActionButton label={saving ? 'Saving…' : 'Save'} disabled={saving || !editor.contactId} onPress={() => { void save(); }} />
      </>}
      <ActionButton label="Cancel" variant="secondary" disabled={saving} onPress={() => router.back()} />
    </ScrollView>
  </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({
  content: { padding: 24, paddingBottom: 44, gap: 18 }, field: { gap: 8 }, types: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 27 }, label: { fontFamily: fonts.bodyDemi, fontSize: 14, color: palette.ink },
  error: { color: palette.primary, fontFamily: fonts.body, fontSize: 15 },
  input: { minHeight: 51, padding: 14, borderWidth: 1, borderColor: palette.line, borderRadius: 14, backgroundColor: palette.surface, color: palette.ink, fontFamily: fonts.body, fontSize: 15 },
});
