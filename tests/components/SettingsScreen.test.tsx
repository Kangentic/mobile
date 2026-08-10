import React from 'react';
import { AppState, Platform, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

// Drives the AppState 'active' transition NotificationPermissionNotice listens
// for. Spied on the real AppState (registered in beforeEach) rather than
// mocked as a module: react-native re-exports it lazily, so replacing the
// module leaves the component with an undefined AppState.
const appStateListeners = new Set<(nextStatus: AppStateStatus) => void>();

function emitAppState(nextStatus: AppStateStatus): void {
  for (const listener of appStateListeners) listener(nextStatus);
}

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// The notifications barrel statically pulls notifee, which throws at import
// time without its native module; the screen only reads the status snapshot.
const mockOpenSystemNotificationSettings = jest.fn().mockResolvedValue(undefined);
const mockRefreshNotificationPermission = jest.fn().mockResolvedValue(true);
const mockNotificationPermissionGranted = jest.fn<boolean | null, []>().mockReturnValue(true);
jest.mock('@/notifications', () => ({
  getPushRegistrationStatus: jest.fn().mockReturnValue('not-connected'),
  notificationPermissionGranted: () => mockNotificationPermissionGranted(),
  openSystemNotificationSettings: () => mockOpenSystemNotificationSettings(),
  refreshNotificationPermission: () => mockRefreshNotificationPermission(),
}));

const mockResyncPushRegistrationCategories = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/connectionManager', () => ({
  resyncPushRegistrationCategories: () => mockResyncPushRegistrationCategories(),
}));

// Only the two crash triggers are stubbed; `crashTestEnabled` stays real so
// the visibility tests below still exercise the actual env gating. Stubbing
// matters here beyond assertion convenience: the real `crashNatively` calls
// `Sentry.nativeCrash()`, and the real `throwTestError` schedules a throw on
// a timer that would surface as an unhandled error in a later test.
const mockThrowTestError = jest.fn();
const mockCrashNatively = jest.fn();
jest.mock('@/observability/crashReporting', () => ({
  ...jest.requireActual('@/observability/crashReporting'),
  throwTestError: () => mockThrowTestError(),
  crashNatively: () => mockCrashNatively(),
}));

function renderSettings(): void {
  render(
    <ThemeProvider>
      <SettingsScreen />
    </ThemeProvider>,
  );
}

function setCrashTestFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.EXPO_PUBLIC_KANGENTIC_CRASHTEST;
  else process.env.EXPO_PUBLIC_KANGENTIC_CRASHTEST = value;
}

