import { DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { useEffect, useRef } from 'react';

import { NativeAccountProvider, useNativeAccount } from '@/native/account';
import { accountScope } from '../../../../packages/domain/src/devices';
import { selectNotificationAccount, scheduleReminderNotification, cancelReminderNotification } from '@/native/notifications';
import { AccountDatabase } from '@/components/account-database';
import { NativeSyncProvider, useNativeSync } from '@/native/sync';
import { fonts, palette } from '@/theme';

void SplashScreen.preventAutoHideAsync().catch(() => {});

const navigationTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: palette.canvas,
    card: palette.canvas,
    text: palette.ink,
    primary: palette.primary,
    border: palette.line,
  },
};

function AppNavigator() {
  const db = useSQLiteContext();
  const { account } = useNativeAccount();
  const { revision } = useNativeSync();
  const notificationState = useRef<{ db: SQLiteDatabase; scope: string; fingerprint: string } | null>(null);
  const scope = accountScope(account);
  useEffect(() => {
    void SplashScreen.hideAsync().catch(() => {});

    function openNotification(notification: Notifications.Notification) {
      const url = notification.request.content.data?.url;
      if (notification.request.content.data?.accountScope === scope && typeof url === 'string' && /^\/contacts\/[a-f0-9-]+$/i.test(url)) {
        router.push(url as `/contacts/${string}`);
        Notifications.clearLastNotificationResponse();
      }
    }

    const previousResponse = Notifications.getLastNotificationResponse();
    if (previousResponse?.notification) openNotification(previousResponse.notification);
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      openNotification(response.notification);
    });
    return () => subscription.remove();
  }, [scope]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const reminders = await db.getAllAsync<{ id: string; contact_id: string; title: string; name: string; remind_at: string }>(`
        SELECT r.id, r.contact_id, r.title, c.name, r.remind_at FROM reminders r JOIN contacts c ON c.id = r.contact_id
        WHERE r.completed_at IS NULL AND r.deleted_at IS NULL AND c.deleted_at IS NULL AND julianday(r.remind_at) > julianday('now')
        ORDER BY julianday(r.remind_at), r.id LIMIT 48`);
      const permission = await Notifications.getPermissionsAsync();
      const fingerprint = JSON.stringify([permission.status, reminders]);
      if (!active || notificationState.current?.db === db && notificationState.current.scope === scope && notificationState.current.fingerprint === fingerprint) return;
      await selectNotificationAccount(scope, { dismissDelivered: notificationState.current?.scope !== scope });
      if (!active) return;
      await db.runAsync('UPDATE reminders SET notification_id = NULL');
      for (const reminder of reminders) {
        if (!active) return;
        const result = await scheduleReminderNotification({ reminderTitle: reminder.title, contactId: reminder.contact_id,
          contactName: reminder.name, remindAt: new Date(reminder.remind_at), accountScope: scope, requestPermission: false, reminderId: reminder.id });
        if (!active) { await cancelReminderNotification(result.id); return; }
        const saved = await db.runAsync(`UPDATE reminders SET notification_id = ? WHERE id = ? AND remind_at = ?
          AND completed_at IS NULL AND deleted_at IS NULL`, result.id, reminder.id, reminder.remind_at);
        if (!saved.changes) await cancelReminderNotification(result.id);
      }
      if (active) notificationState.current = { db, scope, fingerprint };
    })().catch(() => { /* Reminder creation can retry scheduling; a permission or OS failure must not hide local data. */ });
    return () => { active = false; };
  }, [db, scope, revision]);

  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: palette.canvas },
        headerStyle: { backgroundColor: palette.canvas },
        headerShadowVisible: false,
        headerTintColor: palette.primary,
        headerTitleStyle: { color: palette.ink, fontFamily: fonts.bodyDemi },
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="account" options={{ title: 'Account & sync' }} />
      <Stack.Screen name="auth" options={{ title: 'Signing in' }} />
      <Stack.Screen name="sync-review" options={{ title: 'Review offline changes' }} />
      <Stack.Screen
        name="contacts/new"
        options={{ presentation: 'modal', title: 'Add someone' }}
      />
      <Stack.Screen name="contacts/[id]" options={{ title: '' }} />
      <Stack.Screen name="contacts/edit" options={{ title: 'Edit person', presentation: 'modal' }} />
      <Stack.Screen name="contacts/context" options={{ title: 'Plans, family & relationships' }} />
      <Stack.Screen name="context/edit" options={{ title: 'Edit context', presentation: 'modal' }} />
      <Stack.Screen name="calendar/apple/[id]" options={{ title: 'Plan in Calendar' }} />
      <Stack.Screen
        name="reminders/new"
        options={{ presentation: 'modal', title: 'New reminder' }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider value={navigationTheme}>
      <NativeAccountProvider><AccountDatabase>
        <NativeSyncProvider><AppNavigator /></NativeSyncProvider>
      </AccountDatabase></NativeAccountProvider>
    </ThemeProvider>
  );
}
