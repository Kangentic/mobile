import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import type { ShortAuthenticationString } from '@kangentic/protocol';
import { usePairingStore } from '@/state/pairingStore';
import { PairingConfirmScreen } from '@/screens/PairingConfirmScreen';

jest.mock('@/pairing/activePairing', () => ({
  confirmActivePairing: jest.fn().mockResolvedValue(undefined),
  rejectActivePairing: jest.fn(),
  resetActivePairing: jest.fn(),
}));

jest.mock('@/connection/connectionManager', () => ({
  reconnectNow: jest.fn(),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn() }),
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

const mockNotificationAsync = jest.mocked(Haptics.notificationAsync);

// The Overseer subtree is hidden from accessibility (decorative art), which
// also hides it from default RNTL queries.
const HIDDEN = { includeHiddenElements: true } as const;

/**
 * The SAS is digits, full stop: the emoji row was removed from the screen, and
 * the desktop shows digits too. The protocol's ShortAuthenticationString still
 * declares `emoji` as required, so fixtures have to carry the field - but they
 * carry it EMPTY rather than inventing five emoji no screen renders, which
 * reads as though an emoji confirmation still exists somewhere.
 *
 * Dropping the field for real is a change to @kangentic/protocol's sas.ts, not
 * something this repo can do locally.
 */
function sasFixture(digits: string): ShortAuthenticationString {
  return { digits, emoji: [] };
}

describe('PairingConfirmScreen', () => {
  beforeEach(() => {
    // The screen's abandon-on-unmount effect fires a rejectActivePairing on
    // each prior test's cleanup; clear call counts right before each test so
    // its assertions see only its own interactions.
    jest.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    usePairingStore.getState().reset();
  });

  it('renders the SAS digits with both a confirm and a cancel action (no emoji row)', () => {
    usePairingStore.getState().setMachineState({
      status: 'awaiting-sas',
      sas: sasFixture('042917'),
    });

    render(<PairingConfirmScreen />);

    expect(screen.getByTestId('sas-digits').props.children).toBe('042917');
    expect(screen.getByTestId('sas-accept')).toBeTruthy();
    // The digits carry the whole SAS; the emoji rendering was redundant.
    expect(screen.queryByTestId('sas-emoji')).toBeNull();
    // A mismatch is the one thing this screen exists to catch, so it gets an
    // explicit control. The unmount effect still rejects on a back-swipe, but
    // requiring the user to INFER that leaving is the safe move is the wrong
    // interface for the app's only defence against a relay-in-the-middle.
    expect(screen.getByTestId('sas-reject')).toBeTruthy();
  });

  it('rejects the ceremony when the user cancels on a mismatch', () => {
    const { rejectActivePairing } = jest.requireMock<{ rejectActivePairing: jest.Mock }>('@/pairing/activePairing');
    usePairingStore.getState().setMachineState({
      status: 'awaiting-sas',
      sas: sasFixture('042917'),
    });

    render(<PairingConfirmScreen />);
    fireEvent.press(screen.getByTestId('sas-reject'));

    expect(rejectActivePairing).toHaveBeenCalled();
  });

  it('calls confirmActivePairing when the user accepts', async () => {
    const { confirmActivePairing } = jest.requireMock<{ confirmActivePairing: jest.Mock }>('@/pairing/activePairing');
    usePairingStore.getState().setMachineState({
      status: 'awaiting-sas',
      sas: sasFixture('042917'),
    });

    render(<PairingConfirmScreen />);
    fireEvent.press(screen.getByTestId('sas-accept'));

    await waitFor(() => expect(confirmActivePairing).toHaveBeenCalledTimes(1));
  });

  it('calls rejectActivePairing when the user leaves without confirming', () => {
    const { rejectActivePairing } = jest.requireMock<{ rejectActivePairing: jest.Mock }>('@/pairing/activePairing');
    usePairingStore.getState().setMachineState({
      status: 'awaiting-sas',
      sas: sasFixture('042917'),
    });

    // Backing out (gesture, header back, tab switch) unmounts the screen -
    // that IS the rejection now that the explicit button is gone, and it
    // must still tear down the PairingMachine and its relay socket.
    render(<PairingConfirmScreen />).unmount();

    expect(rejectActivePairing).toHaveBeenCalledTimes(1);
  });

  it('fires the pairingSucceeded haptic once the accept completes', async () => {
    usePairingStore.getState().setMachineState({
      status: 'awaiting-sas',
      sas: sasFixture('042917'),
    });

    render(<PairingConfirmScreen />);
    fireEvent.press(screen.getByTestId('sas-accept'));

    await waitFor(() => expect(mockNotificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success));
  });

  it('shows the blinking Overseer while connecting', () => {
    usePairingStore.getState().setMachineState({ status: 'connecting' });

    render(<PairingConfirmScreen />);

    expect(screen.getByText('Connecting to the desktop...')).toBeTruthy();
    expect(screen.getByTestId('pairing-connecting-overseer', HIDDEN)).toBeTruthy();
  });

  it('shows the waving Overseer on the paired success state', () => {
    usePairingStore.getState().setMachineState({ status: 'paired' });

    render(<PairingConfirmScreen />);

    expect(screen.getByText('Pairing complete.')).toBeTruthy();
    expect(screen.getByTestId('pairing-success-overseer', HIDDEN)).toBeTruthy();
  });

  it('shows the error message and no SAS controls on a handshake failure', () => {
    usePairingStore.getState().setMachineState({
      status: 'error',
      errorKind: 'handshake-failed',
      message: 'Pairing failed to authenticate. Rescan the code and try again.',
    });

    render(<PairingConfirmScreen />);

    expect(screen.getByText('Pairing failed to authenticate. Rescan the code and try again.')).toBeTruthy();
    expect(screen.queryByTestId('sas-accept')).toBeNull();
  });
});
