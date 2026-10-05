import { DeviceSavedSources } from '@/components/device-saved-sources';
import { PersonCalendarContext } from '@/components/person-calendar-context';
import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton, Avatar, Eyebrow, SectionHeading, StatusPill, Surface } from '@/components/design-system';
import {
  getContact,
  listContactInteractionPage,
  logInteraction,
  type InteractionRecord,
  type InteractionType,
  type InteractionCursor,
} from '@/data/contacts';
import { listOpenReminders, type ReminderRecord } from '@/data/reminders';
import { getRelationshipState, type ContactRecord } from '@/domain/contact';
import { formatDateTime, formatRelativeDate } from '@/lib/format';
import { fonts, palette } from '@/theme';
import { useNativeSync } from '@/native/sync';
import { useContactPhoto } from '@/native/contact-photo';
import { readContactMethods, contactMethodHref } from '../../../../../packages/domain/src/contact-methods';
import { readContactSources, readSourceFacts, SOURCE_FIELD_LABELS } from '../../../../../packages/domain/src/contact-sources';
import { readProviderSources, readProviderFacts } from '../../../../../packages/domain/src/provider-sources';

const TOUCH_OPTIONS: { type: InteractionType; label: string }[] = [
  { type: 'message', label: 'Messaged' },
  { type: 'call', label: 'Called' },
  { type: 'meetup', label: 'Met up' },
];

export default function ContactDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  return <ContactDetail key={id} id={id} />;
}

