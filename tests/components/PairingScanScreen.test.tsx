import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react-native';
import { encodePairingQrPayload, PROTOCOL_VERSION } from '@kangentic/protocol';
import { PairingScanScreen } from '@/screens/PairingScanScreen';

jest.mock('@/pairing/activePairing', () => ({
  beginPairing: jest.fn().mockResolvedValue(undefined),
}));

// Hoisted once: no resetModules in jest.config.js, so this reference stays
// live for the whole file. clearAllMocks() in beforeEach clears call history
// in place rather than swapping in a new fn, so the reference never goes
// stale across tests.
const { beginPairing } = jest.requireMock<{ beginPairing: jest.Mock }>('@/pairing/activePairing');

// Separate mocks per verb: the screen's choice of navigate over push is
// load-bearing (navigate dedupes onto an existing route; push would stack a
// duplicate confirm screen; replace would drop this screen from the stack
// and break the confirm screen's "Go back"-to-rescan path), so the tests pin
// the exact verb rather than treating push/navigate as interchangeable.
const mockNavigate = jest.fn();
const mockPush = jest.fn();

// Captures the screen's focus effect so a test can replay it, simulating the
// native stack popping back to this still-mounted screen ("Go back" from the
// confirm screen after a failed ceremony).
const mockLatestFocusEffect: { current: (() => void | (() => void)) | null } = { current: null };

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: mockNavigate, back: jest.fn(), replace: jest.fn() }),
  useFocusEffect: (effect: () => void | (() => void)) => {
    mockLatestFocusEffect.current = effect;
    // This approximates real focus-regain by re-running the effect whenever
    // its identity changes (useEffect(effect, [effect])), which relies on
    // the screen wrapping its focus callback in useCallback with stable
    // deps - true here, since setPairingInFlight is itself a stable
    // useCallback. That automatic re-run only covers identity changes across
    // renders; tests replay an actual focus-regain explicitly by calling
    // mockLatestFocusEffect.current().
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
    require('react').useEffect(effect, [effect]);
  },
}));

interface MockCameraViewProps {
  testID?: string;
  onBarcodeScanned?: (scanningResult: { data: string }) => void;
}

// The screen calls useCameraPermissions on every render branch (and renders
// nothing at all without a permission object), so this mock is load-bearing
// even for tests that never touch the camera. The CameraView stub captures
// its latest props so tests can drive onBarcodeScanned directly - the same
// entry point the real ~30fps barcode stream uses.
const mockCameraPermission = { granted: false };
const mockLatestCameraViewProps: { current: MockCameraViewProps | null } = { current: null };

jest.mock('expo-camera', () => ({
  CameraView: (props: MockCameraViewProps) => {
    mockLatestCameraViewProps.current = props;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
    const { View } = require('react-native');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
    return require('react').createElement(View, { testID: props.testID });
  },
  useCameraPermissions: () => [{ granted: mockCameraPermission.granted }, jest.fn()],
}));

/**
 * Genuinely valid: built with the real protocol encoder from fixed bytes (no
 * RNG), a future expiry, the current protocol version, and a wss:// relay, so
 * validateScannedQr runs for real instead of being mocked out.
 */
function validPairingUri(): string {
  return encodePairingQrPayload({
    desktopStaticPublicKey: new Uint8Array(32).fill(1),
    pairingToken: new Uint8Array(32).fill(2),
    relayAddress: 'wss://relay.example.test',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    protocolVersion: PROTOCOL_VERSION,
  });
}

