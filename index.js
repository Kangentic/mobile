// Must be the true first import: this module's own evaluation IS the
// cold-launch clock origin the connection trace measures from (see its
// docstring and docs/developer-guide.md's cold-launch section). In a build
// without EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE set, its body is dead code
// and this import costs nothing beyond the module load itself.
import './src/devsupport/connectionTrace';
import './src/lib/cryptoPolyfills';
import { initializeCrashReporting } from './src/observability/crashReporting';
import { initializeMemoryPressure } from './src/observability/memoryPressure';
import { registerMemoryShedders } from './src/state/memoryShed';
import { initializeNotifications } from './src/notifications';
import 'expo-router/entry';

// Bundle-entry scope, outside React: the notifee background event handler
// and the expo-notifications background task must be registered here so
// they exist in headless (killed-app) task launches too. Runs after the
// imports above evaluate but before anything renders.
//
// Crash reporting goes first so that a throw from any later initializer is
// itself reported. It cannot go earlier than this: ES imports are hoisted
// and evaluate in source order, so `expo-router/entry` has already been
// evaluated by the time any statement here runs. That is the same window
// initializeNotifications() has always had, and it closes before anything
// renders. A crash strictly before this point (native startup, bundle
// evaluation) needs Sentry's native-init path, which this app does not use.
// No-ops entirely when EXPO_PUBLIC_SENTRY_DSN is unset, which is every
// build made from source - see src/observability/crashReporting.ts.
initializeCrashReporting();
// Immediately after, and outside React on purpose. iOS warns before it kills
// a foreground app for memory, and the episode behind Sentry MOBILE-8 fit
// inside about 23 seconds of launch - a listener that armed when a screen
// mounted could miss one entirely. Unlike its neighbour this still arms
// without a DSN: the shedding half is robustness, not reporting.
initializeMemoryPressure();
registerMemoryShedders();
initializeNotifications();
