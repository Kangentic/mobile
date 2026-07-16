import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Stack } from 'expo-router';
import { ThemeProvider, useTheme } from '@/components';
import { startConnectionLifecycle } from '@/connection/connectionManager';
import { useSettingsStore } from '@/state/settingsStore';

// Dev-only inspect loop: the route probe mirrors the current router
// location for `mobileInspect state route`. The compile-time-false gate in
// production strips the lazy module from the bundle entirely.
const LazyInspectRouteProbe =
  __DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_INSPECT === '1'
    ? React.lazy(() => import('@/devsupport/InspectRouteProbe'))
    : null;

export default function RootLayout(): React.JSX.Element {
  useEffect(() => {
    startConnectionLifecycle();
    void useSettingsStore.getState().hydrate();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <RootStack />
          {LazyInspectRouteProbe ? (
            <React.Suspense fallback={null}>
              <LazyInspectRouteProbe />
            </React.Suspense>
          ) : null}
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function RootStack(): React.JSX.Element {
  const theme = useTheme();
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.surface },
          headerTintColor: theme.colors.textPrimary,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="task/[taskId]/index" options={{ headerShown: false }} />
        <Stack.Screen name="task/[taskId]/changes" options={{ headerShown: false }} />
        <Stack.Screen name="file-diff" options={{ title: 'Changes' }} />
        <Stack.Screen name="pair" options={{ title: 'Pair a device' }} />
        <Stack.Screen name="pair-confirm" options={{ title: 'Confirm pairing' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="devices" options={{ title: 'Paired devices' }} />
      </Stack>
    </>
  );
}