describe('PairingScanScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks clears call history but not a queued one-shot
    // implementation (mockResolvedValueOnce / mockRejectedValueOnce /
    // mockReturnValueOnce), so a test that queued one and never consumed it
    // could otherwise leak into the next test. Re-assert the baseline here.
    beginPairing.mockResolvedValue(undefined);
    mockCameraPermission.granted = false;
    mockLatestCameraViewProps.current = null;
    mockLatestFocusEffect.current = null;
  });

  afterEach(() => {
    cleanup();
  });

  // Renders via the permission-denied branch, which shows the paste fallback
  // without ever mounting the CameraView.
  describe('paste path', () => {
    it('begins pairing and enters confirm on a valid pasted link', async () => {
      render(<PairingScanScreen />);

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), validPairingUri());
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });

      expect(beginPairing).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/pair-confirm');
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('a same-tick double tap of the paste submit begins pairing and enters confirm exactly once', async () => {
      render(<PairingScanScreen />);

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), validPairingUri());
      const submitButton = screen.getByTestId('pairing-paste-link-submit');
      // Both presses inside ONE act: nested-act deferral keeps React from
      // re-rendering between them, so the second press observes the same
      // closure state as the first - the same-tick condition a double tap
      // (or two camera frames) produces on a real device. A single-press
      // test passes against the useState-guard bug and proves nothing.
      await act(async () => {
        fireEvent.press(submitButton);
        fireEvent.press(submitButton);
      });

      // Two calls here is the recorded iOS failure: two beginPairing dials
      // into the same single-use relay slot, two stacked confirm frames.
      expect(beginPairing).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
    });

    it('a validation failure shows the error and does not block an immediately following valid submit', async () => {
      render(<PairingScanScreen />);

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), 'not-a-pairing-uri');
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });

      expect(screen.getByTestId('pairing-scan-error')).toBeTruthy();
      expect(beginPairing).not.toHaveBeenCalled();

      // A rejected code must never latch the in-flight guard: the user
      // corrects the link and retries immediately.
      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), validPairingUri());
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });

      expect(beginPairing).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      // handleUri's setErrorMessage(null) must clear a previously shown
      // error on the next attempt, not just leave it behind under the new
      // (now-navigated-away-from) screen.
      expect(screen.queryByTestId('pairing-scan-error')).toBeNull();
    });

    it('disables the paste submit while pairing is in flight', async () => {
      beginPairing.mockReturnValueOnce(new Promise(() => {}));
      render(<PairingScanScreen />);

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), validPairingUri());
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });

      // Assert the disabled prop rather than firing a second press: the
      // double-press protection itself is pinned above, and RNTL's press
      // semantics on a disabled Pressable are not this test's contract.
      expect(screen.getByTestId('pairing-paste-link-submit').props.accessibilityState.disabled).toBe(true);
    });

    it('surfaces a pre-machine beginPairing failure and releases the guard for a retry', async () => {
      // beginPairing resolves even when the relay dial fails (the machine
      // settles into its own error state); a rejection means it failed
      // BEFORE the machine existed, e.g. the SecureStore identity load.
      beginPairing.mockRejectedValueOnce(new Error('secure-store unavailable'));
      render(<PairingScanScreen />);

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), validPairingUri());
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });

      await waitFor(() =>
        expect(screen.getByTestId('pairing-scan-error').props.children).toBe('Could not start pairing. Try again.'),
      );
      expect(mockNavigate).not.toHaveBeenCalled();

      // No navigation happened, so no focus change will re-arm the screen;
      // the failure path itself must release the guard.
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });

      expect(beginPairing).toHaveBeenCalledTimes(2);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
    });

    it('stays latched after entering confirm, and re-arms when focus returns', async () => {
      render(<PairingScanScreen />);

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), validPairingUri());
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });
      expect(beginPairing).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledTimes(1);

      // The scan screen stays mounted beneath the pushed confirm screen. The
      // disabled submit button is the first line of defense against a stray
      // tap while it sits there; a fireEvent.press here would be a silent
      // RNTL no-op against a disabled Pressable and would not exercise the
      // latch itself. The latch (pairingInFlightRef, which also blocks an
      // event the disabled-press guard cannot reach, such as a barcode
      // callback already dispatched by the native camera layer) is pinned
      // by the stale-handler camera test below.
      expect(screen.getByTestId('pairing-paste-link-submit').props.accessibilityState.disabled).toBe(true);

      // Popping back to the scan screen ("Go back" after a failed ceremony)
      // refires the focus effect; that is the moment a rescan becomes
      // legitimate again.
      act(() => {
        mockLatestFocusEffect.current?.();
      });
      expect(screen.getByTestId('pairing-paste-link-submit').props.accessibilityState.disabled).toBe(false);

      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });
      expect(beginPairing).toHaveBeenCalledTimes(2);
      // The re-armed attempt must actually reach the confirm screen, not
      // just re-invoke beginPairing.
      expect(mockNavigate).toHaveBeenCalledTimes(2);
    });
  });

  describe('camera path', () => {
    it('a same-tick burst of barcode events begins pairing exactly once', async () => {
      mockCameraPermission.granted = true;
      render(<PairingScanScreen />);

      const onBarcodeScanned = mockLatestCameraViewProps.current?.onBarcodeScanned;
      expect(onBarcodeScanned).toBeDefined();

      // Two frames of the same QR delivered in one tick: the camera emits at
      // roughly 30fps, so this is the production timing, not a contrivance.
      // Calling the captured handler directly (rather than via fireEvent)
      // also makes this immune to act-flush semantics, backstopping the
      // paste-path double-tap test above.
      const scannedUri = validPairingUri();
      await act(async () => {
        onBarcodeScanned?.({ data: scannedUri });
        onBarcodeScanned?.({ data: scannedUri });
      });

      expect(beginPairing).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
    });

    it('unwires the camera handler while pairing is in flight', async () => {
      beginPairing.mockReturnValueOnce(new Promise(() => {}));
      mockCameraPermission.granted = true;
      render(<PairingScanScreen />);

      await act(async () => {
        mockLatestCameraViewProps.current?.onBarcodeScanned?.({ data: validPairingUri() });
      });

      // The render-time unwiring is the second line of defense the ref latch
      // does not replace: once a scan is in flight, the CameraView gets no
      // handler at all.
      expect(mockLatestCameraViewProps.current?.onBarcodeScanned).toBeUndefined();
    });

    it('a same-tick burst mixing the paste submit and a barcode scan begins pairing exactly once', async () => {
      mockCameraPermission.granted = true;
      render(<PairingScanScreen />);

      const onBarcodeScanned = mockLatestCameraViewProps.current?.onBarcodeScanned;
      expect(onBarcodeScanned).toBeDefined();

      const scannedUri = validPairingUri();
      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), scannedUri);
      const submitButton = screen.getByTestId('pairing-paste-link-submit');

      // On the camera-granted branch both entry points render in the same
      // screen and share one latch. Firing both in the same tick is the
      // mixed-entry-point version of the same-tick bursts above, which each
      // only exercised a single entry point at a time.
      await act(async () => {
        fireEvent.press(submitButton);
        onBarcodeScanned?.({ data: scannedUri });
      });

      expect(beginPairing).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
    });

    it('a barcode event delivered through an already-unwired handler reference does not start a second ceremony', async () => {
      mockCameraPermission.granted = true;
      render(<PairingScanScreen />);

      // Stashed BEFORE any scan: this is the handler reference the native
      // camera layer already holds. Once pairing is in flight, React flips
      // onBarcodeScanned to undefined on the next render, but that prop flip
      // cannot recall an event the native layer already dispatched with the
      // old handler reference in hand.
      const initialOnBarcodeScanned = mockLatestCameraViewProps.current?.onBarcodeScanned;
      expect(initialOnBarcodeScanned).toBeDefined();

      const scannedUri = validPairingUri();
      await act(async () => {
        initialOnBarcodeScanned?.({ data: scannedUri });
      });
      expect(beginPairing).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledTimes(1);

      // The stashed reference fires again, simulating that already-in-flight
      // native event landing after the prop was unwired. Only
      // pairingInFlightRef (checked synchronously inside handleUri,
      // independent of the render-time prop unwiring) can stop this: the
      // disabled prop and the undefined onBarcodeScanned prop are both
      // irrelevant here, since this call bypasses React's prop dispatch
      // entirely.
      await act(async () => {
        initialOnBarcodeScanned?.({ data: scannedUri });
      });
      expect(beginPairing).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
    });
  });
});
