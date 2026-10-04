import React from 'react';
import { AppState, DeviceEventEmitter, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TerminalPane } from '@/components/terminal/TerminalPane';
import { decodeHostMessage } from '@/terminal/terminalBridge';
import {
  appendChunk,
  releaseTerminal,
  resetTerminalFeed,
  retainTerminal,
  seedScrollback,
  setTerminalDimensions,
} from '@/state/terminalFeed';
import { selectTerminalPainted, useTerminalUiStore } from '@/state/terminalUiStore';
import { useChannelStore } from '@/state/channelStore';

jest.mock('@/connection/actions', () => ({
  writeTerminal: jest.fn().mockResolvedValue(undefined),
  refreshTerminalStream: jest.fn(),
}));

// The real module is a hard no-op without EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE=1
// (never set here), so mocked directly to observe the 'terminal-renderer' call's
// exact field shape - the whole point of the renderer report being routed through
// the trace rather than the bare console.log it replaced.
jest.mock('@/devsupport/connectionTrace', () => ({
  traceConnection: jest.fn(),
}));

// An in-memory stand-in keeps the component tier free of the native module and
// lets a test read back what was written: the pane used to persist a
// remembered fit size here, and nothing may be remembered across opens now.
jest.mock('expo-secure-store', () => {
  const stored = new Map<string, string>();
  return {
    getItemAsync: (key: string) => Promise.resolve(stored.get(key) ?? null),
    setItemAsync: (key: string, value: string) => {
      stored.set(key, value);
      return Promise.resolve();
    },
    __stored: stored,
  };
});

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
      onLayout?: (event: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => void;
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
const connectionTraceMock = jest.requireMock<{ traceConnection: jest.Mock }>('@/devsupport/connectionTrace');

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

/** Fires the WebView's onLayout, as the native layout pass would. */
function layoutWebView(width: number, height: number): void {
  act(() => {
    webViewMock.__capturedProps.current?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width, height } } });
  });
}

/**
 * Fires a soft-keyboard event the way the native module does: React Native's
 * Keyboard listens through a NativeEventEmitter, which delivers through the
 * device event emitter.
 */
