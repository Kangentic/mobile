import { Platform } from 'react-native';
import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

/**
 * Android's `onTrimMemory`, which React Native does not surface, as a plain
 * subscription. See the Kotlin module for which trim levels count as pressure
 * and why `TRIM_MEMORY_UI_HIDDEN` deliberately does not.
 *
 * ANDROID ONLY, and absent rather than no-op on iOS: `AppState`'s
 * `memoryWarning` already covers iOS, and a second source there would
 * double-count the same episode into the breadcrumb's warning tally.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule`: this is a
 * local module, so it only exists in a build that ran prebuild with it present.
 * Jest and vitest load this file without any native runtime at all, and a
 * hard require would throw at import time in every test that touches the
 * observability door.
 */
interface MemoryPressureNativeModule {
  addListener: (
    eventName: 'onMemoryPressure',
    listener: (event: { level: number }) => void,
  ) => EventSubscription;
}

const nativeModule =
  Platform.OS === 'android' ? requireOptionalNativeModule<MemoryPressureNativeModule>('MemoryPressure') : null;

/** True when this build can actually observe Android memory pressure. */
export function isAndroidMemoryPressureAvailable(): boolean {
  return nativeModule !== null;
}

/**
 * Subscribes to OS memory pressure on Android. Returns a no-op unsubscribe
 * where the module is not present, so callers need no platform branch.
 */
export function addAndroidMemoryPressureListener(listener: (level: number) => void): () => void {
  if (nativeModule === null) return () => undefined;
  const subscription = nativeModule.addListener('onMemoryPressure', (event) => {
    listener(event.level);
  });
  return () => {
    subscription.remove();
  };
}
