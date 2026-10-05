import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ActionButton } from '@/components/design-system';
import { PersonPicker } from '@/components/person-picker';
import { contextForEditing, createContext, updateContext } from '@/data/context';
import { getContact } from '@/data/contacts';
import { contextForm, journalDraftKey } from '@/data/journal-drafts';
import { useJournalForm } from '@/native/journal-form';
import { type ContextEntity } from '../../../../../packages/domain/src/relationship-context';
import { fonts, palette } from '@/theme';

export default function ContextEditorScreen() {
  const params = useLocalSearchParams<{ entity: string; contactId: string; id?: string }>();
  const entity: ContextEntity | null = ['plan', 'family', 'relationship'].includes(String(params.entity)) ? params.entity as ContextEntity : null;
  const id = typeof params.id === 'string' ? params.id : '', contactId = typeof params.contactId === 'string' ? params.contactId : '';
  let key = '';
  try { if (entity) key = journalDraftKey(entity, contactId, id); } catch { /* Invalid deep links cannot open another person's form. */ }
  return key && entity ? <ContextEditor key={key} draftKey={key} entity={entity} contactId={contactId} id={id} />
    : <View style={styles.content}><Text accessibilityRole="alert" style={styles.error}>Choose an available form from People or Agenda.</Text></View>;
}

function ContextEditor({ draftKey, entity, id, contactId }: { draftKey: string; entity: ContextEntity; id: string; contactId: string }) {
  const db = useSQLiteContext(), router = useRouter(), navigation = useNavigation();
  const initial = useCallback(async () => {
    const base = id ? await contextForEditing(db, entity, id) : null;
    if (id && !base) throw new Error('This item is no longer available.');
    const ownerId = base?.contact_id ?? contactId;
    if (ownerId && !await getContact(db, ownerId)) throw new Error('This person is no longer available.');
    return contextForm(entity, ownerId, base);
  }, [db, entity, id, contactId]);
  const form = useJournalForm(db, draftKey, initial), editor = form.draft, { error, saving } = form;
  const [owner, setOwner] = useState<{ id: string; name: string } | null>(null);
  const ownerId = editor?.contactId ?? '', ownerName = owner?.id === ownerId ? owner.name : 'Selected person';
  const [exitAction, setExitAction] = useState<(() => void) | null>(null);
  function close(action: () => void) { void form.close().then((done) => { if (done) setExitAction(() => action); }); }
  usePreventRemove((!!editor || saving) && !exitAction, ({ data }) => saving
    ? Alert.alert('Saving your changes', 'Please wait for saving to finish.') : close(() => navigation.dispatch(data.action)));
  useEffect(() => { exitAction?.(); }, [exitAction]);
  useEffect(() => {
    let active = true;
    if (ownerId) void getContact(db, ownerId).then((person) => {
      if (active) setOwner({ id: ownerId, name: person?.name ?? 'Unavailable person' });
    }).catch(() => { /* Saved fields remain available if the display-name read fails. */ });
    return () => { active = false; };
  }, [db, ownerId]);
  function change(field: string, value: string | null) { form.change((current) => ({ ...current, fields: { ...current.fields, [field]: value } })); }
  async function save() {
    const result = await form.save(async (current) => {
      if (current.base) await updateContext(db, entity, current.base, current.fields, draftKey);
      else await createContext(db, entity, current.contactId, current.fields, draftKey);
      return true;
    });
    if (result) setExitAction(() => () => router.back());
  }
  const title = entity === 'plan' ? 'Plan' : entity === 'family' ? 'Family entry' : 'Relationship';
  function field(key: string, label: string, limit: number, multiline = false, placeholder?: string) {
    return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} maxLength={limit}
      placeholder={placeholder} value={String(editor?.fields[key] ?? '')} onChangeText={(value) => change(key, value)} editable={!saving}
      multiline={multiline} style={[styles.input, multiline && { minHeight: 110, textAlignVertical: 'top' }]} /></View>;
  }
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={96}>
    <Stack.Screen options={{ title: `${id ? 'Edit' : 'New'} ${title.toLowerCase()}` }} />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{title}{editor?.contactId ? ` · ${ownerName}` : ''}</Text>
      {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
      {!editor ? error ? <ActionButton label="Try again" onPress={form.retry} /> : <ActivityIndicator color={palette.primary} /> : <>
        {form.resumed && <Text style={styles.body}>Resumed your saved draft. Its original edit version is retained for conflict review.</Text>}
        {!contactId && !editor.base && <PersonPicker value={editor.contactId || null} onChange={(selected) => {
          form.change((current) => ({ ...current, contactId: selected ?? '' }));
        }} disabled={saving} />}
        {entity === 'plan' && <>
          <View style={styles.types}>{(['call', 'message', 'meetup', 'email'] as const).map((type) => <ActionButton label={`${editor.fields.type === type ? '✓ ' : ''}${type}`}
            variant="secondary" key={type} disabled={saving} onPress={() => change('type', type)} />)}</View>
          {field('planned_date', 'Planned date', 10, false, 'YYYY-MM-DD')}{field('summary', 'Summary', 500)}{field('notes', 'Notes', 10_000, true)}
        </>}
        {entity === 'family' && <>{field('name', 'Child name', 200)}{field('birthday', 'Birthday', 10, false, 'YYYY-MM-DD')}
          <PersonPicker label="Linked profile (optional)" value={editor.fields.linked_contact_id} optional excludeId={editor.contactId}
            disabled={saving} onChange={(selected) => change('linked_contact_id', selected)} />
        </>}
        {entity === 'relationship' && <>
          <PersonPicker label="Related person" value={editor.fields.related_contact_id} excludeId={editor.contactId}
            disabled={saving || Boolean(editor.base)} onChange={(selected) => change('related_contact_id', selected)} />
          {field('relationship_label', `Label on ${ownerName}'s profile`, 80)}{field('reciprocal_label', 'Label on their profile', 80)}
        </>}
        <ActionButton label={saving ? 'Saving…' : 'Save'} disabled={saving || !editor.contactId} onPress={() => { void save(); }} />
      </>}
      {!!editor && !!error && <ActionButton label="Retry keeping draft" disabled={saving} variant="secondary" onPress={() => form.change((current) => current)} />}
      <Text style={styles.body}>Closing keeps this unfinished form on this phone. It syncs only after Save.</Text>
      <ActionButton label="Close and keep draft" variant="secondary" disabled={saving} onPress={() => close(() => router.back())} />
      {!!editor || !!error ? <ActionButton label="Discard draft" variant="quiet" disabled={saving} onPress={() => Alert.alert('Discard this draft?', 'Remove this unfinished form. Saved relationship details stay as they are.', [
        { text: 'Keep draft', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void form.discard().then((done) => { if (done) setExitAction(() => () => router.back()); }); } },
      ])} /> : null}
    </ScrollView>
  </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({
  content: { padding: 24, paddingBottom: 44, gap: 18 }, field: { gap: 8 }, types: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 27 }, label: { fontFamily: fonts.bodyDemi, fontSize: 14, color: palette.ink },
  error: { color: palette.primary, fontFamily: fonts.body, fontSize: 15 },
  body: { color: palette.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 21 },
  input: { minHeight: 51, padding: 14, borderWidth: 1, borderColor: palette.line, borderRadius: 14, backgroundColor: palette.surface, color: palette.ink, fontFamily: fonts.body, fontSize: 15 },
});
