import React from 'react';
import { Tabs } from 'expo-router';
import { House, SquareKanban } from 'lucide-react-native';
import { useTheme } from '@/components';

/**
 * Bottom tabs: Home (attention feed) and Board. Screens render their own
 * AppHeader (brandmark + title + settings), so the native header stays off.
 */
export default function TabsLayout(): React.JSX.Element {
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        // No fixed height: the navigator adds the gesture-nav inset itself.
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          paddingTop: 6,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarButtonTestID: 'home-tab',
          tabBarIcon: ({ focused, color }) => (
            <House size={22} color={color} strokeWidth={focused ? 2.4 : 1.8} />
          ),
        }}
      />
      <Tabs.Screen
        name="board"
        options={{
          title: 'Board',
          tabBarButtonTestID: 'board-tab',
          tabBarIcon: ({ focused, color }) => (
            <SquareKanban size={22} color={color} strokeWidth={focused ? 2.4 : 1.8} />
          ),
        }}
      />
    </Tabs>
  );
}
