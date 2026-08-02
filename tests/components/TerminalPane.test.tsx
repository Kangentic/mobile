import React from 'react';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TerminalPane } from '@/components/terminal/TerminalPane';
import { decodeHostMessage } from '@/terminal/terminalBridge';
import {
  appendChunk,
  resetTerminalFeed,
  retainTerminal,
  setTerminalDimensions,
} from '@/state/terminalFeed';
import { useTerminalUiStore } from '@/state/terminalUiStore';

jest.mock('@/connection/actions', () => ({
  writeTerminal: jest.fn().mockResolvedValue(undefined),
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

// The pinch gesture is device-only behavior; a chainable stub keeps the
// component renderable while the real zoom is covered by the E2E checklist.
jest.mock('react-native-gesture-handler', () => {
  // A Proxy rather than a fixed method list: the builder is chainable by
  // design, so enumerating the methods in use means every new one added to the
  // component fails here as "onX is not a function" rather than as anything
  // resembling the change that caused it.
  const mockChainablePinch = (): Record<string, () => unknown> => {
    const gestureStub = new Proxy(
      {},
      {
        get: () => () => gestureStub,
      },
    ) as Record<string, () => unknown>;
    return gestureStub;
  };
  return {
    GestureDetector: ({ children }: { children: unknown }) => children,
    Gesture: { Pinch: mockChainablePinch },
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
  __capturedProps: { current: { onMessage?: (event: { nativeEvent: { data: string } }) => void } | null };
}

interface DirectKeyInputMockModule {
  __focusMock: jest.Mock;
}

const webViewMock = jest.requireMock<WebViewMockModule>('react-native-webview');
const actionsMock = jest.requireMock<{ writeTerminal: jest.Mock }>('@/connection/actions');
const directKeyInputMock = jest.requireMock<DirectKeyInputMockModule>('@/components/terminal/DirectKeyInput');

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

describe('TerminalPane (faithful mirror)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    resetTerminalFeed();
    webViewMock.__capturedProps.current = null;
    useTerminalUiStore.setState({ applicationCursorModeBySessionId: {}, focusKeyboardRequestBySessionId: {} });
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
});
