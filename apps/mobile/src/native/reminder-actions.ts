import { useIsFocused } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { accountScope } from '../../../../packages/domain/src/devices';
import { completeReminder, isReminderNotificationCurrent, saveReminderNotification, snoozeReminder, type ReminderRecord } from '@/data/reminders';
import { getReminderPresetDate, REMINDER_PRESETS, type ReminderPresetId } from '@/domain/reminder';
import { useNativeAccount } from './account';
import { cancelReminderNotification, scheduleReminderNotification } from './notifications';

/** Both Today and Reminders commit the same durable change before replacing an alert. */
export function useReminderActions(onChanged: () => Promise<void>, isBlocked: () => boolean = () => false) {
  const db = useSQLiteContext();
  const { account } = useNativeAccount();
  const focused = useIsFocused();
  const visible = useRef(focused), busy = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  useEffect(() => { visible.current = focused; return () => { visible.current = false; }; }, [focused]);
  function tell(title: string, message: string) { if (visible.current) Alert.alert(title, message); }
  async function refresh() {
    try { await onChanged(); }
    catch { tell('Change saved', 'Could not refresh this screen. Open it again to see the saved change.'); }
  }
  function begin(id: string) {
    if (!visible.current || busy.current || isBlocked()) return false;
    busy.current = true; setBusyId(id); return true;
  }
  function finish() { busy.current = false; setBusyId(null); }

  async function markComplete(reminder: ReminderRecord) {
    if (!begin(reminder.id)) return;
    try {
      const notificationId = await completeReminder(db, reminder.id);
      try { await cancelReminderNotification(notificationId); }
      catch { tell('Reminder completed; alert needs checking', 'Completion is saved. Reopen Everclose to retry removing its iOS alert.'); }
      await refresh();
    } catch { tell('Could not complete reminder', 'Your reminder is unchanged. Please try again.'); }
    finally { finish(); }
  }

  async function moveReminder(shown: ReminderRecord, preset: ReminderPresetId) {
    if (!begin(shown.id)) return;
    try {
      const { reminder, previousNotificationId, changed } = await snoozeReminder(db, shown, getReminderPresetDate(preset));
      if (!changed) { await refresh(); return; }
      let notificationId: string | null = null;
      try {
        await cancelReminderNotification(previousNotificationId);
        const notification = await scheduleReminderNotification({ accountScope: accountScope(account),
          reminderId: reminder.id, reminderTitle: reminder.title, contactId: reminder.contact_id,
          contactName: reminder.contact_name, remindAt: new Date(reminder.remind_at),
          isCurrent: () => isReminderNotificationCurrent(db, reminder) });
        notificationId = notification.id;
        if (!await saveReminderNotification(db, reminder, notificationId)) await cancelReminderNotification(notificationId);
        if (notification.permission === 'denied') tell('Reminder moved without an alert',
          'The new time is saved. Check Everclose notification permission and reopen the app to retry the alert.');
      } catch {
        await cancelReminderNotification(notificationId).catch(() => {});
        tell('Reminder moved; alert needs checking',
          'The new time is saved. iOS alert replacement could not be confirmed. Reopen Everclose to retry; do not create the reminder again.');
      }
      await refresh();
    } catch (error) {
      tell('Could not move reminder', error instanceof Error ? error.message : 'Your reminder is unchanged. Please try again.');
      await onChanged().catch(() => {});
    } finally { finish(); }
  }

  function chooseSnooze(reminder: ReminderRecord) {
    if (!visible.current || busy.current || isBlocked()) return;
    Alert.alert('Choose reminder time', `Choose a new time for ${reminder.title}.`, [
      ...REMINDER_PRESETS.map((preset) => ({ text: `${preset.label} · ${preset.detail}`,
        onPress: () => { void moveReminder(reminder, preset.id); } })),
      { text: 'Cancel', style: 'cancel' },
    ]);
  }
  return { busyId, isBusy: () => busy.current, markComplete, chooseSnooze };
}
