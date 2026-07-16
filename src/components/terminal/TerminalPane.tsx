import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Asset } from 'expo-asset';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { MonoText, useTheme, type TerminalPalette, type Theme } from '@/components';
import {
  decodeTerminalMessage,
  encodeHostMessage,
  type HostToTerminalMessage,
} from '@/terminal/terminalBridge';
import { parseColsFromScrollback } from '@/terminal/liveTail';
import { getBufferedData, getTerminalDimensions, subscribeChunks } from '@/state/terminalFeed';
import { useTerminalUiStore } from '@/state/terminalUiStore';
import { writeTerminal } from '@/connection/actions';

export interface TerminalPaneProps {
  sessionId: string;
  /**
   * True only while the Terminal tab is the visible page. When false the
   * WebView stops repainting: live writes are skipped (the terminalFeed ring
   * keeps buffering independently), so a hidden terminal never composites the
   * stream off-screen. On becoming visible again the pane re-seeds from the
   * ring to catch up.
   */
  isActive: boolean;
}

const DEFAULT_TERMINAL_FONT_SIZE_PX = 12;
/**
 * Pinch floor inside the WebView. Deliberately below the 11px RN text floor
 * (ui-conventions.md): this is pinch-zoomable terminal CONTENT the user
 * scales at will - the fit-to-screen first paint of a wide desktop grid needs
 * small glyphs, and a pinch enlarges any part of it instantly.
 */
const MIN_TERMINAL_FONT_SIZE_PX = 6;
// Ceiling above the fill-to-height default (which can reach ~48px for a short
// grid) so pinch-zoom has headroom and never clamp-jumps off the default.
const MAX_TERMINAL_FONT_SIZE_PX = 56;
// 32ms (~30fps) coalesces a token firehose into fewer, larger writes than 16ms
// did, halving repaint frequency at a latency the eye cannot see. Keystroke
// echo is unaffected - keys go phone->desktop directly, not through this batch.
const CHUNK_BATCH_INTERVAL_MS = 32;
const FONT_SIZE_POST_THROTTLE_MS = 50;

// Metro asset reference; ESM import syntax cannot load an html asset.
const xtermHtmlModule = require('../../terminal/xterm.html') as number;

function clampTerminalFontSize(fontSizePx: number): number {
  return Math.min(MAX_TERMINAL_FONT_SIZE_PX, Math.max(MIN_TERMINAL_FONT_SIZE_PX, fontSizePx));
}

/**
 * Maps the design-system terminal palette + semantic colors onto the xterm
 * ITheme key names the WebView glue passes straight to the Terminal
 * constructor (see src/terminal/terminalBridge.ts for why this stays a plain
 * string record).
 */
export function buildXtermTheme(palette: TerminalPalette, colors: Theme['colors']): Record<string, string> {
  return {
    background: colors.terminalBackground,
    foreground: colors.textPrimary,
    cursor: colors.accent,
    black: palette.ansiBlack,
    red: palette.ansiRed,
    green: palette.ansiGreen,
    yellow: palette.ansiYellow,
    blue: palette.ansiBlue,
    magenta: palette.ansiMagenta,
    cyan: palette.ansiCyan,
    white: palette.ansiWhite,
    brightBlack: palette.ansiBrightBlack,
    brightRed: palette.ansiBrightRed,
    brightGreen: palette.ansiBrightGreen,
    brightYellow: palette.ansiBrightYellow,
    brightBlue: palette.ansiBrightBlue,
    brightMagenta: palette.ansiBrightMagenta,
    brightCyan: palette.ansiBrightCyan,
    brightWhite: palette.ansiBrightWhite,
  };
}

/**
 * The raw interactive terminal: a FAITHFUL MIRROR of the desktop terminal.
 * An xterm.js WebView fed by the terminalFeed ring renders the desktop's
 * EXACT grid 1:1 and the glue sizes the font so the whole frame fits the
 * phone screen (nothing cut off); pinch-zoom + pan read the detail.
 *
 * It NEVER resizes the desktop PTY - a shared desktop session must not be
 * reshaped by the phone. Keyboard input typed inside the WebView flows back
 * out as 'input' and is written to the PTY (the one thing the phone sends);
 * pinch zoom adjusts the local font between 6 and 24 px.
 */