function ContactDetail({ id }: { id: string }) {
  const db = useSQLiteContext();
  const focused = useIsFocused();
  const { revision } = useNativeSync();
  const router = useRouter();
  const [contact, setContact] = useState<ContactRecord | null>(null);
  const photo = useContactPhoto(contact?.id ?? id, true, focused);
  const [interactions, setInteractions] = useState<InteractionRecord[]>([]);
  const [reminders, setReminders] = useState<ReminderRecord[]>([]);
  const [loading, setLoading] = useState(!!id);
  const [logging, setLogging] = useState<InteractionType | null>(null);
  const [cursor, setCursor] = useState<InteractionCursor | null>(null), [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(''), [timelineError, setTimelineError] = useState(''), [reload, setReload] = useState(0);
  const requestState = useRef({ generation: 0, paging: false }), recording = useRef(false);

  useEffect(() => {
    if (!focused || !id) return;
    let active = true;
    const state = requestState.current;
    state.generation++; state.paging = false;
    void Promise.all([getContact(db, id), listContactInteractionPage(db, id), listOpenReminders(db, id)])
      .then(([nextContact, page, nextReminders]) => {
        if (active) { setContact(nextContact); setInteractions(page.interactions); setCursor(page.nextCursor); setReminders(nextReminders);
          setLoading(false); setLoadingMore(false); setError(''); setTimelineError(''); }
      }, () => {
        if (active) { setError('Unable to read this person. Your saved details are still on this phone. Try again.'); setLoading(false); setLoadingMore(false); }
      });
    return () => { active = false; state.generation++; };
  }, [focused, db, id, revision, reload]);

  async function loadOlder() {
    const state = requestState.current;
    if (!cursor || state.paging || !contact) return;
    state.paging = true; setLoadingMore(true); setTimelineError('');
    const request = state.generation;
    try {
      const page = await listContactInteractionPage(db, contact.id, cursor);
      if (request !== state.generation) return;
      setInteractions((current) => [...current, ...page.interactions]); setCursor(page.nextCursor);
    } catch {
      if (request === state.generation) setTimelineError('Unable to read older entries. Try again.');
    } finally {
      if (request === state.generation) { state.paging = false; setLoadingMore(false); }
    }
  }

  async function recordTouch(type: InteractionType) {
    if (!contact || recording.current) return;
    recording.current = true;
    setLogging(type);
    try {
      await logInteraction(db, contact.id, type);
      setReload((value) => value + 1);
    } catch {
      Alert.alert('Could not log this touch', 'Nothing changed. Please try again.');
    } finally {
      setLogging(null);
      recording.current = false;
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator color={palette.primary} />
      </SafeAreaView>
    );
  }

  if (!contact) {
    return (
      <SafeAreaView style={styles.centered}>
        <Text accessibilityRole={error ? 'alert' : undefined} style={styles.missingTitle}>{error || 'This person is not available.'}</Text>
        {!!error && <ActionButton label="Try again" onPress={() => setReload((value) => value + 1)} />}
        <Pressable accessibilityRole="button" onPress={() => router.replace('/people')} style={styles.returnButton}>
          <Text style={styles.returnText}>Back to your people</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const relationshipState = getRelationshipState(contact);
  const stateLabel = relationshipState === 'steady'
    ? 'Steady'
    : relationshipState === 'due'
      ? 'Due for care'
      : relationshipState === 'overdue'
        ? 'Reach out'
        : 'New relationship';
  const stateTone = relationshipState === 'steady' ? 'moss' : relationshipState === 'overdue' ? 'rose' : 'amber';

  return (
    <SafeAreaView style={styles.safeArea}>
      <Stack.Screen options={{ title: contact.name }} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {!!error && <><Text accessibilityRole="alert" style={styles.notes}>{error}</Text><ActionButton label="Try again" variant="secondary" onPress={() => setReload((value) => value + 1)} /></>}
        <View style={styles.identity}>
          <Avatar name={contact.name} size={82} photo={photo.uri} />
          <View style={styles.identityCopy}>
            <Text style={styles.name}>{contact.name}</Text>
            <StatusPill tone={stateTone} label={stateLabel} />
          </View>
        </View>

        {!!photo.error && <View style={styles.section}><Text accessibilityRole="alert" style={styles.lastTouch}>{photo.error}</Text>
          <ActionButton label="Retry photo download" variant="secondary" onPress={photo.retry} /></View>}
        <ActionButton label="Edit contact details" variant="secondary" onPress={() => router.push({ pathname: '/contacts/edit', params: { id: contact.id } })} />
        <ActionButton label="Contact methods" variant="secondary" onPress={() => router.push({ pathname: '/contacts/methods', params: { id: contact.id } })} />
        <ActionButton label="Plans, family & relationships" variant="secondary" onPress={() => router.push({ pathname: '/contacts/context', params: { contactId: contact.id } })} />

        {(contact.email || contact.phone) && (
          <Surface style={styles.detailsCard}>
            {contact.email && <DetailRow label="Email" value={contact.email} />}
            {contact.phone && <DetailRow label="Phone" value={contact.phone} />}
          </Surface>
        )}
        {readContactMethods(contact.contact_methods).filter((method) => !method.preferred || method.kind === 'profile').map((method) => <Pressable key={method.id} accessibilityRole="link"
          accessibilityLabel={`Open ${method.label ?? method.kind}: ${method.value}`} onPress={() => { void Linking.openURL(contactMethodHref(method)).catch(() => Alert.alert('Unable to open this method', 'Check that an app is available for this link.')); }}>
          <Surface style={styles.detailsCard}><DetailRow label={`${method.label ?? method.kind}${method.preferred ? ' · preferred' : ''}`} value={method.value} /></Surface>
        </Pressable>)}
        <DeviceSavedSources contactId={contact.id} />
        {readContactSources(contact.source_links).map((source) => <Surface key={source.public_id} style={styles.detailsCard}>
          <Eyebrow>LinkedIn · user supplied</Eyebrow>
          {Object.entries(readSourceFacts(source.fields)).map(([field, fact]) => fact.observed_value && <DetailRow key={field} label={SOURCE_FIELD_LABELS[field as keyof typeof SOURCE_FIELD_LABELS]} value={fact.observed_value} />)}
          <ActionButton label="Open LinkedIn profile" variant="secondary" onPress={() => { void Linking.openURL(source.profile_url).catch(() => Alert.alert('Unable to open profile', 'Check your internet connection.')); }} />
          <Text style={styles.lastTouch}>Edit linked sources on the web. Saved details remain available offline.</Text>
        </Surface>)}
        {readProviderSources(contact.provider_links).map((source) => { const facts = readProviderFacts(source.observed_facts); return <Surface key={source.public_id} style={styles.detailsCard}>
          <Eyebrow>Google Contacts · saved source</Eyebrow>
          <DetailRow label="Account" value={source.account_email} />
          {facts.name && <DetailRow label="Source name" value={facts.name} />}
          {facts.emails.concat(facts.phones).map((method, index) => <DetailRow key={index} label={method.label || 'Contact method'} value={method.value} />)}
          {facts.company && <DetailRow label="Company" value={facts.company} />}
          {facts.title && <DetailRow label="Title" value={facts.title} />}
          {facts.location && <DetailRow label="Location" value={facts.location} />}
          <Text style={styles.lastTouch}>Saved details remain available offline. Manage this source on the web; your corrections stay in Everclose.</Text>
        </Surface>; })}

        <View style={styles.section}>
          <Eyebrow>Quick capture</Eyebrow>
          <Text style={styles.captureTitle}>How did you connect?</Text>
          <View style={styles.touchRow} accessibilityRole="radiogroup">
            {TOUCH_OPTIONS.map((option) => (
              <Pressable
                accessibilityRole="button"
                disabled={logging !== null}
                key={option.type}
                onPress={() => void recordTouch(option.type)}
                style={({ pressed }) => [styles.touchButton, pressed && styles.pressed]}
              >
                {logging === option.type
                  ? <ActivityIndicator size="small" color={palette.primary} />
                  : <Text style={styles.touchText}>{option.label}</Text>}
              </Pressable>
            ))}
          </View>
          <Text style={styles.lastTouch}>Last touch: {formatRelativeDate(contact.last_contacted)}</Text>
        </View>

        <Surface style={styles.reminderCallout}>
          <View style={styles.calloutCopy}>
            <Text style={styles.calloutTitle}>Make the next moment easy</Text>
            <Text style={styles.calloutText}>Set one gentle reminder and let iOS hold the timing.</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Set a reminder for ${contact.name}`}
            onPress={() => router.push({
              pathname: '/reminders/new',
              params: { contactId: contact.id },
            })}
            style={({ pressed }) => [styles.calloutButton, pressed && styles.pressed]}
          >
            <Text style={styles.calloutButtonText}>Set reminder</Text>
          </Pressable>
        </Surface>

        {contact.notes && (
          <View style={styles.section}>
            <SectionHeading title="What you remember" />
            <Text style={styles.notes}>{contact.notes}</Text>
          </View>
        )}

        <PersonCalendarContext contactId={id} />
        <View style={styles.section}>
          <SectionHeading title="Open reminders" />
          {reminders.length === 0 ? (
            <Text style={styles.emptySection}>No reminder is waiting for this relationship.</Text>
          ) : reminders.map((reminder) => (
            <View key={reminder.id} style={styles.timelineRow}>
              <View style={styles.timelineDot} />
              <View style={styles.timelineCopy}>
                <Text style={styles.timelineTitle}>{reminder.title}</Text>
                <Text style={styles.timelineMeta}>{formatDateTime(reminder.remind_at)}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.section}>
          <SectionHeading title="Relationship timeline" />
          {interactions.length === 0 ? (
            <Text style={styles.emptySection}>Log a touch above to start the relationship timeline.</Text>
          ) : interactions.map((interaction) => (
            <View key={interaction.id} style={styles.timelineRow}>
              <View style={[styles.timelineDot, styles.timelineDotMoss]} />
              <View style={styles.timelineCopy}>
                <Text style={styles.timelineTitle}>{interaction.summary || interaction.type}</Text>
                <Text style={styles.timelineMeta}>{interaction.occurred_at ? formatDateTime(interaction.occurred_at) : interaction.date}</Text>
                {!!interaction.notes && <Text selectable style={styles.notes}>{interaction.notes}</Text>}
              </View>
            </View>
          ))}
          {!!timelineError && <Text accessibilityRole="alert" style={styles.notes}>{timelineError}</Text>}
          {!!cursor && <ActionButton label={loadingMore ? 'Reading older entries…' : 'Show older entries'} variant="secondary" disabled={loadingMore} onPress={() => void loadOlder()} />}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text selectable style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  centered: { flex: 1, backgroundColor: palette.canvas, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 30 },
  content: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 42, gap: 25 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 17 },
  identityCopy: { flex: 1, gap: 8 },
  name: { color: palette.ink, fontFamily: fonts.display, fontSize: 34, lineHeight: 39, fontWeight: '700', letterSpacing: -0.7 },
  detailsCard: { padding: 17, gap: 13, borderRadius: 21 },
  detailRow: { gap: 2 },
  detailLabel: { color: palette.faint, fontFamily: fonts.bodyDemi, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.1 },
  detailValue: { color: palette.ink, fontFamily: fonts.bodyMedium, fontSize: 14 },
  section: { gap: 12 },
  captureTitle: { color: palette.ink, fontFamily: fonts.display, fontSize: 25, fontWeight: '700', marginTop: -4 },
  touchRow: { flexDirection: 'row', gap: 8 },
  touchButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#EFC9D3',
    backgroundColor: palette.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  touchText: { color: palette.primary, fontFamily: fonts.bodyDemi, fontSize: 12, fontWeight: '700' },
  lastTouch: { color: palette.muted, fontFamily: fonts.body, fontSize: 12 },
  reminderCallout: { padding: 18, borderRadius: 22, gap: 15, backgroundColor: '#2B2424', borderColor: '#2B2424' },
  calloutCopy: { gap: 3 },
  calloutTitle: { color: palette.white, fontFamily: fonts.display, fontSize: 21, fontWeight: '700' },
  calloutText: { color: '#D8CCCA', fontFamily: fonts.body, fontSize: 12, lineHeight: 18 },
  calloutButton: { alignSelf: 'flex-start', borderRadius: 14, backgroundColor: palette.primary, paddingHorizontal: 16, paddingVertical: 11 },
  calloutButtonText: { color: palette.white, fontFamily: fonts.bodyDemi, fontSize: 12, fontWeight: '700' },
  notes: { color: palette.muted, fontFamily: fonts.body, fontSize: 15, lineHeight: 23 },
  emptySection: { color: palette.muted, fontFamily: fonts.body, fontSize: 13, lineHeight: 20 },
  timelineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, minHeight: 48 },
  timelineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: palette.primary, marginTop: 5 },
  timelineDotMoss: { backgroundColor: palette.moss },
  timelineCopy: { flex: 1, gap: 2 },
  timelineTitle: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 14, fontWeight: '700' },
  timelineMeta: { color: palette.muted, fontFamily: fonts.body, fontSize: 11 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
  missingTitle: { color: palette.ink, fontFamily: fonts.display, fontSize: 24, fontWeight: '700', textAlign: 'center' },
  returnButton: { borderRadius: 15, backgroundColor: palette.primary, paddingHorizontal: 18, paddingVertical: 12 },
  returnText: { color: palette.white, fontFamily: fonts.bodyDemi, fontSize: 13, fontWeight: '700' },
});
