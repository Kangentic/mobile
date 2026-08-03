import React from 'react';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TerminalPane } from '@/components/terminal/TerminalPane';
import { decodeHostMessage } from '@/terminal/terminalBridge';
import {
  appendChunk,
  resetTerminalFeed,
  retainTerminal,
  seedScrollback,
  setTerminalDimensions,
} from '@/state/terminalFeed';
import { useTerminalUiStore } from '@/state/terminalUiStore';

jest.mock('@/connection/actions', () => ({
  writeTerminal: jest.fn().mockResolvedValue(undefined),
  refreshTerminalStream: jest.fn(),
}));

// Drives the foreground/background transitions the pane refits on.
// Spied on the real AppState (registered in beforeEach) rather than mocked as
// a module: react-native re-exports it lazily, so replacing the module leaves
// the component with an undefined AppState.
const appStateListeners = new Set<(nextStatus: AppStateStatus) => void>();

function emitAppState(nextStatus: AppStateStatus): void {
  for (const listener of appStateListeners) listener(nextStatus);
}

jest.mock('expo-asset', () => ({
  Asset: {
    fromModule: () => ({
      uri: 'file:///assets/xterm.html',
      localUri: 'file:///assets/xterm.html',
      downloadAsync: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

// The real multi-touch recognizer is device-only behavior. The chainable stub
// keeps the component renderable AND captures every callback the component
// registers by method name, so a test can fire that callback directly and
// assert what it posts - the pinch lifecycle (onTouchesDown/onStart/
// onTouchesUp/onTouchesCancelled/onFinalize) is plain JS wiring around a
// numberOfTouches threshold, testable without a real recognizer underneath it.
jest.mock('react-native-gesture-handler', () => {
  // A Proxy rather than a fixed method list: the builder is chainable by
  // design, so enumerating the methods in use means every new one added to the
  // component fails here as "onX is not a function" rather than as anything
  // resembling the change that caused it.
  const pinchCallbacksByMethodName: Record<string, (...callbackArguments: unknown[]) => unknown> = {};
  const mockChainablePinch = (): Record<string, (...callbackArguments: unknown[]) => unknown> => {
    const gestureStub = new Proxy(
      {},
      {
        get: (_target, propertyName) => {
          // A function for 'then' would make this object read as a thenable to
          // anything that ever awaits it; hand back undefined for that and for
          // any symbol property rather than capturing them as callbacks.
          if (typeof propertyName !== 'string' || propertyName === 'then') return undefined;
          return (callback: (...callbackArguments: unknown[]) => unknown) => {
            pinchCallbacksByMethodName[propertyName] = callback;
            return gestureStub;
          };
        },
      },
    ) as Record<string, (...callbackArguments: unknown[]) => unknown>;
    return gestureStub;
  };
  return {
    GestureDetector: ({ children }: { children: unknown }) => children,
    Gesture: { Pinch: mockChainablePinch },
    __pinchCallbacksByMethodName: pinchCallbacksByMethodName,
  };
});

// A View passthrough that records the latest props and exposes an imperative
// postMessage spy, so the test can drive onMessage and assert host posts.
jest.mock('react-native-webview', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const mockReact = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  const postMessageMock = jest.fn();
  const capturedProps: { current: Record<string, unknown> | null } = { current: null };
  const MockWebView = mockReact.forwardRef(function MockWebView(props: Record<string, unknown>, ref: unknown) {
    capturedProps.current = props;
    mockReact.useImperativeHandle(ref, () => ({ postMessage: postMessageMock }));
    return mockReact.createElement(View, { testID: props.testID });
  });
  return {
    __esModule: true,
    WebView: MockWebView,
    default: MockWebView,
    __postMessageMock: postMessageMock,
    __capturedProps: capturedProps,
  };
});

// Mocked so the keyboard-focus escape hatch (item 1) can be asserted as a
// call, not a real native focus event RNTL cannot observe.
jest.mock('@/components/terminal/DirectKeyInput', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const mockReact = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  const focusMock = jest.fn();
  const toggleMock = jest.fn();
  const blurMock = jest.fn();
  const MockDirectKeyInput = mockReact.forwardRef(function MockDirectKeyInput(
    props: { sessionId: string },
    ref: unknown,
  ) {
    mockReact.useImperativeHandle(ref, () => ({ toggle: toggleMock, focus: focusMock, blur: blurMock }));
    return mockReact.createElement(View, { testID: 'terminal-direct-key-input' });
  });
  return { __esModule: true, DirectKeyInput: MockDirectKeyInput, __focusMock: focusMock };
});

interface WebViewMockModule {
  __postMessageMock: jest.Mock;
  __capturedProps: {
    current: {
      onMessage?: (event: { nativeEvent: { data: string } }) => void;
      onRenderProcessGone?: () => void;
      onContentProcessDidTerminate?: () => void;
    } | null;
  };
}

interface DirectKeyInputMockModule {
  __focusMock: jest.Mock;
}

interface GestureHandlerMockModule {
  __pinchCallbacksByMethodName: Record<string, (...callbackArguments: unknown[]) => unknown>;
}

const webViewMock = jest.requireMock<WebViewMockModule>('react-native-webview');
const actionsMock = jest.requireMock<{ writeTerminal: jest.Mock; refreshTerminalStream: jest.Mock }>(
  '@/connection/actions',
);
const directKeyInputMock = jest.requireMock<DirectKeyInputMockModule>('@/components/terminal/DirectKeyInput');
const gestureHandlerMock = jest.requireMock<GestureHandlerMockModule>('react-native-gesture-handler');

async function renderPaneAndReady(isActive = true): Promise<ReturnType<typeof render>> {
  const result = render(
    <ThemeProvider>
      <TerminalPane sessionId="sess-1" isActive={isActive} />
    </ThemeProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
  postFromWebView(JSON.stringify({ type: 'ready' }));
  return result;
}

function rerenderPane(result: ReturnType<typeof render>, isActive: boolean): void {
  result.rerender(
    <ThemeProvider>
      <TerminalPane sessionId="sess-1" isActive={isActive} />
    </ThemeProvider>,
  );
}

function postFromWebView(data: string): void {
  act(() => {
    webViewMock.__capturedProps.current?.onMessage?.({ nativeEvent: { data } });
  });
}

function decodedPosts(): ReturnType<typeof decodeHostMessage>[] {
  return webViewMock.__postMessageMock.mock.calls.map((call) => decodeHostMessage(call[0] as string));
}

/**
 * The FIRST posted 'pinch' message, narrowed so `.active` is reachable. Every
 * test here fires only one pinch callback before reading this, so first and
 * latest agree - a test that fires two in sequence needs the last one instead.
 */
function findPinchMessage(): { type: 'pinch'; active: boolean } | undefined {
  const found = decodedPosts().find((message) => message?.type === 'pinch');
  return found?.type === 'pinch' ? found : undefined;
}

/** Fires the pinch-gesture callback the component registered under this method name. */
function firePinchCallback(methodName: string, touchesEvent?: { numberOfTouches: number }): void {
  act(() => {
    gestureHandlerMock.__pinchCallbacksByMethodName[methodName]?.(touchesEvent);
  });
}

describe('TerminalPane (faithful mirror)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    resetTerminalFeed();
    webViewMock.__capturedProps.current = null;
    useTerminalUiStore.setState({
      applicationCursorModeBySessionId: {},
      stickyModesBySessionId: {},
      requestedModeBySessionId: {},
      focusKeyboardRequestBySessionId: {},
    });
    appStateListeners.clear();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener): NativeEventSubscription => {
      const appStateListener = listener as (nextStatus: AppStateStatus) => void;
      appStateListeners.add(appStateListener);
      return { remove: () => appStateListeners.delete(appStateListener) } as unknown as NativeEventSubscription;
    });
  });

  it('inits at the exact PTY grid when the desktop reported dimensions', async () => {
    retainTerminal('sess-1');
    setTerminalDimensions('sess-1', { cols: 120, rows: 30 });
    appendChunk('sess-1', 'hello world');
    await renderPaneAndReady();

    const initMessage = decodedPosts().find((message) => message?.type === 'init');
    expect(initMessage).toBeDefined();
    if (initMessage?.type === 'init') {
      expect(initMessage.scrollback).toBe('hello world');
      expect(initMessage.cols).toBe(120);
      expect(initMessage.rows).toBe(30);
    }
  });

  it('falls back to inferred cols and null rows when the desktop reports no dimensions', async () => {
    retainTerminal('sess-1');
    appendChunk('sess-1', 'hello world');
    await renderPaneAndReady();

    const initMessage = decodedPosts().find((message) => message?.type === 'init');
    expect(initMessage).toBeDefined();
    if (initMessage?.type === 'init') {
      // 'hello world' is 11 visible columns, clamped up to the 40-column floor.
      expect(initMessage.cols).toBe(40);
      expect(initMessage.rows).toBeNull();
    }
  });

  it('adopts an authoritative grid change by posting a resize to the WebView', async () => {
    retainTerminal('sess-1');
    setTerminalDimensions('sess-1', { cols: 120, rows: 30 });
    await renderPaneAndReady();
    webViewMock.__postMessageMock.mockClear();

    act(() => setTerminalDimensions('sess-1', { cols: 48, rows: 26 }));

    const resizeMessage = decodedPosts().find((message) => message?.type === 'resize');
    expect(resizeMessage).toEqual({ type: 'resize', cols: 48, rows: 26 });
  });

  it('forwards input messages from the WebView to writeTerminal', async () => {
    retainTerminal('sess-1');
    await renderPaneAndReady();

    postFromWebView(JSON.stringify({ type: 'input', data: 'ls' }));

    expect(actionsMock.writeTerminal).toHaveBeenCalledWith('sess-1', 'ls');
  });

  it('records the DECCKM report on the terminal-ui store', async () => {
    retainTerminal('sess-1');
    await renderPaneAndReady();

    postFromWebView(JSON.stringify({ type: 'modes', applicationCursorKeys: true }));

    expect(useTerminalUiStore.getState().applicationCursorModeBySessionId['sess-1']).toBe(true);
  });

  /**
   * An INITIAL modes report describes whatever the replayed seed established,
   * not a mode the desktop changed. Once something is already stored, letting
   * an initial report write would let a seed that lacked the DECSETs overwrite
   * the very modes being held to restore them - and since every later init
   * reports the same degraded baseline, the terminal could never climb back
   * out. A REAL transition (initial: false) must still overwrite.
   */
  it('protects the stored sticky-modes baseline from a later INITIAL report, but a real transition still overwrites it', async () => {
    retainTerminal('sess-1');
    await renderPaneAndReady();

    postFromWebView(
      JSON.stringify({
        type: 'modes',
        applicationCursorKeys: true,
        mouseTrackingMode: 'any',
        mouseEncoding: 'SGR',
        alternateBuffer: true,
        initial: false,
      }),
    );
    expect(useTerminalUiStore.getState().stickyModesBySessionId['sess-1']).toEqual({
      applicationCursorKeys: true,
      mouseTrackingMode: 'any',
      mouseEncoding: 'SGR',
      alternateBuffer: true,
    });

    // A degraded baseline (initial: true) for a re-init that lacked the
    // DECSETs must not overwrite what is already stored.
    postFromWebView(
      JSON.stringify({
        type: 'modes',
        applicationCursorKeys: true,
        mouseTrackingMode: 'none',
        mouseEncoding: 'SGR',
        alternateBuffer: false,
        initial: true,
      }),
    );
    expect(useTerminalUiStore.getState().stickyModesBySessionId['sess-1']).toEqual({
      applicationCursorKeys: true,
      mouseTrackingMode: 'any',
      mouseEncoding: 'SGR',
      alternateBuffer: true,
    });

    // The same degraded fields, but as a REAL transition (initial: false):
    // this one is allowed to overwrite.
    postFromWebView(
      JSON.stringify({
        type: 'modes',
        applicationCursorKeys: true,
        mouseTrackingMode: 'none',
        mouseEncoding: 'SGR',
        alternateBuffer: false,
        initial: false,
      }),
    );
    expect(useTerminalUiStore.getState().stickyModesBySessionId['sess-1']).toEqual({
      applicationCursorKeys: true,
      mouseTrackingMode: 'none',
      mouseEncoding: 'SGR',
      alternateBuffer: false,
    });
  });

  it('pauses WebView writes while inactive and re-seeds on becoming active', async () => {
    retainTerminal('sess-1');
    setTerminalDimensions('sess-1', { cols: 80, rows: 24 });
    appendChunk('sess-1', 'first');
    const result = await renderPaneAndReady(true);

    // Go inactive (user switched to another tab).
    rerenderPane(result, false);
    webViewMock.__postMessageMock.mockClear();

    // A chunk arrives while paused: nothing is posted to the WebView, though
    // the ring still buffers it.
    act(() => appendChunk('sess-1', 'while-hidden'));
    expect(decodedPosts().some((message) => message?.type === 'write')).toBe(false);

    // Back to active: it re-seeds (init) so the WebView jumps to the latest
    // frame, including what streamed while it was hidden.
    rerenderPane(result, true);
    const reseed = decodedPosts().find((message) => message?.type === 'init');
    expect(reseed).toBeDefined();
    if (reseed?.type === 'init') {
      expect(reseed.scrollback).toContain('while-hidden');
    }
  });

  /**
   * Observed on a Pixel: after the app came back from the background the
   * mirror kept single characters missing mid-line ("110 +" drawn as "10")
   * and never recovered on its own, because the WebView survives and so
   * nothing re-inits. The refit button repaired it completely, so the pane
   * sends that same message itself on foreground.
   */
  it('refits on returning to the foreground, so a mirror with dropped glyphs repairs itself', async () => {
    retainTerminal('sess-1');
    setTerminalDimensions('sess-1', { cols: 120, rows: 30 });
    await renderPaneAndReady(true);
    webViewMock.__postMessageMock.mockClear();

    act(() => emitAppState('background'));
    expect(decodedPosts().some((message) => message?.type === 'refit')).toBe(false);

    act(() => emitAppState('active'));
    expect(decodedPosts().some((message) => message?.type === 'refit')).toBe(true);
  });

  it('does not refit a pane the user is not looking at', async () => {
    retainTerminal('sess-1');
    const result = await renderPaneAndReady(true);
    rerenderPane(result, false);
    webViewMock.__postMessageMock.mockClear();

    act(() => emitAppState('active'));
    expect(decodedPosts().some((message) => message?.type === 'refit')).toBe(false);
  });

  it('drops malformed WebView messages without posting or writing', async () => {
    retainTerminal('sess-1');
    await renderPaneAndReady();
    webViewMock.__postMessageMock.mockClear();

    postFromWebView('not json at all');

    expect(webViewMock.__postMessageMock).not.toHaveBeenCalled();
    expect(actionsMock.writeTerminal).not.toHaveBeenCalled();
  });

  it('focuses the direct-key input once ready when a keyboard-focus request is pending (the "Answer in terminal" escape hatch)', async () => {
    retainTerminal('sess-1');
    useTerminalUiStore.getState().requestSessionMode('sess-1', 'terminal', { focusKeyboard: true });

    render(
      <ThemeProvider>
        <TerminalPane sessionId="sess-1" isActive />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
    // Not ready yet: the request must wait, never fire against a
    // not-yet-constructed WebView.
    expect(directKeyInputMock.__focusMock).not.toHaveBeenCalled();

    postFromWebView(JSON.stringify({ type: 'ready' }));

    await waitFor(() => expect(directKeyInputMock.__focusMock).toHaveBeenCalledTimes(1));
    // Consumed once: the store no longer carries the request.
    expect(useTerminalUiStore.getState().focusKeyboardRequestBySessionId['sess-1']).toBeUndefined();
  });

  it('never focuses the keyboard on an ordinary render (no pending focus request, e.g. a manual lens toggle)', async () => {
    retainTerminal('sess-1');
    await renderPaneAndReady();

    expect(directKeyInputMock.__focusMock).not.toHaveBeenCalled();
  });

  it('posts scroll-latest when the jump-to-latest button is pressed', async () => {
    retainTerminal('sess-1');
    await renderPaneAndReady();
    webViewMock.__postMessageMock.mockClear();

    fireEvent.press(screen.getByTestId('terminal-scroll-latest'));

    expect(decodedPosts().some((message) => message?.type === 'scroll-latest')).toBe(true);
  });

  /**
   * The reset button posts a fresh frame from the desktop first, then falls
   * back to a LOCAL refit only if that stream refresh never produces a
   * re-seed within REFIT_FALLBACK_DELAY_MS (700ms) - the offline path.
   */
  it('falls back to a local refit when the stream refresh produces no re-seed within the fallback delay', async () => {
    jest.useFakeTimers();
    try {
      retainTerminal('sess-1');
      await renderPaneAndReady();
      // Move the clock past the instant postInit() stamped during ready, so
      // the fallback's `lastInitPostAtRef.current < pressedAt` comparison is
      // not comparing against the exact same frozen millisecond.
      act(() => {
        jest.advanceTimersByTime(10);
      });
      webViewMock.__postMessageMock.mockClear();

      fireEvent.press(screen.getByTestId('terminal-refit'));
      expect(actionsMock.refreshTerminalStream).toHaveBeenCalledWith('sess-1');
      // No re-seed arrives - the stream refresh is fire-and-forget here.
      expect(decodedPosts().some((message) => message?.type === 'refit')).toBe(false);

      act(() => {
        jest.advanceTimersByTime(700);
      });

      expect(decodedPosts().some((message) => message?.type === 'refit')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not fall back to a local refit when the stream refresh produces a re-seed before the fallback delay', async () => {
    jest.useFakeTimers();
    try {
      retainTerminal('sess-1');
      await renderPaneAndReady();
      act(() => {
        jest.advanceTimersByTime(10);
      });
      webViewMock.__postMessageMock.mockClear();

      fireEvent.press(screen.getByTestId('terminal-refit'));
      expect(actionsMock.refreshTerminalStream).toHaveBeenCalledWith('sess-1');

      // The stream refresh's re-seed lands well inside the fallback delay.
      act(() => {
        jest.advanceTimersByTime(10);
        seedScrollback('sess-1', 'fresh seed');
      });
      // The re-seed itself posts an init - proof the seed actually landed.
      expect(decodedPosts().some((message) => message?.type === 'init')).toBe(true);

      act(() => {
        jest.advanceTimersByTime(700);
      });

      expect(decodedPosts().some((message) => message?.type === 'refit')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * INPUT_ECHO_WINDOW_MS: bytes arriving shortly after this pane SENT input
   * are that input's echo, and batching an echo is pure added lag. The
   * negative control (no preceding input) proves this is the ECHO fast path
   * and not batching having broken outright.
   */
  it('paints a chunk immediately after this pane sent input, skipping the batch timer', async () => {
    jest.useFakeTimers();
    try {
      retainTerminal('sess-1');
      await renderPaneAndReady();
      webViewMock.__postMessageMock.mockClear();

      // Negative control: with no preceding input, a chunk waits out the
      // CHUNK_BATCH_INTERVAL_MS (32ms) batch timer.
      act(() => appendChunk('sess-1', 'unprompted-output'));
      expect(decodedPosts().some((message) => message?.type === 'write')).toBe(false);
      act(() => {
        jest.advanceTimersByTime(32);
      });
      expect(decodedPosts().some((message) => message?.type === 'write')).toBe(true);
      webViewMock.__postMessageMock.mockClear();

      // The WebView reports it sent input (a typed key, or a scroll burst).
      postFromWebView(JSON.stringify({ type: 'input', data: 'ls' }));

      // The echo arrives inside the input-echo window: it posts immediately,
      // with zero timer advance.
      act(() => appendChunk('sess-1', 'echo-of-input'));
      const echoWrite = decodedPosts().find((message) => message?.type === 'write');
      expect(echoWrite).toBeDefined();
      if (echoWrite?.type === 'write') {
        expect(echoWrite.data).toBe('echo-of-input');
      }
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * postInit reads stickyModesBySessionId and is supposed to PREPEND the
   * restore sequence to the replayed ring - see src/terminal/modeRestore.ts
   * for why (a fullscreen TUI's startup DECSETs are long evicted from the
   * ring by the time a re-init happens). Driven end to end - a real 'modes'
   * report, then a real re-seed - rather than seeding the store directly, so
   * this exercises the WebView-report -> store -> next-init wiring, not just
   * the store or the pure sequence builder (both already covered on their
   * own in terminalUiStore.test.ts and modeRestore.test.ts).
   */
  it('replays the stored sticky-mode restore sequence ahead of the ring on the next re-seed', async () => {
    retainTerminal('sess-1');
    appendChunk('sess-1', 'ring-bytes');
    const result = await renderPaneAndReady();

    // A REAL mode transition (not a baseline): the desktop's TUI entered the
    // alternate screen with 'any' mouse tracking, SGR-encoded.
    postFromWebView(
      JSON.stringify({
        type: 'modes',
        applicationCursorKeys: false,
        mouseTrackingMode: 'any',
        mouseEncoding: 'SGR',
        alternateBuffer: true,
        initial: false,
      }),
    );

    // Take the re-seed path a tab switch exercises: away, then back.
    rerenderPane(result, false);
    webViewMock.__postMessageMock.mockClear();
    rerenderPane(result, true);

    const reseed = decodedPosts().find((message) => message?.type === 'init');
    expect(reseed).toBeDefined();
    if (reseed?.type === 'init') {
      // Hardcoded literal, not buildModeRestoreSequence: this test must stay
      // sensitive to postInit forgetting to prepend it, not to a change in
      // the sequence's own shape (modeRestore.test.ts owns that).
      expect(reseed.scrollback).toBe('\x1b[?1049h\x1b[?1003h\x1b[?1006hring-bytes');
    }
  });

  /**
   * Observed failure mode this guards: the OS kills the WebView's renderer
   * (Android render process under memory pressure, the iOS content process).
   * Without a handler, that is a permanently blank terminal - the WebView
   * instance survives in React but nothing inside it is alive to render
   * into, and nothing ever re-inits it. recoverWebView resets terminalReady
   * (tearing down the dead view's chunk subscription) and remounts a fresh
   * WebView, whose own 'ready' re-seeds normal service.
   */
  it.each(['onRenderProcessGone', 'onContentProcessDidTerminate'] as const)(
    'recovers after a killed WebView renderer (%s): stops writing into the dead view and re-seeds once a fresh page reports ready',
    async (crashPropName) => {
      jest.useFakeTimers();
      try {
        retainTerminal('sess-1');
        await renderPaneAndReady();
        webViewMock.__postMessageMock.mockClear();

        act(() => {
          webViewMock.__capturedProps.current?.[crashPropName]?.();
        });

        // The dead view's chunk subscription is torn down: bytes arriving with
        // no live WebView to render them must not be written anywhere, even
        // once the batch timer that would otherwise flush them has fully
        // elapsed (CHUNK_BATCH_INTERVAL_MS is 32ms) - advancing past it is
        // what tells "torn down" apart from "just hasn't flushed yet".
        act(() => appendChunk('sess-1', 'lost-in-the-crash'));
        act(() => {
          jest.advanceTimersByTime(100);
        });
        expect(decodedPosts().some((message) => message?.type === 'write')).toBe(false);

        // The remounted page finishes loading and reports ready: normal
        // service resumes with a fresh re-seed, proving the pane actually
        // recovered rather than staying permanently blank.
        postFromWebView(JSON.stringify({ type: 'ready' }));
        expect(decodedPosts().some((message) => message?.type === 'init')).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  /**
   * The pinch lifecycle: the WebView cannot tell reliably that a pinch is
   * happening on its own (see the long comment on pinchGesture in
   * TerminalPane.tsx), so this layer reports it, gated on numberOfTouches
   * rather than the gesture's own begin/end lifecycle. These thresholds
   * shipped broken twice before landing here (onBegin fired on the very
   * first touch of any kind; onFinalize stayed high through a full
   * lift-one-finger-and-drag motion), so pinning the >= 2 / <= 1 thresholds
   * is pinning a regression that has already happened.
   */
  describe('pinch lifecycle reports to the WebView', () => {
    it('reports pinch-active once two touches are down, not on the first', async () => {
      retainTerminal('sess-1');
      await renderPaneAndReady();
      webViewMock.__postMessageMock.mockClear();

      firePinchCallback('onTouchesDown', { numberOfTouches: 1 });
      expect(findPinchMessage()).toBeUndefined();

      firePinchCallback('onTouchesDown', { numberOfTouches: 2 });
      expect(findPinchMessage()?.active).toBe(true);
    });

    it('reports pinch-active on start unconditionally (the second-finger-mid-gesture backstop)', async () => {
      retainTerminal('sess-1');
      await renderPaneAndReady();
      webViewMock.__postMessageMock.mockClear();

      firePinchCallback('onStart');
      expect(findPinchMessage()?.active).toBe(true);
    });

    it('ends the pinch once touches drop to one, not while two remain', async () => {
      retainTerminal('sess-1');
      await renderPaneAndReady();
      webViewMock.__postMessageMock.mockClear();

      firePinchCallback('onTouchesUp', { numberOfTouches: 2 });
      expect(findPinchMessage()).toBeUndefined();

      firePinchCallback('onTouchesUp', { numberOfTouches: 1 });
      expect(findPinchMessage()?.active).toBe(false);
    });

    it('ends the pinch on cancellation once touches drop to one, not while two remain', async () => {
      retainTerminal('sess-1');
      await renderPaneAndReady();
      webViewMock.__postMessageMock.mockClear();

      firePinchCallback('onTouchesCancelled', { numberOfTouches: 2 });
      expect(findPinchMessage()).toBeUndefined();

      // 1, not 0: the boundary value is what actually distinguishes <= 1
      // from a narrower threshold - a call with 0 would pass either way.
      firePinchCallback('onTouchesCancelled', { numberOfTouches: 1 });
      expect(findPinchMessage()?.active).toBe(false);
    });

    it('always ends the pinch on finalize, regardless of touch count', async () => {
      retainTerminal('sess-1');
      await renderPaneAndReady();
      webViewMock.__postMessageMock.mockClear();

      firePinchCallback('onFinalize');
      expect(findPinchMessage()?.active).toBe(false);
    });
  });
});
