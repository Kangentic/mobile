import React from 'react';
import { AppState, Linking, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react-native';
import { encodePairingQrPayload, PROTOCOL_VERSION } from '@kangentic/protocol';
import { PairingScanScreen } from '@/screens/PairingScanScreen';
import { DEMO_PAIRING_SHORTCUT, DEMO_PAIRING_URI, DEMO_PAIRING_WORD } from '@/demo/demoIdentity';

jest.mock('@/pairing/activePairing', () => ({
  beginPairing: jest.fn().mockResolvedValue(undefined),
}));

// Hoisted once: no resetModules in jest.config.js, so this reference stays
// live for the whole file. clearAllMocks() in beforeEach clears call history
// in place rather than swapping in a new fn, so the reference never goes
// stale across tests.
const { beginPairing } = jest.requireMock<{ beginPairing: jest.Mock }>('@/pairing/activePairing');

// The demo ceremony is mocked here for the same reason beginPairing is: this
// tier's job is to prove the screen ROUTES a demo code to it and never into
// real pairing validation. That the ceremony itself is a genuine handshake is
// proved in tests/unit/demoPairingHandshake.test.ts, where a real loopback peer
// is available and expo-secure-store can be faked.
jest.mock('@/demo/demoPairing', () => {
  class FakeAlreadyPairedError extends Error {
    constructor() {
      super('This phone is already paired. Unpair first to use the demo.');
      this.name = 'AlreadyPairedError';
    }
  }
  class FakePairingInProgressError extends Error {
    constructor() {
      super('A pairing is already in progress. Finish or cancel it first.');
      this.name = 'PairingInProgressError';
    }
  }
  return {
    beginDemoPairing: jest.fn().mockResolvedValue(undefined),
    AlreadyPairedError: FakeAlreadyPairedError,
    PairingInProgressError: FakePairingInProgressError,
  };
});

const { beginDemoPairing, AlreadyPairedError, PairingInProgressError } = jest.requireMock<{
  beginDemoPairing: jest.Mock;
  AlreadyPairedError: new () => Error;
  PairingInProgressError: new () => Error;
}>('@/demo/demoPairing');

// A DELEGATING mock, not a stub: it records calls while still running the real
// validator, so the sixteen tests below that depend on genuine QR validation
// are unaffected, and the demo tests can additionally assert the validator was
// never reached. A plain jest.spyOn cannot do this - the screen holds a direct
// binding to the imported function, and ES module exports are not writable.
jest.mock('@/pairing/qr', () => {
  const actual = jest.requireActual<typeof import('@/pairing/qr')>('@/pairing/qr');
  return { ...actual, validateScannedQr: jest.fn(actual.validateScannedQr) };
});

const { validateScannedQr } = jest.requireMock<{ validateScannedQr: jest.Mock }>('@/pairing/qr');

// Separate mocks per verb: the screen's choice of navigate over push is
// load-bearing (navigate dedupes onto an existing route; push would stack a
// duplicate confirm screen; replace would drop this screen from the stack
// and break the confirm screen's "Go back"-to-rescan path), so the tests pin
// the exact verb rather than treating push/navigate as interchangeable.
const mockNavigate = jest.fn();
const mockPush = jest.fn();

// Tracks every jest.spyOn(...) this file installs (Linking.openSettings in
// several tests below, AppState.addEventListener in beforeEach) so the
// shared afterEach can restore each one explicitly. jest.config.js sets no
// restoreMocks, and a bare jest.restoreAllMocks() would also strip any spy
// the jest-expo preset installs during its own setup, outside this file's
// control - scoping restoration to what this file actually installed is the
// safer local fix.
const spiesToRestore: { mockRestore: () => void }[] = [];

function trackSpy<Spy extends { mockRestore: () => void }>(spy: Spy): Spy {
  spiesToRestore.push(spy);
  return spy;
}

// Captures the screen's focus effect so a test can replay it, simulating the
// native stack popping back to this still-mounted screen ("Go back" from the
// confirm screen after a failed ceremony).
const mockLatestFocusEffect: { current: (() => void | (() => void)) | null } = { current: null };

// The route params the screen reads for the demo deep link. Mutated by the
// deep-link tests; reset to empty in beforeEach so every other test renders the
// ordinary /pair route.
const mockSearchParams: { current: Record<string, string> } = { current: {} };

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: mockNavigate, back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => mockSearchParams.current,
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
// canAskAgain is as load-bearing as granted and must be modelled: iOS shows the
// system camera prompt once per install, so the screen branches on it to decide
// between asking the OS and routing to Settings. Omitting it here would leave
// `!permission.canAskAgain` true under test, silently rendering the Settings
// variant for every denied-branch test in this file while they all still pass.
const mockCameraPermission = { granted: false, canAskAgain: true };
// Shared rather than a fresh jest.fn() per render, so a test can assert the
// screen asked the OS. It also matches the real hook, whose requestPermission
// identity is stable across renders.
const mockRequestPermission = jest.fn();
// The hook's third tuple element (verified against expo-modules-core's
// createPermissionHook: it returns [status, requestPermission, getPermission],
// and the screen calls the third one refreshCameraPermission). It must
// resolve rather than being a bare jest.fn(): the screen's AppState 'active'
// effect always chains a `.catch()` onto its return value (see
// PairingScanScreen.tsx), so an unconfigured jest.fn() (undefined by
// default) would throw "Cannot read properties of undefined (reading
// 'catch')" the first time a test fires that event, rather than the
// assertion failure the test actually intends. Without this third element at
// all, refreshCameraPermission is undefined at runtime under test, which is
// the gap this mock previously had.
const mockRefreshCameraPermission = jest.fn().mockResolvedValue(undefined);
const mockLatestCameraViewProps: { current: MockCameraViewProps | null } = { current: null };

jest.mock('expo-camera', () => ({
  CameraView: (props: MockCameraViewProps) => {
    mockLatestCameraViewProps.current = props;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
    const { View } = require('react-native');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
    return require('react').createElement(View, { testID: props.testID });
  },
  useCameraPermissions: () => [
    { granted: mockCameraPermission.granted, canAskAgain: mockCameraPermission.canAskAgain },
    mockRequestPermission,
    mockRefreshCameraPermission,
  ],
}));

// Captures the screen's AppState 'change' listener (installed fresh via
// trackSpy in beforeEach below) so a test can drive the 'active' transition
// that fires when the user returns from Settings. Mirrors the identical
// pattern in tests/components/SettingsScreen.test.tsx: the real AppState is
// spied on rather than module-mocked, because react-native re-exports
// AppState lazily, so replacing the whole module would leave the component
// with an undefined AppState.
const appStateListeners = new Set<(nextStatus: AppStateStatus) => void>();

function emitAppState(nextStatus: AppStateStatus): void {
  for (const listener of appStateListeners) listener(nextStatus);
}

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
    beginDemoPairing.mockResolvedValue(undefined);
    mockSearchParams.current = {};
    mockRefreshCameraPermission.mockResolvedValue(undefined);
    mockCameraPermission.granted = false;
    mockCameraPermission.canAskAgain = true;
    mockLatestCameraViewProps.current = null;
    mockLatestFocusEffect.current = null;
    appStateListeners.clear();
    // Spied fresh every test and tracked via trackSpy so the shared afterEach
    // restores it, rather than layering a new spy over the previous test's on
    // every run.
    trackSpy(jest.spyOn(AppState, 'addEventListener')).mockImplementation(
      (_event, listener): NativeEventSubscription => {
        const appStateListener = listener as (nextStatus: AppStateStatus) => void;
        appStateListeners.add(appStateListener);
        return { remove: () => appStateListeners.delete(appStateListener) } as unknown as NativeEventSubscription;
      },
    );
  });

  afterEach(() => {
    cleanup();
    // Restores every spy trackSpy recorded (the jest.spyOn(Linking,
    // 'openSettings') calls in the camera-permission-recovery tests below,
    // and the AppState.addEventListener spy just installed above).
    // jest.config.js sets no restoreMocks, so without this a spy configured
    // to reject in one test (e.g. openSettings.mockRejectedValue(...)) would
    // stay mocked-as-rejecting for every later test in the file.
    for (const spy of spiesToRestore) spy.mockRestore();
    spiesToRestore.length = 0;
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

  // The pre-permission screen App Review looked at. Both the branch and the
  // copy are pinned: guideline 5.1.1(iv) rejected 0.4.1 build 7 over this
  // button's wording, so the labels here are a compliance contract rather than
  // decoration, and a test that lets them drift back is not doing its job.
  describe('camera permission recovery', () => {
    it('asks the OS while the system prompt is still available', () => {
      const openSettings = trackSpy(jest.spyOn(Linking, 'openSettings')).mockResolvedValue(undefined);

      render(<PairingScanScreen />);

      // Pinned alongside the button label: only the label was asserted
      // before, so swapping the two explainer strings between branches would
      // have passed every test in this file.
      expect(screen.getByText('Camera access is needed to scan a desktop pairing code.')).toBeTruthy();
      expect(screen.getByText('Continue')).toBeTruthy();
      fireEvent.press(screen.getByTestId('pairing-request-camera-permission'));

      expect(mockRequestPermission).toHaveBeenCalledTimes(1);
      expect(openSettings).not.toHaveBeenCalled();
    });

    it('routes to Settings once the OS will not prompt again', () => {
      // iOS prompts once per install. After a refusal requestPermission()
      // resolves without showing anything, so the pre-fix button rendered
      // normally and did nothing at all - the whole reason for this branch.
      mockCameraPermission.canAskAgain = false;
      const openSettings = trackSpy(jest.spyOn(Linking, 'openSettings')).mockResolvedValue(undefined);

      render(<PairingScanScreen />);

      expect(screen.getByText('Turn on camera access in Settings to scan a code.')).toBeTruthy();
      expect(screen.getByText('Open Settings')).toBeTruthy();
      fireEvent.press(screen.getByTestId('pairing-request-camera-permission'));

      expect(openSettings).toHaveBeenCalledTimes(1);
      expect(mockRequestPermission).not.toHaveBeenCalled();
    });

    it('reports a Settings launch the OS refuses instead of rejecting unhandled', async () => {
      mockCameraPermission.canAskAgain = false;
      trackSpy(jest.spyOn(Linking, 'openSettings')).mockRejectedValue(new Error('cannot open'));

      render(<PairingScanScreen />);

      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-request-camera-permission'));
      });

      // The exact string, not just presence: the file uses this same pattern
      // for UNEXPECTED_ERROR_MESSAGE above, and a getByTestId(...).toBeTruthy()
      // alone would pass even if the wrong message rendered.
      expect(screen.getByTestId('pairing-scan-error').props.children).toBe('Could not open Settings.');
      // The paste fallback is still the way forward, so it must survive the failure.
      expect(screen.getByTestId('pairing-paste-link-submit')).toBeTruthy();
    });

    it('clears a stale Settings error on a retry that succeeds', async () => {
      mockCameraPermission.canAskAgain = false;
      const openSettings = trackSpy(jest.spyOn(Linking, 'openSettings'))
        .mockRejectedValueOnce(new Error('cannot open'))
        .mockResolvedValue(undefined);

      render(<PairingScanScreen />);

      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-request-camera-permission'));
      });
      expect(screen.getByTestId('pairing-scan-error').props.children).toBe('Could not open Settings.');

      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-request-camera-permission'));
      });

      // openAppSettings clears the error before opening Settings, not only on
      // a successful resolution: a stale "Could not open Settings." from the
      // failed first tap must not survive a second tap that succeeds.
      expect(screen.queryByTestId('pairing-scan-error')).toBeNull();
      expect(openSettings).toHaveBeenCalledTimes(2);
    });

    // useCameraPermissions reads status once on mount and never again on its
    // own, so granting camera access in Settings and returning previously
    // stranded the user on this very screen forever. These pin the fix: the
    // effect refreshes only on 'active', and cleans up its listener so it
    // cannot keep firing against an unmounted screen.
    describe('AppState refresh on return from Settings', () => {
      it('refreshes camera permission when the app returns to active', () => {
        render(<PairingScanScreen />);

        // Pins the subscribed event name itself, not just the behavior once
        // fired: emitAppState replays whatever listener the mock captured
        // regardless of which event name the screen subscribed with, so a
        // source change to 'focus' or 'blur' (both Android-only, per React
        // Native's AppState docs) would pass every test in this describe
        // block without this line catching it.
        expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

        act(() => {
          emitAppState('active');
        });

        expect(mockRefreshCameraPermission).toHaveBeenCalledTimes(1);
      });

      it('does not refresh camera permission on a non-active AppState transition', () => {
        render(<PairingScanScreen />);

        act(() => {
          emitAppState('background');
        });

        expect(mockRefreshCameraPermission).not.toHaveBeenCalled();
      });

      it('removes the AppState listener on unmount', () => {
        const { unmount } = render(<PairingScanScreen />);
        // Precondition guard: exactly one listener registered, so the
        // behavioral assertion below actually exercises the cleanup path
        // rather than passing vacuously against an empty set.
        expect(appStateListeners.size).toBe(1);

        unmount();

        // A leaked listener is the failure mode worth pinning: it would keep
        // calling refreshCameraPermission against an unmounted screen on
        // every later AppState transition for the rest of the app's
        // lifetime. Asserting the behavior (not called after unmount),
        // rather than only the bookkeeping Set size, is what actually proves
        // the leak is gone.
        act(() => {
          emitAppState('active');
        });
        expect(mockRefreshCameraPermission).not.toHaveBeenCalled();
      });
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

      // Non-empty so the paste submit's `pastedLink.length === 0` disabled
      // term is false going in; otherwise the assertion below would pass
      // regardless of isSubmitInFlight and prove nothing about this call
      // site's wiring.
      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), validPairingUri());
      expect(screen.getByTestId('pairing-paste-link-submit').props.accessibilityState.disabled).toBe(false);

      await act(async () => {
        mockLatestCameraViewProps.current?.onBarcodeScanned?.({ data: validPairingUri() });
      });

      // The render-time unwiring is the second line of defense the ref latch
      // does not replace: once a scan is in flight, the CameraView gets no
      // handler at all.
      expect(mockLatestCameraViewProps.current?.onBarcodeScanned).toBeUndefined();
      // isSubmitInFlight is threaded to PasteLinkFallback at this call site
      // too (a second, textually-identical wiring on the camera-granted
      // branch); the before/after pair on the same expression makes this
      // attributable to isSubmitInFlight specifically, not to the
      // already-covered empty-input disabled term.
      expect(screen.getByTestId('pairing-paste-link-submit').props.accessibilityState.disabled).toBe(true);
    });

    it('re-wires the camera handler and allows a second scan after focus regain', async () => {
      mockCameraPermission.granted = true;
      render(<PairingScanScreen />);

      const scannedUri = validPairingUri();
      await act(async () => {
        mockLatestCameraViewProps.current?.onBarcodeScanned?.({ data: scannedUri });
      });
      expect(beginPairing).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledTimes(1);

      // The scan screen stays mounted beneath the pushed confirm screen, so
      // the camera keeps running; the handler is unwired while the latch
      // holds.
      expect(mockLatestCameraViewProps.current?.onBarcodeScanned).toBeUndefined();

      // "Go back" from the confirm screen refires the focus effect. The
      // design comment on the effect names the camera specifically:
      // releasing the latch there would re-wire the camera so a stray
      // barcode event could push a second confirm frame - so the re-arm
      // must actually reach the camera surface, not just the paste button's
      // disabled state proven above.
      act(() => {
        mockLatestFocusEffect.current?.();
      });

      // Re-read from the ref rather than reusing a stashed props object:
      // mockLatestCameraViewProps.current is overwritten on every render, so
      // a reference captured before the focus effect would be a stale
      // snapshot and make this assertion pass vacuously.
      const rewiredOnBarcodeScanned = mockLatestCameraViewProps.current?.onBarcodeScanned;
      expect(rewiredOnBarcodeScanned).toBeDefined();

      await act(async () => {
        rewiredOnBarcodeScanned?.({ data: scannedUri });
      });

      // The call count, not just definedness, is what discriminates a
      // genuinely re-armed handler from one that is re-wired but still
      // blocked by a latch the focus effect failed to release.
      expect(beginPairing).toHaveBeenCalledTimes(2);
      expect(mockNavigate).toHaveBeenCalledTimes(2);
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

  /**
   * The reviewer/demo code. The isolation assertions here are the point: this
   * code ships in production and is refused by nothing, so "it never enters
   * real pairing" has to be pinned at the screen, not just reasoned about.
   */
  describe('demo code', () => {
    it.each([
      ['the bare word the review notes ask for', DEMO_PAIRING_WORD],
      ['the bare word in caps', DEMO_PAIRING_WORD.toUpperCase()],
      ['the bare word with pasted whitespace', `  ${DEMO_PAIRING_WORD} `],
      ['the typed shortcut', DEMO_PAIRING_SHORTCUT],
      ['the encoded URI a reviewer scans', DEMO_PAIRING_URI],
      ['a shortcut with pasted whitespace', `  ${DEMO_PAIRING_SHORTCUT}\n`],
      ['a shortcut typed in caps', DEMO_PAIRING_SHORTCUT.toUpperCase()],
    ])('routes %s to the demo ceremony and into confirm', async (_label, code) => {
      render(<PairingScanScreen />);

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), code);
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });

      expect(beginDemoPairing).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/pair-confirm');
      // The two isolation invariants, asserted at the screen where the branch
      // actually lives. validateScannedQr in particular would reject the frozen
      // URI as version-incompatible the first time PROTOCOL_VERSION moved, so a
      // regression here is a demo that dies silently in App Review.
      expect(validateScannedQr).not.toHaveBeenCalled();
      expect(beginPairing).not.toHaveBeenCalled();
    });

    it('routes a scanned demo QR the same way as a pasted one', async () => {
      mockCameraPermission.granted = true;
      render(<PairingScanScreen />);

      await act(async () => {
        mockLatestCameraViewProps.current?.onBarcodeScanned?.({ data: DEMO_PAIRING_URI });
      });

      expect(beginDemoPairing).toHaveBeenCalledTimes(1);
      expect(validateScannedQr).not.toHaveBeenCalled();
      expect(beginPairing).not.toHaveBeenCalled();
    });

    it('still sends a real pairing URI down the real path', async () => {
      // The other half of the branch. Without this, deleting the demo check's
      // `return` would leave every test above passing.
      render(<PairingScanScreen />);

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), validPairingUri());
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });

      expect(validateScannedQr).toHaveBeenCalledTimes(1);
      expect(beginPairing).toHaveBeenCalledTimes(1);
      expect(beginDemoPairing).not.toHaveBeenCalled();
    });

    it('a same-tick double tap starts the demo exactly once', async () => {
      render(<PairingScanScreen />);

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), DEMO_PAIRING_SHORTCUT);
      const submitButton = screen.getByTestId('pairing-paste-link-submit');
      await act(async () => {
        fireEvent.press(submitButton);
        fireEvent.press(submitButton);
      });

      expect(beginDemoPairing).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
    });

    it('surfaces the already-paired refusal by name, and does not navigate', async () => {
      // "Could not start pairing" on a phone that is working perfectly reads as
      // a broken app, so the refusal has to say which refusal it is.
      beginDemoPairing.mockRejectedValueOnce(new AlreadyPairedError());
      render(<PairingScanScreen />);

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), DEMO_PAIRING_SHORTCUT);
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });

      expect(screen.getByTestId('pairing-scan-error')).toHaveTextContent(
        'This phone is already paired. Unpair first to use the demo.',
      );
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('surfaces the pairing-in-progress refusal by name, and does not navigate', async () => {
      // The other named refusal. Both AlreadyPairedError and
      // PairingInProgressError share one branch in the screen
      // (`error instanceof AlreadyPairedError || error instanceof
      // PairingInProgressError`), and the AlreadyPairedError case above
      // cannot tell the two apart from a mutation that dropped just this
      // second check - only its own error type. Asserted here by its own
      // distinct message so a regression names which refusal broke.
      beginDemoPairing.mockRejectedValueOnce(new PairingInProgressError());
      render(<PairingScanScreen />);

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), DEMO_PAIRING_SHORTCUT);
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });

      expect(screen.getByTestId('pairing-scan-error')).toHaveTextContent(
        'A pairing is already in progress. Finish or cancel it first.',
      );
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('releases the guard after a refusal so a real code still works', async () => {
      beginDemoPairing.mockRejectedValueOnce(new AlreadyPairedError());
      render(<PairingScanScreen />);

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), DEMO_PAIRING_SHORTCUT);
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), validPairingUri());
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });

      expect(beginPairing).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/pair-confirm');
    });

    it('reports an unexpected ceremony failure with the generic message', async () => {
      beginDemoPairing.mockRejectedValueOnce(new Error('loopback exploded'));
      render(<PairingScanScreen />);

      fireEvent.changeText(screen.getByTestId('pairing-paste-link-input'), DEMO_PAIRING_SHORTCUT);
      await act(async () => {
        fireEvent.press(screen.getByTestId('pairing-paste-link-submit'));
      });

      expect(screen.getByTestId('pairing-scan-error')).toHaveTextContent('Could not start pairing. Try again.');
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('starts the demo from the deep-link route param', async () => {
      // app/+native-intent.ts turns kangentic-pair://demo into /pair?demo=1.
      mockSearchParams.current = { demo: '1' };

      render(<PairingScanScreen />);
      // render() already acts; this empty act flushes the mount effect's own
      // async continuation (beginDemoPairing resolves, then navigate fires).
      await act(async () => {});

      expect(beginDemoPairing).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/pair-confirm');
      expect(validateScannedQr).not.toHaveBeenCalled();
    });

    it('does not start the demo on an ordinary visit to the pairing screen', async () => {
      render(<PairingScanScreen />);
      await act(async () => {});

      expect(beginDemoPairing).not.toHaveBeenCalled();
    });

    it('does not restart the demo when the screen regains focus', async () => {
      // The focus effect re-arms the in-flight latch on every focus regain, so
      // without the once-per-mount ref, backing out of the confirm screen would
      // immediately restart the ceremony the user just left.
      mockSearchParams.current = { demo: '1' };
      render(<PairingScanScreen />);
      await act(async () => {});
      expect(beginDemoPairing).toHaveBeenCalledTimes(1);

      await act(async () => {
        mockLatestFocusEffect.current?.();
      });

      expect(beginDemoPairing).toHaveBeenCalledTimes(1);
    });
  });
});
