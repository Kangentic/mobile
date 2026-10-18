import { AppState, Platform } from 'react-native';

/**
 * Runs `work` now, EXCEPT in an iOS process the OS launched in the background,
 * where it waits for the first time the app comes to the front.
 *
 * Why that one case: since the app gained the `remote-notification` background
 * mode (sealed clears, protocol 0.23.0), iOS can launch the whole app, root
 * layout included, to deliver a `content-available` push, and very often while
 * the phone is LOCKED. Every Keychain item stored `WHEN_UNLOCKED` is unreadable
 * then, and expo-secure-store throws rather than returning null. Boot work that
 * reads one would see a failure where there is data: settingsStore.hydrate()
 * turns each failed read into its default, so the next connection would
 * register the DEFAULT push categories with the desktop and the next toggle
 * would persist defaults over the user's choices. Deferring is enough, because
 * nothing in a background launch needs those values (the connection opens only
 * on 'active' too, connectionManager.ts), and the app is unlocked by the time
 * it is in front.
 *
 * Android is never deferred: its killed-app push path is a headless task that
 * mounts no React at all, and its AppState can read 'background' during an
 * ordinary cold start. An iOS 'inactive' launch (the ordinary one, mid
 * `didFinishLaunching`) runs at once.
 *
 * Returns a cancel for a deferred run; a no-op once it has run.
 */
export function runWhenFirstActive(work: () => void): () => void {
  if (Platform.OS !== 'ios' || AppState.currentState !== 'background') {
    work();
    return () => {};
  }
  const subscription = AppState.addEventListener('change', (status) => {
    if (status !== 'active') return;
    subscription.remove();
    work();
  });
  return () => subscription.remove();
}
