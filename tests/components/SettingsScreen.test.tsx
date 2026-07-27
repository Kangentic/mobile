import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// The notifications barrel statically pulls notifee, which throws at import
// time without its native module; the screen only reads the status snapshot.
jest.mock('@/notifications', () => ({
  getPushRegistrationStatus: jest.fn().mockReturnValue('not-connected'),
}));

const mockResyncPushRegistrationCategories = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/connectionManager', () => ({
  resyncPushRegistrationCategories: () => mockResyncPushRegistrationCategories(),
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
      hydrated: true,
    });
    useChannelStore.setState({ pairedState: 'paired', transportState: 'connected', established: true, relayUrl: 'ws://127.0.0.1:8080' });
    setCrashTestFlag(undefined);
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
});
