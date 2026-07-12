import React from 'react';
import { Pressable } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { Icon, useTheme } from '@/components';

export default function TabsLayout(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();

  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.textPrimary,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border },
        headerRight: () => (
          <Pressable
            testID="header-settings-button"
            accessibilityRole="button"
            onPress={() => router.push('/settings')}
            style={{
              minWidth: theme.minTouchSize,
              minHeight: theme.minTouchSize,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="settings-outline" color="secondary" />
          </Pressable>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarButtonTestID: 'home-tab',
          tabBarIcon: ({ focused, size }) => <Icon name="home" color={focused ? 'accent' : 'muted'} size={size} />,
        }}
      />
      <Tabs.Screen
        name="board"
        options={{
          title: 'Board',
          tabBarButtonTestID: 'board-tab',
          tabBarIcon: ({ focused, size }) => <Icon name="grid" color={focused ? 'accent' : 'muted'} size={size} />,
        }}
      />
    </Tabs>
  );
}
