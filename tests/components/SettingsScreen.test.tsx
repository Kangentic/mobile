import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
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

function renderSettings(): void {
  render(
    <ThemeProvider>
      <SettingsScreen />
    </ThemeProvider>,
  );
}

describe('SettingsScreen', () => {
  beforeEach(() => {
    mockPush.mockClear();
    useSettingsStore.setState({
      dictationMode: 'auto-send',
      hasSeenSessionModeHint: false,
      hapticsEnabled: true,
      backgroundNotificationsMode: 'foreground-service',
      hydrated: true,
    });
    useChannelStore.setState({ pairedState: 'paired', transportState: 'connected', established: true, relayUrl: 'ws://127.0.0.1:8080' });
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
});