export function TerminalPane({ sessionId, isActive }: TerminalPaneProps): React.JSX.Element {
  const theme = useTheme();
  const webViewRef = useRef<WebView>(null);
  const [terminalHtmlUri, setTerminalHtmlUri] = useState<string | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  // Read inside the live-feed listener so pausing takes effect without
  // re-subscribing the feed on every tab switch.
  const isActiveRef = useRef(isActive);
  // Font size lives in refs, not state: nothing renders from it (the WebView
  // owns the glyphs), and a re-render per pinch frame would be pure waste.
  const fontSizePxRef = useRef(DEFAULT_TERMINAL_FONT_SIZE_PX);
  const pinchBaseFontSizeRef = useRef(DEFAULT_TERMINAL_FONT_SIZE_PX);
  const lastFontSizePostAtRef = useRef(0);
  const pendingChunksRef = useRef<string[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const htmlAsset = Asset.fromModule(xtermHtmlModule);
    htmlAsset
      .downloadAsync()
      .then(() => {
        if (!cancelled) setTerminalHtmlUri(htmlAsset.localUri ?? htmlAsset.uri);
      })
      .catch(() => {
        // Local assets are bundled; fall back to the packager/bundle URI.
        if (!cancelled) setTerminalHtmlUri(htmlAsset.uri);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const postToTerminal = useCallback((message: HostToTerminalMessage) => {
    webViewRef.current?.postMessage(encodeHostMessage(message));
  }, []);

  const postInit = useCallback(() => {
    const scrollback = getBufferedData(sessionId);
    const ptyDimensions = getTerminalDimensions(sessionId);
    postToTerminal({
      type: 'init',
      scrollback,
      // The desktop's exact grid. When the dims have not arrived yet (e.g.
      // mid-reconnect, before the snapshot lands) infer cols from content and
      // leave rows null; the real grid arrives shortly as a 'resize'.
      cols: ptyDimensions ? ptyDimensions.cols : parseColsFromScrollback(scrollback),
      rows: ptyDimensions ? ptyDimensions.rows : null,
      fontSizePx: fontSizePxRef.current,
      theme: buildXtermTheme(theme.terminalPalette, theme.colors),
    });
  }, [postToTerminal, sessionId, theme]);

  const flushPendingChunks = useCallback(() => {
    const joinedData = pendingChunksRef.current.join('');
    pendingChunksRef.current = [];
    if (joinedData.length > 0) postToTerminal({ type: 'write', data: joinedData });
  }, [postToTerminal]);

  const clearFlushTimer = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  // Live feed, attached only after the WebView said 'ready' (writes posted
  // before then would race the Terminal construction). Chunks batch on a
  // short timer so a fast token stream becomes one write per frame-ish.
  useEffect(() => {
    if (!terminalReady) return;
    const unsubscribe = subscribeChunks(sessionId, (event) => {
      // Paused (tab not visible): the ring keeps every byte; drop the render
      // work and re-seed from the ring when the tab becomes visible again.
      if (!isActiveRef.current) return;
      if (event.kind === 'dims') {
        // The desktop's authoritative grid (snapshot or a desktop refit).
        // Adopt it and re-fit the whole frame to screen - this is READ-ONLY;
        // the phone never sends a resize back.
        postToTerminal({ type: 'resize', cols: event.cols, rows: event.rows });
        return;
      }
      if (event.kind === 'seed') {
        // A fresh read-stream subscribe replaced the buffer: drop anything
        // queued and re-init the terminal from the new scrollback.
        pendingChunksRef.current = [];
        clearFlushTimer();
        postInit();
        return;
      }
      pendingChunksRef.current.push(event.data);
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          flushPendingChunks();
        }, CHUNK_BATCH_INTERVAL_MS);
      }
    });
    return () => {
      unsubscribe();
      clearFlushTimer();
      flushPendingChunks();
    };
  }, [terminalReady, sessionId, postInit, flushPendingChunks, clearFlushTimer, postToTerminal]);

  // Pause/resume rendering with tab visibility. When the terminal becomes the
  // visible page again, drop any queued writes and re-seed from the ring so the
  // WebView jumps straight to the latest frame it missed while paused.
  useEffect(() => {
    const wasActive = isActiveRef.current;
    isActiveRef.current = isActive;
    if (isActive && !wasActive && terminalReady) {
      pendingChunksRef.current = [];
      clearFlushTimer();
      postInit();
    }
  }, [isActive, terminalReady, postInit, clearFlushTimer]);

  // Drop this session's DECCKM state on unmount. There is nothing to release -
  // the mirror never resized the PTY.
  useEffect(() => {
    return () => {
      useTerminalUiStore.getState().clearSession(sessionId);
    };
  }, [sessionId]);

  const onWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = decodeTerminalMessage(event.nativeEvent.data);
      if (message === null) return;
      if (message.type === 'ready') {
        postInit();
        setTerminalReady(true);
        return;
      }
      if (message.type === 'modes') {
        useTerminalUiStore.getState().setApplicationCursorMode(sessionId, message.applicationCursorKeys);
        return;
      }
      if (message.type === 'font-size') {
        // The glue fit the font to the screen; keep the pinch baseline in sync
        // so the first pinch does not jump.
        const syncedFontSize = clampTerminalFontSize(Math.round(message.fontSizePx));
        fontSizePxRef.current = syncedFontSize;
        pinchBaseFontSizeRef.current = syncedFontSize;
        return;
      }
      if (message.type === 'renderer') {
        // Observability, mirroring the desktop's renderer report: WebGL is the
        // fast path; a 'dom' report means WebGL was unavailable or its context
        // was lost. Logged for now; a future devtools surface can read it.
        // eslint-disable-next-line no-console -- intentional renderer-status breadcrumb
        console.log(`[terminal] renderer for ${sessionId}: ${message.renderer}`);
        return;
      }
      // 'input': keys typed inside the xterm WebView go to the desktop PTY.
      // Failures (not connected, capability revoked) are dropped silently -
      // the connection banner is the surface for that state.
      void writeTerminal(sessionId, message.data).catch(() => undefined);
    },
    [postInit, sessionId],
  );

  /* eslint-disable react-hooks/refs, react-hooks/purity -- the pinch callbacks run on touch
     events (runOnJS), never during render; the refs carry gesture-lifetime state and Date.now()
     throttles those event posts. The lint cannot see that .onUpdate/.onEnd are event handlers. */
  const pinchGesture = Gesture.Pinch()
    .runOnJS(true)
    .onUpdate((pinchEvent) => {
      const nextFontSize = clampTerminalFontSize(Math.round(pinchBaseFontSizeRef.current * pinchEvent.scale));
      if (nextFontSize === fontSizePxRef.current) return;
      const now = Date.now();
      if (now - lastFontSizePostAtRef.current < FONT_SIZE_POST_THROTTLE_MS) return;
      lastFontSizePostAtRef.current = now;
      fontSizePxRef.current = nextFontSize;
      postToTerminal({ type: 'set-font-size', fontSizePx: nextFontSize });
    })
    .onEnd(() => {
      pinchBaseFontSizeRef.current = fontSizePxRef.current;
    });
  /* eslint-enable react-hooks/refs, react-hooks/purity */

  if (terminalHtmlUri === null) {
    return (
      <View style={[styles.loading, { backgroundColor: theme.colors.terminalBackground }]}>
        <MonoText size="caption" color="muted">
          Terminal loading...
        </MonoText>
      </View>
    );
  }

  return (
    <GestureDetector gesture={pinchGesture}>
      <View style={[styles.flex, { backgroundColor: theme.colors.terminalBackground }]}>
        <WebView
          ref={webViewRef}
          testID="terminal-webview"
          source={{ uri: terminalHtmlUri }}
          originWhitelist={['*']}
          allowFileAccess
          javaScriptEnabled
          scrollEnabled={false}
          setSupportMultipleWindows={false}
          onMessage={onWebViewMessage}
          style={[styles.flex, { backgroundColor: theme.colors.terminalBackground }]}
        />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
