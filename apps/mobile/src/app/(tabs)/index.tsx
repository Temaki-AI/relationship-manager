import { useIsFocused, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandLockup, Eyebrow, SectionHeading, StatusPill, Surface } from '@/components/design-system';
import { getDashboardSnapshot, type DashboardSnapshot } from '@/data/contacts';
import { getNextReminder, type ReminderRecord } from '@/data/reminders';
import { formatDateTime, getGreeting } from '@/lib/format';
import { fonts, palette } from '@/theme';
import { useNativeSync } from '@/native/sync';
import { useNativeAccount } from '@/native/account';

type HomeState = {
  snapshot: DashboardSnapshot;
  nextReminder: ReminderRecord | null;
};

export default function TodayScreen() {
  const db = useSQLiteContext();
  const focused = useIsFocused();
  const { revision } = useNativeSync();
  const { account } = useNativeAccount();
  const router = useRouter();
  const [state, setState] = useState<HomeState | null>(null);

  useEffect(() => {
    if (!focused) return;
    let active = true;
    void Promise.all([getDashboardSnapshot(db), getNextReminder(db)]).then(([snapshot, nextReminder]) => {
      if (active) setState({ snapshot, nextReminder });
    });
    return () => { active = false; };
  }, [focused, db, revision]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.topBar}>
          <BrandLockup />
          <Pressable accessibilityRole="button" accessibilityLabel="Account and sync" onPress={() => router.push('/account')}>
            <StatusPill tone={account ? 'moss' : 'amber'} label={account ? 'Account & sync' : 'Sign in'} />
          </Pressable>
        </View>

        <View style={styles.heroCopy}>
          <Eyebrow>{getGreeting()}</Eyebrow>
          <Text style={styles.title}>Keep the people you love within reach.</Text>
          <Text style={styles.subtitle}>A private place for the small details that make relationships last.</Text>
        </View>

        {!state ? (
          <View style={styles.loading}>
            <ActivityIndicator color={palette.primary} />
          </View>
        ) : (
          <>
            <Surface style={styles.nextMove}>
              <View style={styles.nextMoveGlow} />
              <Eyebrow>Your next small move</Eyebrow>
              {state.nextReminder ? (
                <>
                  <Text style={styles.nextName}>{state.nextReminder.contact_name}</Text>
                  <Text style={styles.nextTitle}>{state.nextReminder.title}</Text>
                  <Text style={styles.nextTime}>{formatDateTime(state.nextReminder.remind_at)}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${state.nextReminder.contact_name}`}
                    onPress={() => router.push({
                      pathname: '/contacts/[id]',
                      params: { id: state.nextReminder?.contact_id || '' },
                    })}
                    style={({ pressed }) => [styles.cardAction, pressed && styles.pressed]}
                  >
                    <Text style={styles.cardActionText}>Open relationship</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={styles.nextName}>Your day is clear</Text>
                  <Text style={styles.nextTitle}>
                    {state.snapshot.contactCount === 0
                      ? 'Add the first person you want to stay close to.'
                      : 'Set a thoughtful reminder while the moment is fresh.'}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => router.push(
                      state.snapshot.contactCount === 0 ? '/contacts/new' : '/reminders/new'
                    )}
                    style={({ pressed }) => [styles.cardAction, pressed && styles.pressed]}
                  >
                    <Text style={styles.cardActionText}>
                      {state.snapshot.contactCount === 0 ? 'Add someone' : 'Set a reminder'}
                    </Text>
                  </Pressable>
                </>
              )}
            </Surface>

            <View style={styles.sectionBlock}>
              <SectionHeading title="Relationship rhythm" />
              <View style={styles.metrics}>
                <Metric value={state.snapshot.contactCount} label="People" />
                <Metric value={state.snapshot.attentionCount} label="Need care" accent />
                <Metric value={state.snapshot.touchesThisWeek} label="Touches" />
              </View>
            </View>

            <Surface style={styles.privacyCard}>
              <View style={styles.privacyMark}><Text style={styles.privacyMarkText}>E</Text></View>
              <View style={styles.privacyCopy}>
                <Text style={styles.privacyTitle}>Private by default</Text>
                <Text style={styles.privacyText}>
                  {account ? 'Your private workspace syncs with Everclose. An offline copy stays on this iPhone.'
                    : 'Your relationship data stays on this iPhone. Sign in to connect your existing workspace.'}
                </Text>
              </View>
            </Surface>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Metric({ value, label, accent = false }: { value: number; label: string; accent?: boolean }) {
  return (
    <Surface style={[styles.metric, accent && styles.metricAccent]}>
      <Text style={[styles.metricValue, accent && styles.metricValueAccent]}>{value}</Text>
      <Text style={[styles.metricLabel, accent && styles.metricLabelAccent]}>{label}</Text>
    </Surface>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 34, gap: 26 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroCopy: { gap: 8, paddingTop: 8 },
  title: {
    maxWidth: 355,
    color: palette.ink,
    fontFamily: fonts.display,
    fontSize: 38,
    fontWeight: '700',
    lineHeight: 43,
    letterSpacing: -1.2,
  },
  subtitle: { maxWidth: 345, color: palette.muted, fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
  loading: { minHeight: 260, alignItems: 'center', justifyContent: 'center' },
  nextMove: { overflow: 'hidden', padding: 24, gap: 8, backgroundColor: '#FFFEFD' },
  nextMoveGlow: {
    position: 'absolute',
    right: -36,
    top: -54,
    width: 170,
    height: 170,
    borderRadius: 85,
    backgroundColor: palette.primarySoft,
    opacity: 0.72,
  },
  nextName: { color: palette.ink, fontFamily: fonts.display, fontSize: 28, fontWeight: '700', marginTop: 8 },
  nextTitle: { color: palette.muted, fontFamily: fonts.body, fontSize: 15, lineHeight: 22, maxWidth: 285 },
  nextTime: { color: palette.primary, fontFamily: fonts.bodyDemi, fontSize: 13, marginTop: 2 },
  cardAction: {
    alignSelf: 'flex-start',
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 14,
    backgroundColor: palette.primary,
  },
  cardActionText: { color: palette.white, fontFamily: fonts.bodyDemi, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  sectionBlock: { gap: 13 },
  metrics: { flexDirection: 'row', gap: 10 },
  metric: { flex: 1, paddingHorizontal: 12, paddingVertical: 16, borderRadius: 20, gap: 2 },
  metricAccent: { backgroundColor: palette.primary, borderColor: palette.primary },
  metricValue: { color: palette.ink, fontFamily: fonts.display, fontSize: 27, fontWeight: '700' },
  metricValueAccent: { color: palette.white },
  metricLabel: { color: palette.muted, fontFamily: fonts.bodyMedium, fontSize: 11 },
  metricLabelAccent: { color: '#FFE8EE' },
  privacyCard: { padding: 18, borderRadius: 22, flexDirection: 'row', gap: 13, alignItems: 'flex-start' },
  privacyMark: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.mossSoft,
  },
  privacyMarkText: { color: palette.moss, fontFamily: fonts.display, fontSize: 18, fontWeight: '700' },
  privacyCopy: { flex: 1, gap: 3 },
  privacyTitle: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 14, fontWeight: '700' },
  privacyText: { color: palette.muted, fontFamily: fonts.body, fontSize: 12, lineHeight: 18 },
});
