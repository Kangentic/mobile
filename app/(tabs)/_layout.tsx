import React from 'react';
import { Tabs } from 'expo-router';
import { AppTabBar } from '@/components/navigation/AppTabBar';

/**
 * Bottom tabs: Home (attention feed) and Board. Screens render their own
 * AppHeader (brandmark + title + settings) and the bar is the custom
 * AppTabBar (active pill, needs-you dot), so native chrome stays off.
 */
export default function TabsLayout(): React.JSX.Element {
  return (
    <Tabs
      tabBar={(tabBarProps) => <AppTabBar {...tabBarProps} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarButtonTestID: 'home-tab' }} />
      <Tabs.Screen name="board" options={{ title: 'Board', tabBarButtonTestID: 'board-tab' }} />
    </Tabs>
  );
}
