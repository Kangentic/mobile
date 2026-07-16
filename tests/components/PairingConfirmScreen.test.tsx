import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react-native';
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

  it('renders the SAS digits and emoji for the user to confirm', () => {
    usePairingStore.getState().setMachineState({
      status: 'awaiting-sas',
      sas: { digits: '042917', emoji: ['🐝', '🚀', '🌙', '🍕', '🔥'] },
    });

    render(<PairingConfirmScreen />);

    expect(screen.getByTestId('sas-digits').props.children).toBe('042917');
    expect(screen.getByTestId('sas-accept')).toBeTruthy();
    expect(screen.getByTestId('sas-reject')).toBeTruthy();
  });

  it('calls confirmActivePairing when the user accepts', async () => {
    const { confirmActivePairing } = jest.requireMock<{ confirmActivePairing: jest.Mock }>('@/pairing/activePairing');
    usePairingStore.getState().setMachineState({
      status: 'awaiting-sas',
      sas: { digits: '042917', emoji: ['🐝', '🚀', '🌙', '🍕', '🔥'] },
    });

    render(<PairingConfirmScreen />);
    fireEvent.press(screen.getByTestId('sas-accept'));

    await waitFor(() => expect(confirmActivePairing).toHaveBeenCalledTimes(1));
  });

  it('calls rejectActivePairing when the user rejects', () => {
    const { rejectActivePairing } = jest.requireMock<{ rejectActivePairing: jest.Mock }>('@/pairing/activePairing');
    usePairingStore.getState().setMachineState({
      status: 'awaiting-sas',
      sas: { digits: '042917', emoji: ['🐝', '🚀', '🌙', '🍕', '🔥'] },
    });

    render(<PairingConfirmScreen />);
    fireEvent.press(screen.getByTestId('sas-reject'));

    expect(rejectActivePairing).toHaveBeenCalledTimes(1);
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
