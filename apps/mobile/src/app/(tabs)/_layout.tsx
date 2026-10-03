import { SymbolView } from 'expo-symbols';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';

import { fonts, palette } from '@/theme';

function TabIcon({ name, color }: {
  name: 'heart.fill' | 'person.2.fill' | 'bell.fill';
  color: ColorValue;
}) {
  return <SymbolView name={name} tintColor={color} size={21} />;
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: palette.canvas },
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.faint,
        tabBarStyle: {
          backgroundColor: palette.surface,
          borderTopColor: palette.line,
          height: 86,
          paddingTop: 8,
          paddingBottom: 22,
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
        name="reminders"
        options={{
          title: 'Reminders',
          tabBarAccessibilityLabel: 'Reminders',
          tabBarIcon: ({ color }) => <TabIcon name="bell.fill" color={color} />,
        }}
      />
    </Tabs>
  );
}
