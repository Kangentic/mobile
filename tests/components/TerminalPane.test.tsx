import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TerminalPane } from '@/components/terminal/TerminalPane';
import { decodeHostMessage } from '@/terminal/terminalBridge';
import { appendChunk, resetTerminalFeed, retainTerminal } from '@/state/terminalFeed';

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

async function renderPaneAndAwaitWebView(): Promise<void> {
  render(
    <ThemeProvider>
      <TerminalPane sessionId="sess-1" />
    </ThemeProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('terminal-webview')).toBeTruthy());
}

function postFromWebView(data: string): void {
  act(() => {
    webViewMock.__capturedProps.current?.onMessage?.({ nativeEvent: { data } });
  });
}

describe('TerminalPane', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetTerminalFeed();
    webViewMock.__capturedProps.current = null;
  });

  it('posts an init with the buffered scrollback after the WebView reports ready', async () => {
    retainTerminal('sess-1');
    appendChunk('sess-1', 'hello world');
    await renderPaneAndAwaitWebView();

    postFromWebView(JSON.stringify({ type: 'ready' }));

    expect(webViewMock.__postMessageMock).toHaveBeenCalledTimes(1);
    const initMessage = decodeHostMessage(webViewMock.__postMessageMock.mock.calls[0][0] as string);
    expect(initMessage).not.toBeNull();
    expect(initMessage?.type).toBe('init');
    if (initMessage?.type === 'init') {
      expect(initMessage.scrollback).toBe('hello world');
      // 'hello world' is 11 visible columns, clamped up to the 40-column floor.
      expect(initMessage.cols).toBe(40);
      expect(initMessage.fontSizePx).toBe(12);
      expect(initMessage.theme.background).toBe('#090b0a');
    }
  });

  it('forwards input messages from the WebView to writeTerminal', async () => {
    const { writeTerminal } = jest.requireMock<{ writeTerminal: jest.Mock }>('@/connection/actions');
    retainTerminal('sess-1');
    await renderPaneAndAwaitWebView();

    postFromWebView(JSON.stringify({ type: 'input', data: 'ls' }));

    expect(writeTerminal).toHaveBeenCalledWith('sess-1', 'ls');
  });

  it('drops malformed WebView messages without posting or writing', async () => {
    const { writeTerminal } = jest.requireMock<{ writeTerminal: jest.Mock }>('@/connection/actions');
    retainTerminal('sess-1');
    await renderPaneAndAwaitWebView();

    postFromWebView('not json at all');

    expect(webViewMock.__postMessageMock).not.toHaveBeenCalled();
    expect(writeTerminal).not.toHaveBeenCalled();
  });
});
