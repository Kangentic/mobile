import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import type { ShortAuthenticationString } from '@kangentic/protocol';
import { usePairingStore } from '@/state/pairingStore';
import { PairingConfirmScreen } from '@/screens/PairingConfirmScreen';
import { overseerOneShotDurationMs } from '@/brand/overseerFrames.generated';
import { motionTokens } from '@/components/theme/tokens';

jest.mock('@/pairing/activePairing', () => ({
  confirmActivePairing: jest.fn().mockResolvedValue(undefined),
  rejectActivePairing: jest.fn(),
  resetActivePairing: jest.fn(),
}));

jest.mock('@/connection/connectionManager', () => ({
  reconnectNow: jest.fn(),
}));

// A stable replace mock (not a fresh jest.fn() per useRouter() call) so the
// success-hold test below can assert on it across the render.
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, back: jest.fn(), push: jest.fn() }),
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
    const { reconnectNow } = jest.requireMock<{ reconnectNow: jest.Mock }>('@/connection/connectionManager');
    usePairingStore.getState().setMachineState({
      status: 'awaiting-sas',
      sas: sasFixture('042917'),
    });

    render(<PairingConfirmScreen />);
    fireEvent.press(screen.getByTestId('sas-accept'));

    await waitFor(() => expect(confirmActivePairing).toHaveBeenCalledTimes(1));
    // A fresh pairing is not a goodbye to the OLD desktop - it must reconnect
    // silently, never announcing a departure. Asserting the NEGATIVE rather
    // than toHaveBeenCalledWith(): the latter pins arity, so it would redden
    // on an explicit reconnectNow('stay-silent') that means the same thing.
    expect(reconnectNow).toHaveBeenCalled();
    expect(reconnectNow).not.toHaveBeenCalledWith('announce-departure');
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

  /**
   * The success hold used to be a hand-typed literal; it is now derived
   * (wave-once's own published playback time plus the theme's "slow" motion
   * duration) so the wave animation and the navigation hold cannot drift
   * apart. That derivation is exactly the kind of change that can silently
   * regress with no test noticing, so this pins both the wiring (the screen
   * actually uses those two constants to gate router.replace) and the
   * resulting figure itself (920ms today).
   */
  it('replaces home only once the derived success hold elapses, not a moment before', async () => {
    jest.useFakeTimers();
    try {
      usePairingStore.getState().setMachineState({
        status: 'awaiting-sas',
        sas: sasFixture('042917'),
      });

      render(<PairingConfirmScreen />);
      await act(async () => {
        fireEvent.press(screen.getByTestId('sas-accept'));
      });

      const successHoldMs = overseerOneShotDurationMs['wave-once'] + motionTokens.durations.slow;
      // Pinned literal: a silent change to either input (the wave clip's
      // total, or the theme's slow duration) is exactly the drift this test
      // exists to catch, since it gates a route replace the user is mid
      // transition for.
      expect(successHoldMs).toBe(920);
      expect(mockReplace).not.toHaveBeenCalled();

      act(() => {
        jest.advanceTimersByTime(successHoldMs - 1);
      });
      expect(mockReplace).not.toHaveBeenCalled();

      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(mockReplace).toHaveBeenCalledWith('/');
      expect(mockReplace).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels the pending success-hold timer if the screen unmounts before it fires', async () => {
    jest.useFakeTimers();
    try {
      usePairingStore.getState().setMachineState({
        status: 'awaiting-sas',
        sas: sasFixture('042917'),
      });

      const { unmount } = render(<PairingConfirmScreen />);
      await act(async () => {
        fireEvent.press(screen.getByTestId('sas-accept'));
      });

      const successHoldMs = overseerOneShotDurationMs['wave-once'] + motionTokens.durations.slow;
      unmount();

      // A stray timer firing setState (or a route replace) after unmount is
      // exactly the class of bug the unmount cleanup effect exists to
      // prevent; advancing well past the hold must produce no navigation.
      act(() => {
        jest.advanceTimersByTime(successHoldMs + 1_000);
      });
      expect(mockReplace).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
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

  it('never claims success on the rejected state', () => {
    // The screen stays mounted for the whole pop transition after Cancel, and
    // Cancel drives the machine to 'rejected'. A success branch written as
    // "anything that is not awaiting-sas" therefore rendered "Pairing
    // complete." at the user who had just rejected a mismatched SAS - the one
    // answer the app's only defence against a relay-in-the-middle must never
    // give.
    usePairingStore.getState().setMachineState({ status: 'rejected' });

    render(<PairingConfirmScreen />);

    expect(screen.queryByText('Pairing complete.')).toBeNull();
    expect(screen.queryByTestId('pairing-success-overseer', HIDDEN)).toBeNull();
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
