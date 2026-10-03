import { DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { SQLiteProvider } from 'expo-sqlite';
import { useEffect } from 'react';

import { migrateDatabase } from '@/data/database';
import { MOBILE_DATABASE_NAME } from '@/data/schema';
import '@/native/notifications';
import { fonts, palette } from '@/theme';

void SplashScreen.preventAutoHideAsync();

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
  useEffect(() => {
    void SplashScreen.hideAsync();

    function openNotification(notification: Notifications.Notification) {
      const url = notification.request.content.data?.url;
      if (typeof url === 'string' && /^\/contacts\/[a-f0-9-]+$/i.test(url)) {
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
  }, []);

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
      <Stack.Screen
        name="contacts/new"
        options={{ presentation: 'modal', title: 'Add someone' }}
      />
      <Stack.Screen name="contacts/[id]" options={{ title: '' }} />
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
      <SQLiteProvider databaseName={MOBILE_DATABASE_NAME} onInit={migrateDatabase}>
        <AppNavigator />
      </SQLiteProvider>
    </ThemeProvider>
  );
}
