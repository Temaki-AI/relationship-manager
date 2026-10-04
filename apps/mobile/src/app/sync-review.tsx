import { describeContactMethods } from '../../../../packages/domain/src/contact-methods';
import { useIsFocused, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text } from 'react-native';
import { ActionButton, Surface } from '@/components/design-system';
import { contactSyncReviews, childSyncReviews, resolveContactSyncReview, resolveChildSyncReview, type ContactSyncReview, type ChildSyncReview } from '@/data/cloud-sync';
import { useNativeSync } from '@/native/sync';
import { deviceSourceSyncReviews, discardDeviceSourceUploads, type SourceQueueRow } from '@/data/device-source-sync';
import { calendarLinkSyncReviews, discardCalendarLinkReview, type CalendarLinkQueueRow } from '@/data/calendar-event-links';
import { useNativeAccount } from '@/native/account';
import { fonts, palette } from '@/theme';

export default function SyncReviewScreen() {
  const db = useSQLiteContext(), sync = useNativeSync();
  const { account } = useNativeAccount();
  const active = useRef<{ db: typeof db; account: typeof account } | null>(null);
  useLayoutEffect(() => { active.current = { db, account }; return () => { active.current = null; }; }, [db, account]);
  const router = useRouter();
  const focused = useIsFocused();
  const [reviews, setReviews] = useState<ContactSyncReview[]>([]), [error, setError] = useState('');
  const [childReviews, setChildReviews] = useState<ChildSyncReview[]>([]);
  const [sourceReviews, setSourceReviews] = useState<SourceQueueRow[]>([]);
  const [calendarReviews, setCalendarReviews] = useState<CalendarLinkQueueRow[]>([]);
  const [people, setPeople] = useState<Record<string, { name: string; deleted_at: string | null }>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!focused) return;
    let active = true;
    void Promise.all([contactSyncReviews(db), childSyncReviews(db), deviceSourceSyncReviews(db), calendarLinkSyncReviews(db)]).then(async ([rows, children, sources, calendar]) => {
      const ids = [...new Set(children.flatMap((review) => [review.contactId, review.local.linked_contact_id, review.local.related_contact_id,
        review.cloud?.data?.linked_contact_id, review.cloud?.data?.related_contact_id]).filter((id): id is string => typeof id === 'string'))];
      const profiles = await Promise.all(ids.map((id) => db.getFirstAsync<{ name: string; deleted_at: string | null }>('SELECT name, deleted_at FROM contacts WHERE id = ?', id).then((person) => [id, person] as const)));
      if (active) { setReviews(rows); setChildReviews(children); setSourceReviews(sources); setCalendarReviews(calendar); setPeople(Object.fromEntries(profiles.filter((entry) => entry[1] !== null)) as typeof people); }
    }).catch(() => { if (active) setError('Unable to load these offline changes.'); });
    return () => { active = false; };
  }, [focused, db, sync.revision]);
  function display(field: string, value: unknown) {
    if ((field === 'linked_contact_id' || field === 'related_contact_id') && typeof value === 'string') return people[value]?.name ?? 'Unavailable profile';
    if (field === 'contact_methods') return describeContactMethods(value);
    return String(value ?? '(empty)');
  }
  function missingReference(review: ChildSyncReview) {
    return review.reason === 'merged_self_link' || [review.contactId, review.local.linked_contact_id, review.local.related_contact_id].some((id) => typeof id === 'string' && (!people[id] || people[id].deleted_at));
  }
  function reviewCloud(review: ContactSyncReview) { return review.mergedInto ?? review.cloud; }
  async function resolve(review: ContactSyncReview, choice: 'cloud' | 'phone' | 'copy') {
    setBusy(true); setError('');
    try { await resolveContactSyncReview(db, review, choice); await sync.run(); setReviews(await contactSyncReviews(db)); setChildReviews(await childSyncReviews(db)); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to resolve this change. Your draft is still here.'); }
    finally { setBusy(false); }
  }
  async function resolveChild(review: ChildSyncReview, choice: 'cloud' | 'phone' | 'copy') {
    setBusy(true); setError('');
    try { await resolveChildSyncReview(db, review, choice); await sync.run(); setReviews(await contactSyncReviews(db)); setChildReviews(await childSyncReviews(db)); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to resolve this change. Your draft is still here.'); }
    finally { setBusy(false); }
  }
  return <ScrollView contentContainerStyle={styles.content}>
    <Text style={styles.body}>Cloud restores, removals or overlapping edits can leave a different version on this phone. Review your drafts before choosing.</Text>
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!reviews.length && !childReviews.length && !sourceReviews.length && !calendarReviews.length && <Text style={styles.body}>No offline changes need review.</Text>}
    {calendarReviews.map((review) => <Surface key={review.id} style={styles.card}>
      <Text style={styles.title}>Meeting link choices need review</Text>
      <Text style={styles.body}>{review.last_error_code === 'epoch_changed' ? 'Account data was restored. Earlier choices were held.' : 'The meeting, selected people or plan links changed. Your choices were held.'}</Text>
      <Text style={styles.body}>Review the current meeting and selected identities before saving a fresh intent. Removed meetings are not recreated. Discarding these choices leaves people, plans and private history intact.</Text>
      <ActionButton label="Review meeting link choices" variant="secondary" disabled={busy} onPress={() => router.push({ pathname: '/calendar/events/links', params: { id: review.event_id } })} />
      <ActionButton label="Discard held meeting choices" variant="quiet" disabled={busy || sync.syncing || !account} onPress={() => Alert.alert('Discard held meeting choices?', 'Only this held phone intent is removed. The saved meeting and its cloud links remain as they are.', [
        { text: 'Cancel', style: 'cancel' }, { text: 'Discard choices', style: 'destructive', onPress: () => {
          if (!account) return;
          const isCurrent = () => active.current?.db === db && active.current.account === account;
          setBusy(true); setError(''); void discardCalendarLinkReview(db, account, review.id, isCurrent).then(async () => {
            const rows = await calendarLinkSyncReviews(db); if (isCurrent()) { setCalendarReviews(rows); await sync.run(); }
          }).catch((issue) => { if (isCurrent()) setError(issue instanceof Error ? issue.message : 'Unable to discard held choices.'); }).finally(() => { if (isCurrent()) setBusy(false); });
        } },
      ])} />
    </Surface>)}
    {sourceReviews.map((review) => <Surface key={review.id} style={styles.card}>
      <Text style={styles.title}>iPhone source {review.action === 'unlink' ? 'unlink' : 'upload'} needs review</Text>
      <Text style={styles.body}>{review.last_error_code === 'epoch_changed' ? 'Your account data was restored. This earlier source operation was held.' : 'The source, person, permission or saved-source limit changed. The source operation was held.'}</Text>
      <Text style={styles.body}>Discarding source uploads leaves copied person fields and their own sync changes intact. Shared source details remain as they are. Choose the contact again to review and share a fresh observation.</Text>
      <ActionButton label="Open person" variant="secondary" disabled={busy} onPress={() => router.push({ pathname: '/contacts/[id]', params: { id: review.contact_id } })} />
      <ActionButton label="Discard source uploads for this link" variant="quiet" disabled={busy || sync.syncing} onPress={() => Alert.alert('Discard these source uploads?', 'This discards all queued source operations for this link. Copied person fields and private history stay in Everclose.', [
        { text: 'Cancel', style: 'cancel' }, { text: 'Discard source uploads', style: 'destructive', onPress: () => {
          setBusy(true); setError(''); void discardDeviceSourceUploads(db, review.source_id).then(() => sync.run()).then(async () => setSourceReviews(await deviceSourceSyncReviews(db)))
            .catch((error) => setError(error instanceof Error ? error.message : 'Unable to discard these source uploads.')).finally(() => setBusy(false));
        } },
      ])} />
    </Surface>)}
    {reviews.map((review) => <Surface key={review.contactId} style={styles.card}>
      <Text style={styles.title}>{review.name}</Text>
      <Text style={styles.body}>{review.reason === 'epoch_changed' ? 'The cloud database was restored or erased.'
        : review.mergedInto ? `This profile was merged into ${String(review.mergedInto.data?.name ?? 'another person')}. Your original phone draft is preserved.`
        : review.cloud?.deleted || !review.cloud ? 'This person is no longer in the cloud database.' : 'A contact change needs your review.'}</Text>
      {review.mergedInto && !review.mergedInto.deleted && <ActionButton label="Open combined profile" variant="secondary"
        onPress={() => router.push({ pathname: '/contacts/[id]', params: { id: review.mergedInto!.id } })} />}
      {!!review.children.length && <Text style={styles.body}>{review.children.length} pending changes are attached to this person.</Text>}
      {Object.entries(review.changes).map(([field, value]) => <Text key={field} style={styles.body}>
        {field.replace(/_/gu, ' ')}{':\n'}Phone: {display(field, value)}{'\n'}Cloud: {display(field, reviewCloud(review)?.data?.[field])}
      </Text>)}
      <ActionButton label="Use cloud version" variant="secondary" disabled={busy || sync.syncing} onPress={() => Alert.alert('Use the cloud version?',
        'Discard pending contact detail changes for this person. Other pending items remain available for separate review.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Use cloud', style: 'destructive', onPress: () => { void resolve(review, 'cloud'); } },
        ])} />
      {reviewCloud(review) && !reviewCloud(review)!.deleted && Object.keys(review.changes).length > 0 && <ActionButton label="Send these phone changes" disabled={busy || sync.syncing} onPress={() => Alert.alert('Send the phone changes?',
        'Apply the displayed phone values to the latest cloud contact. Another overlapping edit can require another review.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Send changes', onPress: () => { void resolve(review, 'phone'); } },
        ])} />}
      {(!reviewCloud(review) || reviewCloud(review)!.deleted) && <>
        <Text style={styles.body}>The offline draft stays here until you choose. A removed person is never recreated automatically.</Text>
        <ActionButton label="Copy draft to a new person" disabled={busy || sync.syncing} onPress={() => Alert.alert('Create a new person?',
          'Create a separate person using this phone draft and its pending items. If another connected person was removed, review that person too before the connection can sync.', [
            { text: 'Cancel', style: 'cancel' }, { text: 'Create person', onPress: () => { void resolve(review, 'copy'); } },
          ])} />
      </>}
    </Surface>)}
    {childReviews.map((review) => <Surface key={`${review.entity}:${review.entityId}`} style={styles.card}>
      <Text style={styles.title}>{String(review.entity === 'reminder' ? review.local.title || 'Reminder'
        : review.entity === 'plan' ? review.local.summary || 'Plan' : review.entity === 'family' ? review.local.name || 'Family entry'
          : review.entity === 'relationship' ? 'Relationship' : 'Interaction')} · {review.contactName}</Text>
      <Text style={styles.body}>{review.reason === 'epoch_changed' ? 'The cloud database was restored or erased.'
        : review.reason === 'merged_self_link' ? 'These connected profiles were merged into one person. Your draft stays here for review; a person cannot be linked to themselves.'
        : ['parent_deleted', 'linked_deleted', 'related_deleted'].includes(review.reason) ? 'A connected person was removed. Review the person draft above before copying this change.'
          : review.cloud?.deleted || !review.cloud ? 'This item is no longer in the cloud database.' : 'This change overlaps a cloud edit.'}</Text>
      {Object.entries(review.changes).filter(([field]) => field !== 'contact_id').map(([field, value]) => <Text key={field} style={styles.body}>
        {field.replace(/_/gu, ' ')}{':\n'}Phone: {display(field, value)}{'\n'}Cloud: {display(field, review.cloud?.data?.[field])}
      </Text>)}
      {review.operation === 'delete' && <Text style={styles.body}>The phone has a pending request to remove this item.</Text>}
      <ActionButton label="Use cloud version" variant="secondary" disabled={busy || sync.syncing} onPress={() => Alert.alert('Use the cloud version?',
        'Discard pending phone changes for this item and adopt the current cloud result.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Use cloud', style: 'destructive', onPress: () => { void resolveChild(review, 'cloud'); } },
        ])} />
      {review.entity === 'plan' && review.changes.completed_at != null && review.cloud?.data?.completed_at != null && review.operation !== 'delete'
        && <Text style={styles.body}>This plan is already completed in the cloud. Use that result to discard the pending phone completion. Log any additional activity separately.</Text>}
      {review.cloud && !review.cloud.deleted && !missingReference(review)
        && !(review.entity === 'plan' && review.changes.completed_at != null && review.cloud.data?.completed_at != null && review.operation !== 'delete')
        && <ActionButton label={review.operation === 'delete' ? 'Remove cloud item' : 'Send these phone changes'} disabled={busy || sync.syncing}
        onPress={() => Alert.alert('Apply the phone changes?', 'Apply this reviewed change to the current cloud item. Another overlapping edit can need review.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Apply', onPress: () => { void resolveChild(review, 'phone'); } },
        ])} />}
      {(!review.cloud || review.cloud.deleted) && !missingReference(review) && <ActionButton label="Copy as a new item" disabled={busy || sync.syncing}
        onPress={() => Alert.alert('Create a new item?', 'Save a new copy of this phone draft for the same person. The removed cloud item stays removed.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Create copy', onPress: () => { void resolveChild(review, 'copy'); } },
        ])} />}
    </Surface>)}
  </ScrollView>;
}
const styles = StyleSheet.create({
  content: { padding: 24, gap: 20 }, card: { padding: 20, gap: 16 },
  title: { fontFamily: fonts.display, fontSize: 24, color: palette.ink },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22, color: palette.muted },
  error: { fontFamily: fonts.body, fontSize: 15, color: palette.primary },
});
