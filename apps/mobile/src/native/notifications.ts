import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export type NotificationScheduleResult = {
  id: string | null;
  permission: 'granted' | 'denied';
};

export async function scheduleReminderNotification(options: {
  reminderTitle: string;
  contactId: string;
  contactName: string;
  remindAt: Date;
}): Promise<NotificationScheduleResult> {
  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted') {
    permission = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: false },
    });
  }
  if (permission.status !== 'granted') return { id: null, permission: 'denied' };

  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: `Reconnect with ${options.contactName}`,
      body: options.reminderTitle,
      data: {
        url: `/contacts/${options.contactId}`,
        contactId: options.contactId,
      },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: options.remindAt,
    },
  });
  return { id, permission: 'granted' };
}

export async function cancelReminderNotification(notificationId: string | null): Promise<void> {
  if (!notificationId) return;
  await Notifications.cancelScheduledNotificationAsync(notificationId).catch(() => {
    // A delivered or OS-pruned notification no longer needs cancellation.
  });
}
