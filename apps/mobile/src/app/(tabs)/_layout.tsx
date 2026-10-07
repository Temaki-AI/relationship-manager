import { SymbolView } from 'expo-symbols';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fonts, palette } from '@/theme';

function TabIcon({ name, color }: {
  name: 'heart.fill' | 'person.2.fill' | 'gearshape' | 'calendar';
  color: ColorValue;
}) {
  return <SymbolView name={name} tintColor={color} size={21} />;
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: palette.canvas },
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.muted,
        tabBarStyle: {
          backgroundColor: palette.surface,
          borderTopColor: palette.line,
          height: 56 + Math.max(insets.bottom, 8),
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 8),
        },
        tabBarLabelStyle: { fontFamily: fonts.bodyDemi, fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Today',
          tabBarAccessibilityLabel: 'Today',
          tabBarIcon: ({ color }) => <TabIcon name="heart.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="people"
        options={{
          title: 'People',
          tabBarAccessibilityLabel: 'People',
          tabBarIcon: ({ color }) => <TabIcon name="person.2.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="agenda"
        options={{ title: 'Calendar', tabBarAccessibilityLabel: 'Calendar', tabBarIcon: ({ color }) => <TabIcon name="calendar" color={color} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarAccessibilityLabel: 'Settings',
          tabBarIcon: ({ color }) => <TabIcon name="gearshape" color={color} />,
        }}
      />
    </Tabs>
  );
}
