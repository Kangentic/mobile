import React from 'react';
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

jest.mock('expo-asset', () => ({
  Asset: {
    fromModule: () => ({
      uri: 'file:///assets/xterm.html',
      localUri: 'file:///assets/xterm.html',
      downloadAsync: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

// The refit IconButton renders an Ionicons glyph, whose font loader does
// `instanceof` against expo-asset's Asset class - which the mock above
// replaces with a plain object. Stub the icon set out entirely.
jest.mock('@expo/vector-icons', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return { Ionicons: (props: object) => ReactModule.createElement(View, props) };
});

// The pinch gesture is device-only behavior; a chainable stub keeps the
// component renderable while the real zoom is covered by the E2E checklist.
jest.mock('react-native-gesture-handler', () => {
  const mockChainablePinch = (): Record<string, () => unknown> => {
    const gestureStub: Record<string, () => unknown> = {};
    for (const methodName of ['runOnJS', 'onStart', 'onUpdate', 'onEnd']) {
      gestureStub[methodName] = () => gestureStub;
    }
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

interface WebViewMockModule {
  __postMessageMock: jest.Mock;
  __capturedProps: { current: { onMessage?: (event: { nativeEvent: { data: string } }) => void } | null };
}

const webViewMock = jest.requireMock<WebViewMockModule>('react-native-webview');
const actionsMock = jest.requireMock<{ writeTerminal: jest.Mock }>('@/connection/actions');

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
    jest.clearAllMocks();
    resetTerminalFeed();
    webViewMock.__capturedProps.current = null;
    useTerminalUiStore.setState({ applicationCursorModeBySessionId: {} });
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

  it('drops malformed WebView messages without posting or writing', async () => {
    retainTerminal('sess-1');
    await renderPaneAndReady();
    webViewMock.__postMessageMock.mockClear();

    postFromWebView('not json at all');

    expect(webViewMock.__postMessageMock).not.toHaveBeenCalled();
    expect(actionsMock.writeTerminal).not.toHaveBeenCalled();
  });
});
