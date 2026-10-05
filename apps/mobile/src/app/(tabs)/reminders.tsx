import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar, BrandLockup, StatusPill } from '@/components/design-system';
import { listOpenReminders, type ReminderRecord } from '@/data/reminders';
import { formatDateTime } from '@/lib/format';
import { fonts, palette } from '@/theme';
import { useReminderActions } from '@/native/reminder-actions';

export default function RemindersScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const [reminders, setReminders] = useState<ReminderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);

  const loadReminders = useCallback(async () => {
    setReminders(await listOpenReminders(db));
    setCurrentTime(Date.now());
    setLoading(false);
  }, [db]);

  const { busyId: completingId, markComplete, chooseSnooze } = useReminderActions(loadReminders);

  useFocusEffect(useCallback(() => {
    void loadReminders();
  }, [loadReminders]));

  return (
    <SafeAreaView style={styles.safeArea}>
      <FlatList
        data={reminders}
        keyExtractor={(reminder) => reminder.id}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={(
          <View style={styles.header}>
            <BrandLockup />
            <View style={styles.headingRow}>
              <View style={styles.headingCopy}>
                <Text style={styles.title}>Gentle nudges</Text>
                <Text style={styles.subtitle}>Follow through without turning friendship into a task list.</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Create reminder"
                onPress={() => router.push('/reminders/new')}
                style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
              >
                <Text style={styles.addButtonText}>+</Text>
              </Pressable>
            </View>
          </View>
        )}
        ListEmptyComponent={loading ? (
          <View style={styles.empty}><ActivityIndicator color={palette.primary} /></View>
        ) : (
          <View style={styles.empty}>
            <View style={styles.emptyBell}><Text style={styles.emptyBellText}>B</Text></View>
            <Text style={styles.emptyTitle}>Nothing waiting on you</Text>
            <Text style={styles.emptyText}>Create a reminder when a thoughtful next step comes to mind.</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/reminders/new')}
              style={({ pressed }) => [styles.emptyAction, pressed && styles.pressed]}
            >
              <Text style={styles.emptyActionText}>Create a reminder</Text>
            </Pressable>
          </View>
        )}
        renderItem={({ item }) => {
          const overdue = new Date(item.remind_at).getTime() <= currentTime;
          return (
            <View style={styles.reminderCard}>
              <Pressable accessibilityRole="button"
                accessibilityLabel={`Open ${item.contact_name}. Reminder: ${item.title}. ${overdue ? 'Due' : 'Upcoming'} ${formatDateTime(item.remind_at)}`}
                onPress={() => router.push({ pathname: '/contacts/[id]', params: { id: item.contact_id } })}
                style={({ pressed }) => [styles.reminderTop, pressed && styles.cardPressed]}>
                <Avatar name={item.contact_name} size={44} />
                <View style={styles.reminderCopy}>
                  <Text style={styles.contactName}>{item.contact_name}</Text>
                  <Text style={styles.reminderTitle}>{item.title}</Text>
                </View>
                <StatusPill tone={overdue ? 'rose' : 'amber'} label={overdue ? 'Due' : 'Upcoming'} />
              </Pressable>
              <View style={styles.reminderBottom}>
                <Text style={styles.reminderTime}>{formatDateTime(item.remind_at)}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={`Snooze reminder for ${item.contact_name}: ${item.title}`}
                  disabled={completingId !== null} onPress={() => chooseSnooze(item)}
                  style={({ pressed }) => [styles.snoozeButton, pressed && styles.pressed]}>
                  <Text style={styles.snoozeText}>Snooze</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Complete reminder for ${item.contact_name}: ${item.title}`}
                  disabled={completingId !== null}
                  onPress={() => {
                    void markComplete(item);
                  }}
                  style={({ pressed }) => [styles.completeButton, pressed && styles.pressed]}
                >
                  {completingId === item.id
                    ? <ActivityIndicator size="small" color={palette.moss} />
                    : <Text style={styles.completeText}>Complete</Text>}
                </Pressable>
              </View>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 30, gap: 12 },
  header: { gap: 20, marginBottom: 10 },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  headingCopy: { flex: 1, gap: 4 },
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 36, fontWeight: '700', letterSpacing: -0.8 },
  subtitle: { color: palette.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  addButton: {
    width: 50,
    height: 50,
    borderRadius: 18,
    backgroundColor: palette.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonText: { color: palette.white, fontFamily: fonts.body, fontSize: 30, lineHeight: 33 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
  empty: { paddingVertical: 70, alignItems: 'center', gap: 8, paddingHorizontal: 30 },
  emptyBell: {
    width: 58,
    height: 58,
    borderRadius: 21,
    backgroundColor: palette.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  emptyBellText: { color: palette.primary, fontFamily: fonts.display, fontSize: 25, fontWeight: '700' },
  emptyTitle: { color: palette.ink, fontFamily: fonts.display, fontSize: 24, fontWeight: '700' },
  emptyText: { color: palette.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  emptyAction: { marginTop: 10, borderRadius: 15, backgroundColor: palette.primary, paddingHorizontal: 18, paddingVertical: 12 },
  emptyActionText: { color: palette.white, fontFamily: fonts.bodyDemi, fontSize: 13, fontWeight: '700' },
  reminderCard: {
    borderRadius: 23,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
    padding: 17,
    gap: 14,
  },
  cardPressed: { opacity: 0.72 },
  reminderTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  reminderCopy: { flex: 1, minWidth: 0, gap: 2 },
  contactName: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 15, fontWeight: '700' },
  reminderTitle: { color: palette.muted, fontFamily: fonts.body, fontSize: 13, lineHeight: 19 },
  reminderBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  reminderTime: { flex: 1, color: palette.primary, fontFamily: fonts.bodyMedium, fontSize: 11 },
  completeButton: { minWidth: 86, minHeight: 44, borderRadius: 13, backgroundColor: palette.mossSoft, alignItems: 'center', justifyContent: 'center' },
  completeText: { color: palette.moss, fontFamily: fonts.bodyDemi, fontSize: 12, fontWeight: '700' },
  snoozeButton: { minWidth: 70, minHeight: 44, borderRadius: 13, backgroundColor: palette.surfaceWarm, alignItems: 'center', justifyContent: 'center' },
  snoozeText: { color: palette.ink, fontFamily: fonts.bodyDemi, fontSize: 12 },
});