describe('SettingsScreen', () => {
  const originalCrashTestFlag = process.env.EXPO_PUBLIC_KANGENTIC_CRASHTEST;

  beforeEach(() => {
    mockPush.mockClear();
    useSettingsStore.setState({
      dictationMode: 'auto-send',
      hasSeenSessionModeHint: false,
      hapticsEnabled: true,
      backgroundNotificationsMode: 'foreground-service',
      pushCategoriesEnabled: {
        'input-required': true,
        'turn-complete': true,
        'session-failed': true,
        'plan-complete': true,
        'spawn-stalled': true,
      },
      // The steady state for these tests: the app has already asked for
      // POST_NOTIFICATIONS at some point. The never-asked case is a distinct
      // branch of the blocked notice and has its own test below.
      hasRequestedNotificationPermission: true,
      hydrated: true,
    });
    useChannelStore.setState({ pairedState: 'paired', transportState: 'connected', established: true, relayUrl: 'ws://127.0.0.1:8080' });
    setCrashTestFlag(undefined);
    mockThrowTestError.mockClear();
    mockCrashNatively.mockClear();
    mockOpenSystemNotificationSettings.mockClear();
    mockRefreshNotificationPermission.mockClear();
    mockRefreshNotificationPermission.mockResolvedValue(true);
    mockNotificationPermissionGranted.mockReturnValue(true);
    appStateListeners.clear();
    // Re-installed fresh every test (idempotent over jest.spyOn), never
    // restored in afterEach: restoring here would strip every OTHER mock in
    // this file too (jest.restoreAllMocks() is global, not scoped to this
    // one spy), which the next test's own beforeEach reconfiguration would
    // mask today but is exactly the kind of setup a later test could rely on
    // without re-declaring.
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener): NativeEventSubscription => {
      const appStateListener = listener as (nextStatus: AppStateStatus) => void;
      appStateListeners.add(appStateListener);
      return { remove: () => appStateListeners.delete(appStateListener) } as unknown as NativeEventSubscription;
    });
  });

  afterEach(() => {
    setCrashTestFlag(originalCrashTestFlag);
  });

  it('renders the connection section with live status and relay', () => {
    renderSettings();
    expect(screen.getByTestId('settings-connection-label').props.children).toBe('Connected');
    expect(screen.getByTestId('settings-relay-url')).toBeTruthy();
  });

  it('navigates to the devices screen from the paired-devices row', () => {
    renderSettings();
    fireEvent.press(screen.getByTestId('settings-devices-row'));
    expect(mockPush).toHaveBeenCalledWith('/devices');
  });

  it('persists the background notifications mode selection', () => {
    renderSettings();
    fireEvent.press(screen.getByTestId('settings-notifications-push-only'));
    expect(useSettingsStore.getState().backgroundNotificationsMode).toBe('push-only');
  });

  /**
   * The notice is the only recovery path once Android has stopped showing the
   * runtime prompt, so it must appear on a denial and stay out of the way
   * otherwise - a permanently-visible warning would train the user past it.
   *
   * Branches on the platform because jest.config.js runs this file under BOTH
   * the ios and android projects, and the divergence is the point: the whole
   * notification display stack is Android-only, so iOS must not read a
   * permission at all, let alone tell the user one is blocked.
   */
  it('offers a route to system settings when the notification permission is denied', () => {
    mockNotificationPermissionGranted.mockReturnValue(false);
    renderSettings();

    if (Platform.OS !== 'android') {
      expect(screen.queryByTestId('settings-open-notification-settings')).toBeNull();
      return;
    }

    fireEvent.press(screen.getByTestId('settings-open-notification-settings'));
    expect(mockOpenSystemNotificationSettings).toHaveBeenCalledTimes(1);
  });

  /**
   * The cache is seeded once at mount and otherwise never updates on its own,
   * so returning from the system settings screen (which fires AppState
   * 'active') is the only moment a grant made outside the app becomes visible
   * here. Without this listener, a user who grants POST_NOTIFICATIONS from
   * system settings and comes back would see "Notifications are blocked"
   * forever, with nothing left to re-check and clear it.
   */
  it('clears the blocked notice once the permission reads back granted after returning to the app', async () => {
    mockNotificationPermissionGranted.mockReturnValue(false);
    renderSettings();

    if (Platform.OS !== 'android') {
      // iOS never registers the listener at all; the notice never appears
      // regardless of the cache, which the test above already covers.
      expect(screen.queryByTestId('settings-open-notification-settings')).toBeNull();
      return;
    }

    expect(screen.getByTestId('settings-open-notification-settings')).toBeTruthy();

    mockRefreshNotificationPermission.mockResolvedValue(true);
    act(() => {
      emitAppState('active');
    });

    await waitFor(() => expect(screen.queryByTestId('settings-open-notification-settings')).toBeNull());
    expect(mockRefreshNotificationPermission).toHaveBeenCalledTimes(1);
  });

  it('hides the blocked-notifications notice when the permission is granted or unknown', () => {
    renderSettings();
    expect(screen.queryByTestId('settings-open-notification-settings')).toBeNull();

    // null is "nothing has looked yet", which must read as unknown rather than
    // as a denial - otherwise every cold start flashes a blocked warning.
    mockNotificationPermissionGranted.mockReturnValue(null);
    renderSettings();
    expect(screen.queryByTestId('settings-open-notification-settings')).toBeNull();
  });

  /**
   * The cache reads `false` on any install that has not granted the permission,
   * including one that was never asked: Android has no NOT_DETERMINED status,
   * so notifee reports plain DENIED, and initializeNotifications seeds the
   * cache at boot. Keying the notice on the cache alone therefore told a
   * brand-new user "Notifications are blocked" before the app had ever asked
   * them, and offered a trip to system settings as the fix.
   */
  it('does not claim notifications are blocked before the app has ever asked', () => {
    mockNotificationPermissionGranted.mockReturnValue(false);
    useSettingsStore.setState({ hasRequestedNotificationPermission: false });
    renderSettings();

    expect(screen.queryByTestId('settings-open-notification-settings')).toBeNull();
  });

  it('flips the haptics toggle', () => {
    renderSettings();
    fireEvent.press(screen.getByTestId('settings-haptics-toggle'));
    expect(useSettingsStore.getState().hapticsEnabled).toBe(false);
  });

  it('keeps the dictation radios working', () => {
    renderSettings();
    fireEvent.press(screen.getByTestId('settings-dictation-off'));
    expect(useSettingsStore.getState().dictationMode).toBe('off');
  });

  it('toggles a push category without disturbing the others', () => {
    renderSettings();
    fireEvent.press(screen.getByTestId('settings-category-spawn-stalled'));
    expect(useSettingsStore.getState().pushCategoriesEnabled).toEqual({
      'input-required': true,
      'turn-complete': true,
      'session-failed': true,
      'plan-complete': true,
      'spawn-stalled': false,
    });
  });

  it('resyncs the desktop registration when a category toggle changes', async () => {
    renderSettings();
    fireEvent.press(screen.getByTestId('settings-category-spawn-stalled'));
    // waitFor, not a bare `await fireEvent.press`: the resync fires after
    // setPushCategoryEnabled's awaited SecureStore write resolves, so a
    // single-microtask await couples this assertion to the exact number of
    // promise hops in the implementation and goes red on a harmless refactor.
    await waitFor(() => expect(mockResyncPushRegistrationCategories).toHaveBeenCalled());
  });

  it('round-trips a category switch off then on, on both the store and the row accessibilityState', () => {
    renderSettings();
    // SwitchRow's inner native Switch is presentational (pointerEvents="none",
    // hidden from the a11y tree); the wrapping Pressable owns the switch
    // role AND accessibilityState, so assert against the element carrying
    // the testID, not a nested Switch node.
    const row = screen.getByTestId('settings-category-spawn-stalled');
    expect(row.props.accessibilityState.checked).toBe(true);

    fireEvent.press(row);
    expect(useSettingsStore.getState().pushCategoriesEnabled['spawn-stalled']).toBe(false);
    expect(screen.getByTestId('settings-category-spawn-stalled').props.accessibilityState.checked).toBe(false);

    fireEvent.press(screen.getByTestId('settings-category-spawn-stalled'));
    expect(useSettingsStore.getState().pushCategoriesEnabled['spawn-stalled']).toBe(true);
    expect(screen.getByTestId('settings-category-spawn-stalled').props.accessibilityState.checked).toBe(true);
  });

  it('hides the crash-test section by default', () => {
    renderSettings();
    expect(screen.queryByTestId('settings-section-crash-test')).toBeNull();
    expect(screen.queryByTestId('settings-crash-test-js')).toBeNull();
    expect(screen.queryByTestId('settings-crash-test-native')).toBeNull();
  });

  it('reveals the crash-test rows only when EXPO_PUBLIC_KANGENTIC_CRASHTEST is "1"', () => {
    setCrashTestFlag('1');
    renderSettings();
    expect(screen.getByTestId('settings-section-crash-test')).toBeTruthy();
    expect(screen.getByTestId('settings-crash-test-js')).toBeTruthy();
    expect(screen.getByTestId('settings-crash-test-native')).toBeTruthy();
  });

  // Visibility alone would still pass with the two handlers swapped, which is
  // the one mistake that makes the whole affordance lie: the row labelled
  // "Crash natively" is the only way to exercise the path a JS `beforeSend`
  // cannot filter, so wiring it to the JS throw would silently verify nothing.
  it('wires each crash-test row to its own trigger', () => {
    setCrashTestFlag('1');
    renderSettings();

    fireEvent.press(screen.getByTestId('settings-crash-test-js'));
    expect(mockThrowTestError).toHaveBeenCalledTimes(1);
    expect(mockCrashNatively).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('settings-crash-test-native'));
    expect(mockCrashNatively).toHaveBeenCalledTimes(1);
    expect(mockThrowTestError).toHaveBeenCalledTimes(1);
  });
});