function emitKeyboardEvent(eventName: 'keyboardWillShow' | 'keyboardDidShow' | 'keyboardWillHide' | 'keyboardDidHide'): void {
  act(() => {
    DeviceEventEmitter.emit(eventName, {
      duration: 0,
      easing: 'keyboard',
      endCoordinates: { screenX: 0, screenY: 380, width: 411, height: 300 },
    });
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
      paintedSessionIds: {},
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
   * The renderer report used to be a bare `console.log` that put the session
   * id into every release build's logcat on every terminal open - exactly
   * what the connection trace's own convention (phases, states and
   * milliseconds, never an identifier) exists to avoid. Asserted with
   * `toHaveBeenCalledWith` rather than inspecting one field, so a regression
   * that widens the fields object to include `sessionId` (or anything else)
   * fails here even though the `renderer` value itself would still read
   * correctly.
   *
   * Mutation seen failing: adding `sessionId` back into the traceConnection
   * call's fields left the call `('terminal-renderer', { renderer: 'dom',
   * sessionId: 'sess-1' })` instead of `('terminal-renderer', { renderer:
   * 'dom' })` - "expected 'traceConnection' to have been called with
   * ...received call did not match".
   */
  it('traces a renderer report with only the renderer, never the session id', async () => {
    retainTerminal('sess-1');
    await renderPaneAndReady();

    postFromWebView(JSON.stringify({ type: 'renderer', renderer: 'dom' }));

    expect(connectionTraceMock.traceConnection).toHaveBeenCalledWith('terminal-renderer', { renderer: 'dom' });
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
    // Seeded, the way a ring the screen opened always is: a re-init over a
    // painted frame waits for the snapshot (see the hold rule below).
    seedScrollback('sess-1', 'first');
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
   * nothing re-inits. A refit used to repair it by relaying the frame out;
   * with the fit deterministic a refit changes nothing, so the pane asks for
   * the repaint directly. NOT a refit: a refit on every foreground is what
   * used to undo a pinch and re-run the fit from scratch.
   */
  it('asks for a repaint, not a refit, on returning to the foreground', async () => {
    retainTerminal('sess-1');
    setTerminalDimensions('sess-1', { cols: 120, rows: 30 });
    await renderPaneAndReady(true);
    webViewMock.__postMessageMock.mockClear();

    act(() => emitAppState('background'));
    expect(decodedPosts().some((message) => message?.type === 'repaint')).toBe(false);

    act(() => emitAppState('active'));
    expect(decodedPosts().some((message) => message?.type === 'repaint')).toBe(true);
    expect(decodedPosts().some((message) => message?.type === 'refit')).toBe(false);
  });

  it('does not repaint a pane the user is not looking at', async () => {
    retainTerminal('sess-1');
    const result = await renderPaneAndReady(true);
    rerenderPane(result, false);
    webViewMock.__postMessageMock.mockClear();

    act(() => emitAppState('active'));
    expect(decodedPosts().some((message) => message?.type === 'repaint')).toBe(false);
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
   * The fit button restores the fitted view at ONCE, from any state. It used
   * to wait on its stream refresh's re-seed (a one-shot any unrelated init
   * could consume) and fall back to a local refit 700 ms later, which with the
   * grid unknown could only stretch the line height. Now the refit goes out on
   * the press, carrying the ring's grid so a page that inited before the
   * desktop reported one fits the real grid; the fresh frame still follows.
   *
   * Mutation that reddens this: drop the dims from the posted refit, or defer it.
   */
  it('posts a refit carrying the ring grid on the press, and asks for a fresh frame', async () => {
    retainTerminal('sess-1');
    setTerminalDimensions('sess-1', { cols: 120, rows: 30 });
    await renderPaneAndReady();
    webViewMock.__postMessageMock.mockClear();

    fireEvent.press(screen.getByTestId('terminal-refit'));

    expect(decodedPosts()).toEqual([{ type: 'refit', cols: 120, rows: 30 }]);
    expect(actionsMock.refreshTerminalStream).toHaveBeenCalledWith('sess-1');
  });

  it('posts a refit with an unknown grid as nulls rather than skipping the press', async () => {
    retainTerminal('sess-1');
    await renderPaneAndReady();
    webViewMock.__postMessageMock.mockClear();

    fireEvent.press(screen.getByTestId('terminal-refit'));

    expect(decodedPosts()).toEqual([{ type: 'refit', cols: null, rows: null }]);
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
    seedScrollback('sess-1', 'ring-bytes');
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
   * THE HOLD RULE and the paint report. A session swap used to reach the
   * WebView as an empty init (a fresh PTY's seed is empty or escape-only) and
   * then a write of the successor's bytes into the predecessor's grid, so the
   * user saw the old frame, a blank grid, then the TUI's first paint. The pane
   * now never posts an init that would replace a painted frame with a blank
   * one, and the page reports back when a NON-BLANK frame is on screen,
   * attributed to the init it answers by seq.
   */
  describe('the hold rule and the paint report', () => {
    it('stamps every init with a monotonically increasing seq', async () => {
      retainTerminal('sess-1');
      seedScrollback('sess-1', 'hello');
      const result = await renderPaneAndReady();
      rerenderPane(result, false);
      rerenderPane(result, true);

      const initSeqs = decodedPosts().flatMap((message) => (message?.type === 'init' ? [message.seq] : []));
      expect(initSeqs).toEqual([1, 2]);
    });

    /**
     * The seed half of the hold. The desktop pushes live output the moment a
     * subscription exists and answers the subscribe with the scrollback a beat
     * later, so a successor's first visible chunk can land BEFORE its seed. An
     * init built from that chunk painted, the veil let go, and the seed's own
     * init then reset the grid and replayed it: a black grid for about a
     * second, in the open, measured live on a column move. Chunks that beat
     * the seed must therefore never release the hold; the seed inits.
     */
    it('holds visible chunks that arrive before the seed, then inits once from the seed', async () => {
      jest.useFakeTimers();
      try {
        retainTerminal('sess-1');
        seedScrollback('sess-1', 'painted frame');
        const result = await renderPaneAndReady();
        // Away and back with the ring released underneath: the pane comes back
        // to a fresh, unseeded ring with the old frame still on screen - the
        // same shape as a successor's ring right after a swap. Live output has
        // ALREADY landed in it by the time the pane looks (the re-init path's
        // own check), and more lands while the hold is up (the chunk path's).
        rerenderPane(result, false);
        releaseTerminal('sess-1');
        retainTerminal('sess-1');
        appendChunk('sess-1', 'early live output');
        webViewMock.__postMessageMock.mockClear();
        rerenderPane(result, true);
        expect(decodedPosts()).toEqual([]);

        act(() => appendChunk('sess-1', 'more live output'));
        act(() => {
          jest.advanceTimersByTime(100);
        });
        // Glyphs twice over, but no snapshot yet: nothing may reach the WebView.
        expect(decodedPosts()).toEqual([]);

        act(() => seedScrollback('sess-1', 'the snapshot'));
        const posts = decodedPosts();
        expect(posts).toHaveLength(1);
        expect(posts[0]?.type).toBe('init');
        if (posts[0]?.type === 'init') expect(posts[0].scrollback).toBe('the snapshot');
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * A re-init over a painted frame HOLDS that frame until the new one paints
     * (the swap's no-black-flash), and a re-init of the same session keeps a
     * pinch. A fresh page has nothing to hold and no pinch to keep. The size
     * itself is no longer the host's to send: the page owns the cell.
     */
    it('holds the frame and keeps a pinch on a same-session re-init, never on a fresh page', async () => {
      retainTerminal('sess-1');
      seedScrollback('sess-1', 'hello');
      const result = await renderPaneAndReady();
      rerenderPane(result, false);
      rerenderPane(result, true);

      const flagsByInit = decodedPosts().flatMap((message) =>
        message?.type === 'init' ? [{ holdFrame: message.holdFrame, preservePinch: message.preservePinch }] : [],
      );
      expect(flagsByInit).toEqual([
        { holdFrame: false, preservePinch: false },
        { holdFrame: true, preservePinch: true },
      ]);
    });

    /**
     * The first frame of every open is the final cell: the WebView's layout
     * is measured before the page reports ready, so the very first init
     * carries the Terminal lens's height and the page never fits to its own
     * provisional innerHeight and corrects a quarter second later.
     *
     * Mutation that reddens this: drop fitHeightPx from postInit's init.
     */
    it('carries the measured Terminal lens height on the very first init', async () => {
      retainTerminal('sess-1');
      seedScrollback('sess-1', 'hello');
      render(
        <ThemeProvider>
          <TerminalPane sessionId="sess-1" isActive />
        </ThemeProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
      layoutWebView(411, 635);
      postFromWebView(JSON.stringify({ type: 'ready' }));

      const firstInit = decodedPosts().find((message) => message?.type === 'init');
      expect(firstInit?.type === 'init' ? firstInit.fitHeightPx : 'no init').toBe(635);
    });

    /**
     * A layout that lands in the same tick as the page's 'ready', before the
     * commit that 'ready' schedules has run its passive effects, must still
     * reach the live page. The 'ready' handler posts the init (which carried no
     * height: no layout had landed yet) and the layout handler then has a page
     * to tell, but only if the ready flag the layout handler reads was written
     * by the 'ready' handler itself. It used to be synced only by a passive
     * effect, so this layout read false, was recorded and never posted, and the
     * page sat on its own provisional height until the next unrelated layout.
     *
     * Both calls are inside ONE act(): React batches the setTerminalReady(true)
     * and runs neither a render nor a passive effect until the callback
     * returns, which is what makes the gap between the two calls real.
     *
     * Mutation that reddens this: delete `terminalReadyRef.current = true;` from
     * the 'ready' branch of onWebViewMessage.
     */
    it('tells a page that just reported ready its fit height when a layout lands in the same tick', async () => {
      retainTerminal('sess-1');
      seedScrollback('sess-1', 'hello');
      render(
        <ThemeProvider>
          <TerminalPane sessionId="sess-1" isActive />
        </ThemeProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());

      act(() => {
        const liveProps = webViewMock.__capturedProps.current;
        liveProps?.onMessage?.({ nativeEvent: { data: JSON.stringify({ type: 'ready' }) } });
        liveProps?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 411, height: 635 } } });
      });

      // The precondition that makes this the race: the init the page got
      // carried no height, so the post below is its only way to learn one.
      const firstInit = decodedPosts().find((message) => message?.type === 'init');
      expect(firstInit?.type === 'init' ? firstInit.fitHeightPx : 'no init').toBeNull();
      expect(decodedPosts().filter((message) => message?.type === 'fit-height')).toEqual([
        { type: 'fit-height', fitHeightPx: 635 },
      ]);
    });

    /**
     * THE CLIPPED STATUS LINE. A layout that is ever taller than the settled
     * pane must not become the fit height for good: the first version kept a
     * per-width maximum, and on a release build the first open of a 210x48
     * session fitted to 693 against a 670 pane, cutting off the last row.
     *
     * Mutation that reddens this: keep the maximum of the heights instead of
     * the latest.
     */
    it('fits the settled pane, not a taller layout that came before it', async () => {
      retainTerminal('sess-1');
      seedScrollback('sess-1', 'hello');
      render(
        <ThemeProvider>
          <TerminalPane sessionId="sess-1" isActive />
        </ThemeProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
      layoutWebView(411, 693);
      layoutWebView(411, 670);
      postFromWebView(JSON.stringify({ type: 'ready' }));

      const firstInit = decodedPosts().find((message) => message?.type === 'init');
      expect(firstInit?.type === 'init' ? firstInit.fitHeightPx : 'no init').toBe(670);

      // And after ready: a transient taller pane is followed back down.
      webViewMock.__postMessageMock.mockClear();
      layoutWebView(411, 693);
      layoutWebView(411, 670);
      expect(decodedPosts().filter((message) => message?.type === 'fit-height')).toEqual([
        { type: 'fit-height', fitHeightPx: 693 },
        { type: 'fit-height', fitHeightPx: 670 },
      ]);
    });

    /**
     * iOS pads the screen on keyboardWillShow, BEFORE keyboardDidShow, so a
     * gate on the Did events alone (Keyboard.isVisible()) would take the
     * padded pane as the fit height there.
     */
    it("ignores a layout padded on iOS's keyboardWillShow, before keyboardDidShow", async () => {
      retainTerminal('sess-1');
      seedScrollback('sess-1', 'hello');
      render(
        <ThemeProvider>
          <TerminalPane sessionId="sess-1" isActive />
        </ThemeProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
      layoutWebView(411, 635);
      postFromWebView(JSON.stringify({ type: 'ready' }));
      webViewMock.__postMessageMock.mockClear();

      emitKeyboardEvent('keyboardWillShow');
      layoutWebView(411, 380);
      emitKeyboardEvent('keyboardDidShow');
      emitKeyboardEvent('keyboardWillHide');
      layoutWebView(411, 635);
      emitKeyboardEvent('keyboardDidHide');

      expect(decodedPosts().some((message) => message?.type === 'fit-height')).toBe(false);
    });

    /**
     * Only a layout the lens is actually read at becomes the fit height. The
     * soft keyboard (a KeyboardAvoidingView pads the screen) is gated on its
     * own events; a rotation is a new value; and a layout taken while another
     * lens shows, or while the swap veil has dropped the quick-key row, is a
     * different pane height entirely.
     */
    it('reports a rotation, and ignores the keyboard and layouts the lens is not read at', async () => {
      retainTerminal('sess-1');
      seedScrollback('sess-1', 'hello');
      const result = render(
        <ThemeProvider>
          <TerminalPane sessionId="sess-1" isActive fitLayoutIsReference />
        </ThemeProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
      layoutWebView(411, 635);
      postFromWebView(JSON.stringify({ type: 'ready' }));
      webViewMock.__postMessageMock.mockClear();

      // The keyboard opens (Android's order): same width, shorter. Not a fit
      // height, and the closed pane after it is the same one as before.
      emitKeyboardEvent('keyboardDidShow');
      layoutWebView(411, 380);
      emitKeyboardEvent('keyboardDidHide');
      layoutWebView(411, 635);
      // The veil's switcher-only phase: taller, but not a reference layout.
      result.rerender(
        <ThemeProvider>
          <TerminalPane sessionId="sess-1" isActive fitLayoutIsReference={false} />
        </ThemeProvider>,
      );
      layoutWebView(411, 690);
      expect(decodedPosts().some((message) => message?.type === 'fit-height')).toBe(false);

      // Back to the reference footer, then a rotation: a new width's height.
      result.rerender(
        <ThemeProvider>
          <TerminalPane sessionId="sess-1" isActive fitLayoutIsReference />
        </ThemeProvider>,
      );
      layoutWebView(845, 300);
      expect(decodedPosts().filter((message) => message?.type === 'fit-height')).toEqual([
        { type: 'fit-height', fitHeightPx: 300 },
      ]);
    });

    /**
     * A pane that mounts under another lens (a push tap onto a remembered Chat
     * lens) takes that lens's layout PROVISIONALLY. Chat's footer matches
     * Terminal's, so the switch to Terminal fires no layout event, and this
     * used to leave the page on its own running maximum (fitHeightPx=n/a on a
     * release build).
     *
     * Mutation that reddens this: restore the isActive gate on the layout.
     */
    it('takes a layout from another lens provisionally, until the Terminal lens measures one', async () => {
      retainTerminal('sess-1');
      seedScrollback('sess-1', 'hello');
      const result = render(
        <ThemeProvider>
          <TerminalPane sessionId="sess-1" isActive={false} />
        </ThemeProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
      layoutWebView(411, 669);
      postFromWebView(JSON.stringify({ type: 'ready' }));

      const firstInit = decodedPosts().find((message) => message?.type === 'init');
      expect(firstInit?.type === 'init' ? firstInit.fitHeightPx : 'no init').toBe(669);

      // The taller Changes pane, still provisional: the latest layout wins...
      webViewMock.__postMessageMock.mockClear();
      layoutWebView(411, 718);
      // ...and the Terminal lens's own layout overrides it.
      result.rerender(
        <ThemeProvider>
          <TerminalPane sessionId="sess-1" isActive />
        </ThemeProvider>,
      );
      layoutWebView(411, 669);
      expect(decodedPosts().filter((message) => message?.type === 'fit-height')).toEqual([
        { type: 'fit-height', fitHeightPx: 718 },
        { type: 'fit-height', fitHeightPx: 669 },
      ]);
    });

    /**
     * Once the Terminal lens has measured, another lens's layout at the same
     * width cannot move it (a composer grown with a multi-line draft shrinks
     * the shared box), while a new width is a rotation and does.
     *
     * Mutation that reddens this: drop the authoritative-value guard.
     */
    it('keeps a Terminal-lens height against other lenses at the same width, but follows a rotation', async () => {
      retainTerminal('sess-1');
      seedScrollback('sess-1', 'hello');
      const result = render(
        <ThemeProvider>
          <TerminalPane sessionId="sess-1" isActive />
        </ThemeProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
      layoutWebView(411, 669);
      postFromWebView(JSON.stringify({ type: 'ready' }));
      result.rerender(
        <ThemeProvider>
          <TerminalPane sessionId="sess-1" isActive={false} />
        </ThemeProvider>,
      );
      webViewMock.__postMessageMock.mockClear();

      layoutWebView(411, 600);
      expect(decodedPosts().some((message) => message?.type === 'fit-height')).toBe(false);

      layoutWebView(845, 300);
      expect(decodedPosts().filter((message) => message?.type === 'fit-height')).toEqual([
        { type: 'fit-height', fitHeightPx: 300 },
      ]);
    });

    /**
     * A layout event with no size in it (a collapsed or not-yet-laid-out box)
     * says nothing about the Terminal lens, and recording it would tell the page
     * to fit a pane of zero height. The last real height has to stand, both for
     * the live page and for the next init that carries it.
     *
     * Mutation that reddens this: delete the `if (!(width > 0) || !(height > 0))
     * return;` guard from onWebViewLayout (a fit-height of 0 is posted).
     */
    it('ignores a layout that carries no size, and keeps the last real fit height', async () => {
      retainTerminal('sess-1');
      seedScrollback('sess-1', 'hello');
      const result = render(
        <ThemeProvider>
          <TerminalPane sessionId="sess-1" isActive />
        </ThemeProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
      layoutWebView(411, 635);
      postFromWebView(JSON.stringify({ type: 'ready' }));
      webViewMock.__postMessageMock.mockClear();

      layoutWebView(0, 0);
      layoutWebView(411, 0);
      layoutWebView(0, 635);
      expect(decodedPosts().filter((message) => message?.type === 'fit-height')).toEqual([]);

      // The consumer of the stored height: the re-init on becoming active again.
      rerenderPane(result, false);
      rerenderPane(result, true);
      const reinit = decodedPosts().find((message) => message?.type === 'init');
      expect(reinit?.type === 'init' ? reinit.fitHeightPx : 'no init').toBe(635);
    });

    /**
     * The fit height is for a LIVE page. Before the page reports ready the
     * measurement is only recorded (the ready init carries it), so nothing is
     * posted at a page that has not loaded.
     *
     * Mutation that reddens this: post fit-height from onWebViewLayout
     * regardless of the ready flag.
     */
    it('records a layout that lands before the page is ready without posting it', async () => {
      retainTerminal('sess-1');
      seedScrollback('sess-1', 'hello');
      render(
        <ThemeProvider>
          <TerminalPane sessionId="sess-1" isActive />
        </ThemeProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());

      layoutWebView(411, 635);

      expect(decodedPosts().filter((message) => message?.type === 'fit-height')).toEqual([]);
      postFromWebView(JSON.stringify({ type: 'ready' }));
      const firstInit = decodedPosts().find((message) => message?.type === 'init');
      expect(firstInit?.type === 'init' ? firstInit.fitHeightPx : 'no init').toBe(635);
    });

    /**
     * The mirror image of the same-tick ready race above: a layout that lands in
     * the same tick as the OS killing the renderer finds a page that is gone,
     * and the passive effect that would clear the ready flag has not run yet,
     * so recoverWebView has to clear it itself. The height is still recorded,
     * and the remounted page's ready init carries it.
     *
     * Mutation that reddens this: delete `terminalReadyRef.current = false;`
     * from recoverWebView.
     */
    it('posts nothing at a page whose renderer was just lost, and hands the height to the remounted one', async () => {
      retainTerminal('sess-1');
      seedScrollback('sess-1', 'hello');
      await renderPaneAndReady();
      layoutWebView(411, 635);
      webViewMock.__postMessageMock.mockClear();

      act(() => {
        const liveProps = webViewMock.__capturedProps.current;
        liveProps?.onRenderProcessGone?.();
        liveProps?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 411, height: 650 } } });
      });
      expect(decodedPosts().filter((message) => message?.type === 'fit-height')).toEqual([]);

      postFromWebView(JSON.stringify({ type: 'ready' }));
      const remountedInit = decodedPosts().find((message) => message?.type === 'init');
      expect(remountedInit?.type === 'init' ? remountedInit.fitHeightPx : 'no init').toBe(650);
    });

    /**
     * Nothing about the size is remembered any more: a fit report only keeps
     * the pinch baseline on the size the page shows (so the next pinch starts
     * from it rather than jumping) and feeds the release-build trace.
     */
    it('keeps the pinch baseline on the reported fit and traces it', async () => {
      retainTerminal('sess-1');
      seedScrollback('sess-1', 'hello');
      await renderPaneAndReady();
      webViewMock.__postMessageMock.mockClear();

      postFromWebView(JSON.stringify({ type: 'font-size', fontSizePx: 10, source: 'settled', trigger: 'init' }));
      expect(connectionTraceMock.traceConnection).toHaveBeenCalledWith(
        'terminal-fit',
        expect.objectContaining({ source: 'settled', trigger: 'init', fontSizePx: 10 }),
      );
      // Nothing is remembered across opens: the fit is a pure function of the
      // grid and the pane, so a fit report writes nothing anywhere.
      const secureStore = jest.requireMock<{ __stored: Map<string, string> }>('expo-secure-store');
      expect([...secureStore.__stored.keys()]).toEqual([]);

      firePinchCallback('onUpdate', { numberOfTouches: 2, scale: 2 } as unknown as { numberOfTouches: number });
      expect(decodedPosts()).toContainEqual({ type: 'set-font-size', fontSizePx: 20 });
    });

    it('marks the session painted only on a non-blank report that answers the latest init', async () => {
      retainTerminal('sess-1');
      appendChunk('sess-1', 'hello');
      await renderPaneAndReady();

      // Blank: the page is up, but nothing is on screen yet.
      postFromWebView(JSON.stringify({ type: 'painted', seq: 1, blank: true }));
      expect(selectTerminalPainted(useTerminalUiStore.getState(), 'sess-1')).toBe(false);
      // A stale seq: a late report for an init this pane has since superseded.
      postFromWebView(JSON.stringify({ type: 'painted', seq: 0, blank: false }));
      expect(selectTerminalPainted(useTerminalUiStore.getState(), 'sess-1')).toBe(false);

      postFromWebView(JSON.stringify({ type: 'painted', seq: 1, blank: false }));
      expect(selectTerminalPainted(useTerminalUiStore.getState(), 'sess-1')).toBe(true);
    });

    it('holds an empty same-session re-seed until visible bytes arrive, instead of painting a blank grid', async () => {
      jest.useFakeTimers();
      try {
        retainTerminal('sess-1');
        appendChunk('sess-1', 'hello');
        await renderPaneAndReady();
        webViewMock.__postMessageMock.mockClear();

        // The stream refresh came back with nothing: the frame on screen stays.
        act(() => seedScrollback('sess-1', ''));
        expect(decodedPosts()).toEqual([]);
        // An escape-only chunk still paints nothing - and it must not be
        // WRITTEN into the held frame either, even once the batch timer fires.
        act(() => appendChunk('sess-1', '\x1b[2J'));
        act(() => {
          jest.advanceTimersByTime(100);
        });
        expect(decodedPosts()).toEqual([]);

        act(() => appendChunk('sess-1', 'world'));
        const posts = decodedPosts();
        expect(posts).toHaveLength(1);
        expect(posts[0]?.type).toBe('init');
        if (posts[0]?.type === 'init') {
          // ONE init carrying the whole ring, not a write of the last chunk.
          expect(posts[0].scrollback).toBe('\x1b[2Jworld');
        }
      } finally {
        jest.useRealTimers();
      }
    });

    it('posts no init on re-activation when the ring was released underneath a painted frame', async () => {
      retainTerminal('sess-1');
      appendChunk('sess-1', 'hello');
      const result = await renderPaneAndReady();
      rerenderPane(result, false);
      releaseTerminal('sess-1');
      webViewMock.__postMessageMock.mockClear();

      rerenderPane(result, true);

      expect(decodedPosts().some((message) => message?.type === 'init')).toBe(false);
    });
  });

  /**
   * A black terminal used to need the screen remounted (back out and re-open,
   * or kill the app). The pane now checks every init after a deadline and
   * repairs the one thing that is actually wrong. Mutations that redden these:
   * drop the armBlankRecovery() call from postInit (both positive cases), or key
   * the dead-page arm on a `blank` report instead of on silence (the negative).
   */
  describe('a path back from a black terminal', () => {
    const RECOVERY_DELAY_MS = 5000;
    // jest's react-native mock defines AppState.currentState as a function, not
    // the status string the app reads; pin the foreground for these cases.
    const appStateRecord = AppState as unknown as { currentState: unknown };
    let originalCurrentState: unknown;

    function foreground(): void {
      appStateRecord.currentState = 'active';
    }

    function liveForegroundChannel(): void {
      useChannelStore.setState({ established: true });
      foreground();
    }

    beforeEach(() => {
      originalCurrentState = appStateRecord.currentState;
    });

    afterEach(() => {
      appStateRecord.currentState = originalCurrentState;
      act(() => useChannelStore.getState().reset());
    });

    it('asks the desktop for a fresh frame when the ring never gets a seed, at most twice', async () => {
      jest.useFakeTimers();
      try {
        liveForegroundChannel();
        retainTerminal('sess-1');
        await renderPaneAndReady();
        // The page is alive and honestly blank: nothing ever arrived.
        postFromWebView(JSON.stringify({ type: 'painted', seq: 1, blank: true }));

        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS);
        });
        expect(actionsMock.refreshTerminalStream).toHaveBeenCalledTimes(1);
        expect(actionsMock.refreshTerminalStream).toHaveBeenCalledWith('sess-1');

        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS * 3);
        });
        expect(actionsMock.refreshTerminalStream).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('remounts the page when an init gets no paint report of any kind', async () => {
      jest.useFakeTimers();
      try {
        liveForegroundChannel();
        retainTerminal('sess-1');
        seedScrollback('sess-1', 'the frame');
        await renderPaneAndReady();
        // No 'painted' report for init 1: the renderer is gone.

        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS);
        });

        expect(connectionTraceMock.traceConnection).toHaveBeenCalledWith('terminal-recovery', { action: 'remount', attempt: 1 });
        expect(actionsMock.refreshTerminalStream).not.toHaveBeenCalled();
        // The remounted page reports ready and is re-inited from the ring.
        webViewMock.__postMessageMock.mockClear();
        postFromWebView(JSON.stringify({ type: 'ready' }));
        const reinit = decodedPosts().find((message) => message?.type === 'init');
        expect(reinit?.type === 'init' ? reinit.scrollback : null).toBe('the frame');
      } finally {
        jest.useRealTimers();
      }
    });

    it('leaves a healthy page alone when it reports blank over a seeded ring (a cleared screen)', async () => {
      jest.useFakeTimers();
      try {
        liveForegroundChannel();
        retainTerminal('sess-1');
        seedScrollback('sess-1', 'old output\x1b[2J');
        await renderPaneAndReady();
        // The viewport really is blank after the clear; the page says so.
        postFromWebView(JSON.stringify({ type: 'painted', seq: 1, blank: true }));

        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS * 3);
        });

        expect(connectionTraceMock.traceConnection).not.toHaveBeenCalledWith('terminal-recovery', expect.anything());
        expect(actionsMock.refreshTerminalStream).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('does nothing while the channel is down, and checks again once it is established', async () => {
      jest.useFakeTimers();
      try {
        foreground();
        retainTerminal('sess-1');
        await renderPaneAndReady();
        postFromWebView(JSON.stringify({ type: 'painted', seq: 1, blank: true }));

        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS * 3);
        });
        expect(actionsMock.refreshTerminalStream).not.toHaveBeenCalled();

        act(() => useChannelStore.setState({ established: true }));
        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS);
        });
        expect(actionsMock.refreshTerminalStream).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * Only the visible page repairs itself. A hidden terminal (the user is on
     * Chat) has a WebView that paints nothing and a deadline that still fires;
     * remounting it or asking the desktop for a frame on its behalf would spend
     * the attempt budget and wire traffic on a surface nobody is looking at,
     * and leave nothing for the moment it is shown. Both repairs are checked,
     * and each ends on a positive control (the same pane, once shown, DOES
     * repair, on attempt 1) so a deadline that never fired would not read as a
     * pass.
     *
     * Mutation that reddens these: remove `!isActiveRef.current ||` from the
     * guard at the top of runBlankRecovery.
     */
    it('never remounts a hidden pane whose page is silent, and still has its whole budget once shown', async () => {
      jest.useFakeTimers();
      try {
        liveForegroundChannel();
        retainTerminal('sess-1');
        seedScrollback('sess-1', 'the frame');
        const result = await renderPaneAndReady(false);
        // No 'painted' report for init 1: the page is silent. Hidden, so it is
        // nobody's problem.

        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS * 3);
        });
        expect(connectionTraceMock.traceConnection).not.toHaveBeenCalledWith('terminal-recovery', expect.anything());
        expect(actionsMock.refreshTerminalStream).not.toHaveBeenCalled();

        // Shown: the reactivate init re-arms the check, the page is still
        // silent for it, and the repair runs with the attempts untouched.
        rerenderPane(result, true);
        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS);
        });
        expect(connectionTraceMock.traceConnection).toHaveBeenCalledWith('terminal-recovery', {
          action: 'remount',
          attempt: 1,
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('never asks the desktop for a frame on behalf of a hidden pane whose ring was never seeded', async () => {
      jest.useFakeTimers();
      try {
        liveForegroundChannel();
        retainTerminal('sess-1');
        const result = await renderPaneAndReady(false);
        // The page is alive and honestly blank: nothing ever arrived.
        postFromWebView(JSON.stringify({ type: 'painted', seq: 1, blank: true }));

        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS * 3);
        });
        expect(actionsMock.refreshTerminalStream).not.toHaveBeenCalled();
        expect(connectionTraceMock.traceConnection).not.toHaveBeenCalledWith('terminal-recovery', expect.anything());

        // Shown: the reactivate init is seq 2, and the page answers it blank
        // too, so the only thing wrong is the missing seed.
        rerenderPane(result, true);
        postFromWebView(JSON.stringify({ type: 'painted', seq: 2, blank: true }));
        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS);
        });
        expect(actionsMock.refreshTerminalStream).toHaveBeenCalledTimes(1);
        expect(actionsMock.refreshTerminalStream).toHaveBeenCalledWith('sess-1');
        expect(connectionTraceMock.traceConnection).toHaveBeenCalledWith('terminal-recovery', {
          action: 'refresh',
          attempt: 1,
        });
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * The attempt budget belongs to an EPISODE, and a non-blank paint is what
     * ends one: the frame is on screen, so whatever was wrong is over. Without
     * the reset a pane that burned both attempts once could never repair
     * itself again for the rest of its life, however many separate failures
     * followed.
     *
     * Mutation that reddens this: delete `blankRecoveryAttemptsRef.current = 0;`
     * from the `if (!message.blank)` block of the painted handler.
     */
    it('gives a later episode a fresh repair budget once a non-blank paint ended the earlier one', async () => {
      jest.useFakeTimers();
      try {
        liveForegroundChannel();
        retainTerminal('sess-1');
        await renderPaneAndReady();
        postFromWebView(JSON.stringify({ type: 'painted', seq: 1, blank: true }));

        // Episode one spends the whole budget (two attempts) and then stops,
        // however long it is left.
        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS * 5);
        });
        expect(actionsMock.refreshTerminalStream).toHaveBeenCalledTimes(2);

        // The page finally paints real content for the current init: over.
        postFromWebView(JSON.stringify({ type: 'painted', seq: 1, blank: false }));

        // A separate, later failure: back from the background re-arms the
        // check while the ring is still unseeded.
        act(() => emitAppState('active'));
        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS);
        });
        expect(actionsMock.refreshTerminalStream).toHaveBeenCalledTimes(3);
        expect(connectionTraceMock.traceConnection).toHaveBeenLastCalledWith('terminal-recovery', {
          action: 'refresh',
          attempt: 1,
        });
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * A new SESSION is a new episode too, even when the old one never ended: a
     * predecessor that burned both repairs without ever painting must not leave
     * its successor (the desktop respawned the task) with no repair at all. The
     * trace's `attempt: 1` is what proves the budget was reset, rather than
     * merely that some call went out.
     *
     * Mutation that reddens this: delete `if (sessionChanged)
     * blankRecoveryAttemptsRef.current = 0;` from the session-swap effect.
     */
    it('gives a swapped-in session its own repair budget, even when the predecessor spent both', async () => {
      jest.useFakeTimers();
      try {
        liveForegroundChannel();
        retainTerminal('sess-1');
        const result = await renderPaneAndReady();
        postFromWebView(JSON.stringify({ type: 'painted', seq: 1, blank: true }));

        // The predecessor spends its whole budget and never paints.
        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS * 5);
        });
        expect(actionsMock.refreshTerminalStream).toHaveBeenCalledTimes(2);

        // Nothing was ever displayed, so the swap posts its init at once (seq 2)
        // rather than holding; the page answers it honestly blank.
        retainTerminal('sess-2');
        result.rerender(
          <ThemeProvider>
            <TerminalPane sessionId="sess-2" isActive />
          </ThemeProvider>,
        );
        postFromWebView(JSON.stringify({ type: 'painted', seq: 2, blank: true }));
        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS);
        });

        expect(actionsMock.refreshTerminalStream).toHaveBeenCalledTimes(3);
        expect(actionsMock.refreshTerminalStream).toHaveBeenLastCalledWith('sess-2');
        expect(connectionTraceMock.traceConnection).toHaveBeenLastCalledWith('terminal-recovery', {
          action: 'refresh',
          attempt: 1,
        });
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * A hold waiting on a seed that never comes is the frozen half of the same
     * failure, so the hold arms the check itself. The init that preceded it
     * armed one too, so the test ends THAT episode first (a non-blank paint
     * clears the pending deadline): only the hold's own arm is left to fire.
     * The refresh is for the SUCCESSOR's ring, which is the one never seeded.
     *
     * Mutation that reddens this: remove the armBlankRecovery() call from the
     * hold branch of postInitOrHold.
     */
    it('arms the deadline when an init is held, and asks for the successor frame when it fires', async () => {
      jest.useFakeTimers();
      try {
        liveForegroundChannel();
        retainTerminal('sess-1');
        seedScrollback('sess-1', 'the frame');
        const result = render(
          <ThemeProvider>
            <TerminalPane sessionId="sess-1" isActive />
          </ThemeProvider>,
        );
        await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
        postFromWebView(JSON.stringify({ type: 'ready' }));
        // The frame is on screen: this ends the episode and clears the ready
        // init's deadline.
        postFromWebView(JSON.stringify({ type: 'painted', seq: 1, blank: false }));

        // The desktop respawned the task: the successor's ring is retained
        // (the screen's open does that) but its snapshot has not landed.
        retainTerminal('sess-2');
        webViewMock.__postMessageMock.mockClear();
        result.rerender(
          <ThemeProvider>
            <TerminalPane sessionId="sess-2" isActive />
          </ThemeProvider>,
        );
        // Held: the dead session's frame stays, nothing is posted over it.
        expect(decodedPosts().some((message) => message?.type === 'init')).toBe(false);

        act(() => {
          jest.advanceTimersByTime(RECOVERY_DELAY_MS - 1);
        });
        expect(actionsMock.refreshTerminalStream).not.toHaveBeenCalled();
        act(() => {
          jest.advanceTimersByTime(1);
        });
        expect(actionsMock.refreshTerminalStream).toHaveBeenCalledTimes(1);
        expect(actionsMock.refreshTerminalStream).toHaveBeenCalledWith('sess-2');
      } finally {
        jest.useRealTimers();
      }
    });
  });

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
