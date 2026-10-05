import * as Notifications from 'expo-notifications';

let notificationAccount: string | null = null;
let accountEpoch = 0;
let accountTransition: Promise<void> = Promise.resolve();
let scheduleGeneration = 0;
let schedulerQueue: Promise<void> = Promise.resolve();

function schedulerOperation<T>(action: () => Promise<T>): Promise<T> {
  const task = schedulerQueue.catch(() => {}).then(action);
  schedulerQueue = task.then(() => {}, () => {});
  return task;
}

export async function selectNotificationAccount(scope: string | null, options: { dismissDelivered?: boolean } = {}) {
  if (notificationAccount !== scope) accountEpoch++;
  notificationAccount = scope;
  const generation = ++scheduleGeneration;
  accountTransition = schedulerOperation(async () => {
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
  reminderId?: string;
  /** A saved-record guard allows bounded retries after a same-account refresh. */
  isCurrent?: () => Promise<boolean>;
}): Promise<NotificationScheduleResult> {
  const initialGeneration = scheduleGeneration, epoch = accountEpoch;
  const denied: NotificationScheduleResult = { id: null, permission: 'denied' };
  const current = async () => {
    if (options.accountScope !== notificationAccount || epoch !== accountEpoch) return false;
    if (options.isCurrent && !await options.isCurrent()) return false;
    return options.accountScope === notificationAccount && epoch === accountEpoch;
  };
  await accountTransition;
  if (!await current() || !options.isCurrent && initialGeneration !== scheduleGeneration) return denied;
  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted' && options.requestPermission !== false) {
    permission = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: false },
    });
  }
  if (permission.status !== 'granted') return denied;

  for (let attempt = 0; attempt < (options.isCurrent ? 3 : 1); attempt++) {
    await accountTransition;
    if (!await current()) return denied;
    const generation = options.isCurrent ? scheduleGeneration : initialGeneration;
    const result = await schedulerOperation<NotificationScheduleResult>(async () => {
      if (!await current() || generation !== scheduleGeneration) return denied;
      const id = await Notifications.scheduleNotificationAsync({
        ...(options.reminderId ? { identifier: `everclose-reminder:${encodeURIComponent(options.accountScope)}:${options.reminderId}:${options.remindAt.toISOString()}` } : {}),
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
      let confirmed = false;
      try { confirmed = await current() && generation === scheduleGeneration; }
      catch (error) { await Notifications.cancelScheduledNotificationAsync(id); throw error; }
      if (!confirmed) {
        await Notifications.cancelScheduledNotificationAsync(id);
        return denied;
      }
      return { id, permission: 'granted' };
    });
    if (result.id) return result;
  }
  return denied;
}

export async function cancelReminderNotification(notificationId: string | null): Promise<void> {
  if (!notificationId) return;
  await schedulerOperation(() => Notifications.cancelScheduledNotificationAsync(notificationId).catch(() => {
    // A delivered or OS-pruned notification no longer needs cancellation.
  }));
}
