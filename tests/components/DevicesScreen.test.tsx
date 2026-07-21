import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { DevicesScreen } from '@/screens/DevicesScreen';
import { useChannelStore } from '@/state/channelStore';
import type { PairedDesktopInfoState } from '@/screens/usePairedDesktopInfo';

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: mockBack, push: jest.fn() }),
}));

let mockPairedState: PairedDesktopInfoState = { status: 'loading' };
jest.mock('@/screens/usePairedDesktopInfo', () => {
  const actual = jest.requireActual('@/screens/usePairedDesktopInfo');
  return {
    __esModule: true,
    usePairedDesktopInfo: () => mockPairedState,
    formatKeyFingerprint: actual.formatKeyFingerprint,
  };
});

const mockClear = jest.fn().mockResolvedValue(undefined);
jest.mock('@/pairing/trustAnchor', () => ({
  // The arrow defers the mockClear read past import-time hoisting.
  TrustAnchorStore: jest.fn().mockImplementation(() => ({ clear: () => mockClear() })),
}));

const mockReconnectNow = jest.fn();
const mockRevokePushRegistrationForUnpair = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/connectionManager', () => ({
  reconnectNow: () => mockReconnectNow(),
  revokePushRegistrationForUnpair: () => mockRevokePushRegistrationForUnpair(),
}));

function renderDevices(): void {
  render(
    <ThemeProvider>
      <DevicesScreen />
    </ThemeProvider>,
  );
}

describe('DevicesScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useChannelStore.setState({ pairedState: 'paired', transportState: 'connected', established: true, relayUrl: 'ws://127.0.0.1:8080' });
    mockPairedState = {
      status: 'paired',
      info: {
        desktopPublicKeyHex: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        relayAddress: 'ws://127.0.0.1:8080',
        pairedAt: '2026-07-14T00:00:00.000Z',
        phonePublicKeyHex: '1122334455667788990011223344556677889900112233445566778899001122',
      },
    };
  });

  it('renders the paired-desktop and this-phone cards with fingerprints', () => {
    renderDevices();
    expect(screen.getByTestId('devices-desktop-fingerprint').props.children).toBe('a1b2 c3d4 e5f6 0718');
    expect(screen.getByTestId('devices-phone-fingerprint').props.children).toBe('1122 3344 5566 7788');
    expect(screen.getByTestId('devices-connection-dot')).toBeTruthy();
  });

  it('unpairs only after the two-step confirm, clearing the anchor and reconnecting', async () => {
    renderDevices();
    fireEvent.press(screen.getByTestId('devices-unpair'));
    expect(mockClear).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByTestId('devices-unpair-confirm'));
    });
    expect(mockRevokePushRegistrationForUnpair).toHaveBeenCalled();
    expect(mockClear).toHaveBeenCalled();
    expect(mockReconnectNow).toHaveBeenCalled();
    expect(mockBack).toHaveBeenCalled();
    // Push revocation happens BEFORE the trust anchor is cleared, while the
    // channel (and thus the desktop connection to send "unregister" over)
    // is still up.
    expect(mockRevokePushRegistrationForUnpair.mock.invocationCallOrder[0]).toBeLessThan(mockClear.mock.invocationCallOrder[0]);
  });

  it('shows the pairing CTA when nothing is paired', () => {
    mockPairedState = { status: 'unpaired' };
    renderDevices();
    expect(screen.getByTestId('devices-pair-cta')).toBeTruthy();
  });
});
