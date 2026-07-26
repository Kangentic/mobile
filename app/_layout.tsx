import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { ThemeProvider, useTheme } from '@/components';
import { startConnectionLifecycle } from '@/connection/connectionManager';
import { initializeNotifications } from '@/notifications';
import { useSettingsStore } from '@/state/settingsStore';

// Hold the native splash until settings hydrate, then fade it out instead
// of the default hard cut - the brand mark hands off to the themed UI.
SplashScreen.preventAutoHideAsync().catch(() => {
  // Already hidden (fast refresh): nothing to hold.
});
SplashScreen.setOptions({ fade: true, duration: 220 });

// Dev-only inspect loop: the route probe mirrors the current router
// location for `mobileInspect state route`. The compile-time-false gate in
// production strips the lazy module from the bundle entirely.
const LazyInspectRouteProbe =
  __DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_INSPECT === '1'
    ? React.lazy(() => import('@/devsupport/InspectRouteProbe'))
    : null;

export default function RootLayout(): React.JSX.Element {
  useEffect(() => {
    // Idempotent backstop: the real registration point is index.js (entry
    // scope, outside React, present in headless launches too).
    initializeNotifications();
    startConnectionLifecycle();
    void useSettingsStore
      .getState()
      .hydrate()
      .finally(() => {
        void SplashScreen.hideAsync().catch(() => undefined);
      });
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
  /**
   * Shared options for every sheet in the app. NATIVE form sheets, not
   * hand-rolled Modals: the platform owns the presentation, the backdrop and
   * keyboard avoidance, so there is no translucent-Dialog window whose insets
   * can land a frame late (which is what made the old custom sheet open one
   * tab-bar-height off the bottom until the keyboard forced a relayout).
   *
   * 'fitToContents' sizes the sheet to its form, so nothing inside may use
   * flex: 1. Android form sheets render no native header, so each screen puts
   * its own title in content.
   */
  const formSheetOptions = {
    presentation: 'formSheet',
    headerShown: false,
    sheetAllowedDetents: 'fitToContents',
    sheetCornerRadius: theme.radii.lg,
    sheetGrabberVisible: true,
  } as const;
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
        <Stack.Screen name="create-task" options={formSheetOptions} />
        <Stack.Screen name="move-task" options={formSheetOptions} />
        <Stack.Screen name="edit-task" options={formSheetOptions} />
        <Stack.Screen name="project-picker" options={formSheetOptions} />
        <Stack.Screen name="task-actions" options={formSheetOptions} />
        {/* Renders its own TaskHeader, exactly as the session screen does, so the
            two kinds of task open into the same chrome. */}
        <Stack.Screen name="completed-task" options={{ headerShown: false }} />
        <Stack.Screen name="file-diff" options={{ title: 'Changes' }} />
        <Stack.Screen name="pair" options={{ title: 'Pair a device' }} />
        <Stack.Screen name="pair-confirm" options={{ title: 'Confirm pairing' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="devices" options={{ title: 'Paired devices' }} />
      </Stack>
    </>
  );
}
