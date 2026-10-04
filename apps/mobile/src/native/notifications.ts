import * as Notifications from 'expo-notifications';

let notificationAccount: string | null = null;
let accountTransition: Promise<void> = Promise.resolve();
let scheduleGeneration = 0;

export async function selectNotificationAccount(scope: string | null, options: { dismissDelivered?: boolean } = {}) {
  notificationAccount = scope;
  const generation = ++scheduleGeneration;
  accountTransition = accountTransition.catch(() => undefined).then(async () => {
    if (notificationAccount !== scope || generation !== scheduleGeneration) return;
    await Notifications.cancelAllScheduledNotificationsAsync();
    if (options.dismissDelivered !== false) {
      await Notifications.dismissAllNotificationsAsync();
      await Notifications.setBadgeCountAsync(0);
    }
  });
  await accountTransition;
}

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
  accountScope: string;
  requestPermission?: boolean;
}): Promise<NotificationScheduleResult> {
  const generation = scheduleGeneration;
  await accountTransition;
  if (options.accountScope !== notificationAccount || generation !== scheduleGeneration) return { id: null, permission: 'denied' };
  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted' && options.requestPermission !== false) {
    permission = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: false },
    });
  }
  if (permission.status !== 'granted') return { id: null, permission: 'denied' };
  if (options.accountScope !== notificationAccount || generation !== scheduleGeneration) return { id: null, permission: 'denied' };

  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Everclose reminder',
      body: 'Open Everclose to review your reminder.',
      data: {
        url: `/contacts/${options.contactId}`,
        contactId: options.contactId,
        accountScope: options.accountScope,
      },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: options.remindAt,
    },
  });
  if (options.accountScope !== notificationAccount || generation !== scheduleGeneration) {
    await Notifications.cancelScheduledNotificationAsync(id);
    return { id: null, permission: 'denied' };
  }
  return { id, permission: 'granted' };
}

export async function cancelReminderNotification(notificationId: string | null): Promise<void> {
  if (!notificationId) return;
  await Notifications.cancelScheduledNotificationAsync(notificationId).catch(() => {
    // A delivered or OS-pruned notification no longer needs cancellation.
  });
}
