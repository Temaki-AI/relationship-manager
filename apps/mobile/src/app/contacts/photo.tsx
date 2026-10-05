import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text } from 'react-native';
import { ActionButton, Avatar, Surface } from '@/components/design-system';
import { getContact } from '@/data/contacts';
import { cachedContactPhoto, loadContactPhoto } from '@/data/contact-photos';
import { discardContactPhotoDraft, discardQueuedContactPhoto, openContactPhoto, queueContactPhoto, saveContactPhotoDraft, type PhotoOpening, type PhotoQueue } from '@/data/contact-photo-outbox';
import { useNativeAccount } from '@/native/account';
import { useNativeSync } from '@/native/sync';
import { chooseContactPhoto } from '@/native/photo-picker';
import { accountScope, type NativeAccount } from '../../../../../packages/domain/src/devices';
import { fonts, palette } from '@/theme';

export default function ContactPhotoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>(), { account } = useNativeAccount();
  if (!account) return <ScrollView contentContainerStyle={styles.content}><Text style={styles.body}>Sign in to save contact photos in your Everclose account.</Text></ScrollView>;
  return <PhotoEditor key={`${accountScope(account)}:${id}`} id={id} account={account} />;
}
function PhotoEditor({ id, account }: { id: string; account: NativeAccount }) {
  const db = useSQLiteContext(), router = useRouter(), sync = useNativeSync(), scope = accountScope(account);
  const active = useRef(true), running = useRef(false);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, [db, scope]);
  const [name, setName] = useState('Contact photo'), [opening, setOpening] = useState<PhotoOpening | null>(null);
  const [current, setCurrent] = useState<string | null>(null), [selection, setSelection] = useState<string | null>(null);
  const [queue, setQueue] = useState<PhotoQueue | null>(null), [hasDraft, setHasDraft] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const isCurrent = () => active.current;
  async function read(reviewCurrent = false) {
    const person = await getContact(db, id);
    if (!isCurrent()) return;
    if (person) setName(person.name);
    let photo = await cachedContactPhoto(db, id, scope);
    try { photo = await loadContactPhoto(db, account, id, { isCurrent }); }
    catch (error) { if (isCurrent()) setNotice(error instanceof Error ? error.message : 'Unable to download the current photo.'); }
    const state = await openContactPhoto(db, id, scope, reviewCurrent);
    if (!isCurrent()) return;
    setCurrent(photo); setOpening(state.opening); setQueue(state.queue);
    if (!reviewCurrent) { setHasDraft(!!state.draft); setSelection(state.draft ? state.draft.photo : state.queue ? state.queue.photo : photo); }
    else if (hasDraft || queue) {
      await saveContactPhotoDraft(db, state.opening, selection, isCurrent);
      if (isCurrent()) setHasDraft(true);
    }
    if (!person) setNotice('This person was removed. Your saved photo stays available for review.');
    else if (person.id !== id) setNotice('This person was merged. The photo draft remains attached to its original identity.');
  }
  useEffect(() => {
    void Promise.resolve().then(() => read()).catch((error) => { if (isCurrent()) setError(error instanceof Error ? error.message : 'Unable to open the saved photo.'); });
    // Open once per account/person. A sync never silently changes the form’s opening photo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, id, scope]);
  async function perform(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (error) { if (isCurrent()) setError(error instanceof Error ? error.message : 'Your photo is preserved. Try again.'); }
    finally { running.current = false; if (isCurrent()) setBusy(false); }
  }
  async function select(photo: string | null) {
    if (!opening || !isCurrent()) return;
    await saveContactPhotoDraft(db, opening, photo, isCurrent);
    if (isCurrent()) { setSelection(photo); setHasDraft(true); }
  }
  const unconfirmed = !!queue?.request_json && queue.status === 'pending';
  return <ScrollView contentContainerStyle={styles.content}>
    <Stack.Screen options={{ title: 'Contact photo' }} />
    <Text style={styles.title}>{name}</Text>
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!!notice && <Text style={styles.body}>{notice}</Text>}
    <Surface style={styles.card}><Text style={styles.body}>Current cloud photo</Text><Avatar name={name} photo={current} size={112} /></Surface>
    <Surface style={styles.card}><Text style={styles.body}>{hasDraft ? 'Your unfinished selection' : queue ? 'Photo saved on this phone' : 'Selected photo'}</Text>
      <Avatar name={name} photo={selection} size={160} />
      <Text style={styles.body}>Choose a photo, then save it. Everclose crops it to a square and saves a small copy. Your original stays in Photos.</Text>
    </Surface>
    {queue && <Text style={styles.body}>{queue.status === 'conflict' ? 'The photo or account data changed. Your phone photo is held for review.'
      : unconfirmed ? 'The previous upload is unconfirmed. Retry it unchanged before replacing or discarding it.' : 'Saved on this phone. It will upload when you are online.'}</Text>}
    <ActionButton label="Choose from Photos" disabled={busy || !opening || unconfirmed} onPress={() => { void perform(async () => { const photo = await chooseContactPhoto(isCurrent); if (photo !== null) await select(photo); }); }} />
    <ActionButton label="Remove photo" variant="quiet" disabled={busy || !opening || unconfirmed || selection === null} onPress={() => { void perform(() => select(null)); }} />
    <ActionButton label="Save photo" disabled={busy || !opening || !hasDraft || unconfirmed} onPress={() => { void perform(async () => {
      await queueContactPhoto(db, opening!, selection, isCurrent); if (isCurrent()) router.back();
    }); }} />
    <ActionButton label="Review latest cloud photo" variant="secondary" disabled={busy || unconfirmed} onPress={() => { void perform(async () => {
      await sync.run(); if (!isCurrent()) return;
      await read(true);
      setNotice('The current cloud photo is shown above. Review it before saving your selection.');
    }); }} />
    {queue && <ActionButton label="Retry sync" variant="secondary" disabled={busy || sync.syncing} onPress={() => { void perform(async () => { await sync.run(); await read(); }); }} />}
    {hasDraft || error ? <ActionButton label="Discard unfinished selection" variant="quiet" disabled={busy} onPress={() => Alert.alert('Discard this selection?', 'Only the unfinished photo selection is removed. Saved and queued photos remain.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Discard selection', style: 'destructive', onPress: () => { void perform(async () => { await discardContactPhotoDraft(db, id, scope, isCurrent); await read(); }); } },
    ])} /> : null}
    {queue && !unconfirmed && <ActionButton label="Discard queued photo change" variant="quiet" disabled={busy || sync.syncing} onPress={() => Alert.alert('Discard the queued photo?', 'Keep the current cloud photo. Only this phone’s queued photo change is removed.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Discard change', style: 'destructive', onPress: () => { void perform(async () => { await discardQueuedContactPhoto(db, id, scope, queue.id, isCurrent); await read(); }); } },
    ])} />}
  </ScrollView>;
}
const styles = StyleSheet.create({ content: { padding: 24, gap: 20, paddingBottom: 60 }, card: { padding: 20, gap: 16 },
  title: { fontFamily: fonts.display, fontSize: 28, color: palette.ink }, body: { fontFamily: fonts.body, fontSize: 16, color: palette.muted, lineHeight: 24 },
  error: { fontFamily: fonts.body, fontSize: 16, color: palette.danger, lineHeight: 24 } });
