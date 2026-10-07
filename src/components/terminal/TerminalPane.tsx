import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Asset } from 'expo-asset';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { IconButton, MonoText, useTheme, type TerminalPalette, type Theme } from '@/components';
import {
  decodeTerminalMessage,
  encodeHostMessage,
  type HostToTerminalMessage,
} from '@/terminal/terminalBridge';
import { hasVisibleContent, parseColsFromScrollback } from '@/terminal/liveTail';
import { buildModeRestoreSequence } from '@/terminal/modeRestore';
import { XTERM_BUILD_ID } from '@/terminal/xtermBuildId';
import { traceConnection } from '@/devsupport/connectionTrace';
import type { InspectTerminalHandle, InspectTerminalWriteStats } from '@/devsupport/inspectState';
import { getRetentionProbeVariant } from '@/devsupport/retentionProbe';
import {
  getBufferedData,
  getTerminalDimensions,
  hasPaintableFrame,
  hasSeed,
  subscribeChunks,
} from '@/state/terminalFeed';
import { useChannelStore } from '@/state/channelStore';
import { useReadingViewStore } from '@/state/readingViewStore';
import { useTerminalUiStore } from '@/state/terminalUiStore';
import { refreshTerminalStream, writeTerminal } from '@/connection/actions';
import { DirectKeyInput, type DirectKeyInputHandle } from './DirectKeyInput';
import { TerminalWaitOverlay } from './TerminalWaitOverlay';

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
  /**
   * Enables the WebView's clean feed (a headless second parser posting
   * readable lines into the readingViewStore) - the chat reading view for
   * sessions whose agent has no structured transcript. Off by default; a
   * flip re-inits the terminal with the flag.
   */
  cleanFeedEnabled?: boolean;
  /**
   * False while the screen's footer is in a state the Terminal lens is never
   * read in (the swap veil's switcher-only phase drops the quick-key row, so
   * the pane is TALLER than it will be once the session is back). A layout
   * measured then must not become the fit height. Defaults to true.
   */
  fitLayoutIsReference?: boolean;
}

const DEFAULT_TERMINAL_FONT_SIZE_PX = 12;
/**
 * Pinch floor inside the WebView. Deliberately below the 11px RN text floor
 * (ui-conventions.md): this is pinch-zoomable terminal CONTENT the user
 * scales at will - the fit-to-screen first paint of a wide desktop grid needs
 * small glyphs, and a pinch enlarges any part of it instantly.
 */
const MIN_TERMINAL_FONT_SIZE_PX = 6;
// Ceiling above the auto-fit default (capped at MAX_AUTO_FIT_FONT_PX = 20 in
// scripts/xterm-page/state.js) so pinch-zoom has headroom and never clamp-jumps
// off the default.
const MAX_TERMINAL_FONT_SIZE_PX = 56;
// 32ms (~30fps) coalesces a token firehose into fewer, larger writes than 16ms
// did, halving repaint frequency at a latency the eye cannot see. Keystroke
// echo is unaffected - keys go phone->desktop directly, not through this batch.
const CHUNK_BATCH_INTERVAL_MS = 32;
// While the user just SENT input (a scroll burst, a typed key), the bytes
// coming back are its ECHO, and batching an echo is pure added lag on top of
// the ~210ms hosted-relay round trip (measured 2026-08-02 against an idle
// session). Inside this window chunks paint immediately; the firehose
// batching resumes the moment the user stops interacting.
const INPUT_ECHO_WINDOW_MS = 250;
const FONT_SIZE_POST_THROTTLE_MS = 50;
/**
 * How long an init may go without its bytes or its paint report before the
 * pane repairs itself (see runBlankRecovery). CHOSEN, not measured
 * (performance-claims-are-measured.md): the nearest measured neighbour is a
 * session swap's ended-to-settled gap, 730-2466 ms with a median of 0.99 s over
 * ten release-build column moves (docs/developer-guide.md), so 5 s is twice
 * the slowest observed and sits inside SESSION_SWAP_QUIET_MS (8 s). A check
 * that finds everything healthy costs nothing.
 */
const BLANK_RECOVERY_DELAY_MS = 5000;
/** Repairs per episode before the pane stops trying and leaves it to a remount, a lens switch or the fit button. */
const BLANK_RECOVERY_MAX_ATTEMPTS = 2;

// Metro asset reference; ESM import syntax cannot load an html asset.
const xtermHtmlModule = require('../../terminal/xterm.html') as number;

/**
 * Whether the dev inspect harness is live. Same gate the rest of the inspect
 * loop uses, so the WebView eval path below is unreachable in any build a user
 * could install.
 */
const inspectEnabled = __DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_INSPECT === '1';

/** How long to wait for the WebView to answer an injected expression. */
const TERMINAL_EVAL_TIMEOUT_MS = 5000;

/**
 * Why an init was posted, carried on the `terminal-init` connection-trace
 * line so a logcat timeline can tell a swap's seed init from a chunk
 * release or a lens switch back. Names a code path, never content.
 */
type TerminalInitReason = 'ready' | 'seed' | 'chunk-release' | 'swap' | 'clean-feed' | 'reactivate';

interface PendingTerminalEval {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Settle an injected expression's reply. Returns false for anything that is not
 * an eval result, so the normal bridge decoder still sees every real message.
 */
function settleTerminalEval(rawMessage: string, pending: Map<string, PendingTerminalEval>): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  if (record.type !== 'eval-result' || typeof record.id !== 'string') return false;
  const entry = pending.get(record.id);
  if (!entry) return true;
  pending.delete(record.id);
  clearTimeout(entry.timer);
  if (record.ok === true) entry.resolve(record.value);
  else entry.reject(new Error(typeof record.error === 'string' ? record.error : 'terminal eval failed'));
  return true;
}

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
 * EXACT grid 1:1 in ONE cell size: the reference cell at which the desktop's
 * resting grid (210x48) fills the Terminal lens's height, pinned to the
 * top-left. The same font and the same position on every open of every task
 * (the maintainer's rule, 2026-10): a shorter grid sits at the top with the
 * terminal's background below it, a grid wider than the screen overflows and
 * pans horizontally (the cursor stays in view), and pinch-zoom reads the
 * detail. The PAGE owns that size (scripts/xterm-page/state.js); this host
 * only measures the lens's height for it and keeps its pinch baseline in step
 * with the page's fit reports. Nothing is remembered across opens - the fit
 * is a pure function of the grid and the pane, so there is nothing to.
 *
 * It NEVER resizes the desktop PTY - a shared desktop session must not be
 * reshaped by the phone. Keyboard input typed inside the WebView flows back
 * out as 'input' and is written to the PTY (the one thing the phone sends);
 * pinch zoom adjusts the local font between MIN_TERMINAL_FONT_SIZE_PX and
 * MAX_TERMINAL_FONT_SIZE_PX (6 to 56).
 */
export function TerminalPane({
  sessionId,
  isActive,
  cleanFeedEnabled = false,
  fitLayoutIsReference = true,
}: TerminalPaneProps): React.JSX.Element {
  const theme = useTheme();
  // `WebView<object>`, not bare `WebView`: react-native-webview 14 changed its
  // class declaration's props generic default from `{}` to `undefined`
  // (`declare class WebView<P = undefined> extends Component<WebViewProps & P>`),
  // and `WebViewProps & undefined` is `never`, so the bare type accepts no props
  // at all. A typing regression only - the runtime component is unchanged.
  // `object` restores `WebViewProps & object`, which is exactly the 13.x props.
  // Drop the explicit generic once upstream restores a usable default.
  const webViewRef = useRef<WebView<object>>(null);
  const directKeyRef = useRef<DirectKeyInputHandle>(null);
  const [terminalHtmlUri, setTerminalHtmlUri] = useState<string | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  // The same fact for handlers, written beside every setTerminalReady rather
  // than only synced by an effect: a layout landing between the 'ready' init
  // and that commit's effect would otherwise read false and never tell the
  // live page its new fit height (onWebViewLayout).
  const terminalReadyRef = useRef(false);
  // Bumped to remount the WebView after the OS kills its renderer (the
  // Android render process under memory pressure, the iOS content process).
  // Without a handler that surfaces as a native crash or a permanently blank
  // terminal; a remount reloads the page, whose 'ready' re-seeds from the ring.
  const [webViewGeneration, setWebViewGeneration] = useState(0);
  // True until this PAGE has painted a non-blank frame: the desktop's answer
  // on screen. TerminalWaitOverlay covers the pane meanwhile.
  // Pane-local and per page on purpose, never `paintedSessionIds`: on a swap
  // the bound session changes before its successor paints while the held
  // frame is still on screen, and that wait is the swap veil's to show.
  const [awaitingFirstFrame, setAwaitingFirstFrame] = useState(true);
  const recoverWebView = useCallback(() => {
    terminalReadyRef.current = false;
    setTerminalReady(false);
    setAwaitingFirstFrame(true);
    setWebViewGeneration((generation) => generation + 1);
  }, []);
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
  // When this pane last SENT input (a scroll burst, a WebView-typed key);
  // incoming chunks inside INPUT_ECHO_WINDOW_MS of it skip the batch timer.
  const lastInputSentAtRef = useRef(0);
  const pendingEvalsRef = useRef(new Map<string, PendingTerminalEval>());
  const evalSequenceRef = useRef(0);
  // PTY write outcomes, for the inspect probe. Failures are deliberately
  // swallowed at the call site (the connection banner is the user-facing
  // surface for a dropped channel), which meant a write that silently stopped
  // reaching the desktop produced NO signal anywhere - the gesture looked
  // correct, the payload looked correct, and the terminal simply did not
  // move. Counting three numbers costs nothing and turns that into a reading.
  // Per PANE, not module-level: two mounted panes (a session screen stacked
  // under another) must not mix their counts under whichever sessionId
  // happens to be registered with the inspect bridge.
  const terminalWriteStatsRef = useRef<InspectTerminalWriteStats>({
    attempts: 0,
    failures: 0,
    lastError: null,
    lastAttemptAt: 0,
  });

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

  /**
   * Run an expression inside the WebView and resolve its value.
   *
   * Everything that decides how the terminal behaves - measured grid height,
   * line height, buffer type, mouse encoding, what the last gesture computed -
   * lives in the page and is invisible from RN. This is the only way to read it
   * without a person holding the phone, which is what made the scroll work
   * guess-driven. Dev-gated at the registration site below.
   */
  const runTerminalEval = useCallback(
    (expression: string) =>
      new Promise<unknown>((resolve, reject) => {
        const webView = webViewRef.current;
        if (webView === null) {
          reject(new Error('terminal WebView is not mounted'));
          return;
        }
        evalSequenceRef.current += 1;
        const evalId = `eval-${evalSequenceRef.current}`;
        const pending = pendingEvalsRef.current;
        const timer = setTimeout(() => {
          pending.delete(evalId);
          reject(new Error('terminal eval timed out (is the page still loading?)'));
        }, TERMINAL_EVAL_TIMEOUT_MS);
        pending.set(evalId, { resolve, reject, timer });
        // The trailing `true;` is required by injectJavaScript on iOS: without a
        // primitive result the WKWebView bridge logs a warning per call.
        webView.injectJavaScript(
          `(function(){var evalId=${JSON.stringify(evalId)};` +
            `function reply(payload){window.ReactNativeWebView.postMessage(JSON.stringify(payload));}` +
            `try{var value=(${expression});` +
            `reply({type:'eval-result',id:evalId,ok:true,value:value===undefined?null:value});}` +
            `catch(evalError){reply({type:'eval-result',id:evalId,ok:false,` +
            `error:String(evalError&&evalError.message?evalError.message:evalError)});}})();true;`,
        );
      }),
    [],
  );

  // Publish this pane to the inspect bridge while it is mounted. Unmounting
  // clears it, so "no terminal pane mounted" is an honest answer rather than a
  // stale handle answering for a screen nobody is looking at.
  useEffect(() => {
    if (!inspectEnabled) return;
    let released = false;
    let registeredHandle: InspectTerminalHandle | null = null;
    void import('@/devsupport/inspectState').then((inspectStateModule) => {
      if (released) return;
      registeredHandle = {
        sessionId,
        expectedBuildId: XTERM_BUILD_ID,
        evaluate: runTerminalEval,
        writeStats: () => ({ ...terminalWriteStatsRef.current }),
      };
      inspectStateModule.setInspectTerminal(registeredHandle);
    });
    const pending = pendingEvalsRef.current;
    return () => {
      released = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('terminal pane unmounted'));
      }
      pending.clear();
      void import('@/devsupport/inspectState').then((inspectStateModule) => {
        // Only clear our OWN registration. With two panes mounted (a session
        // screen stacked under another), the covered pane's unmount must not
        // null out the visible pane's still-valid handle - that read as "no
        // terminal pane mounted" while a terminal was on screen and working.
        if (registeredHandle !== null && inspectStateModule.getInspectTerminal() === registeredHandle) {
          inspectStateModule.setInspectTerminal(null);
        }
      });
    };
  }, [sessionId, runTerminalEval]);

  // When the last init was posted, for the paint report's sinceInitMs.
  const lastInitPostAtRef = useRef(0);

  /**
   * THE FIT HEIGHT, measured here rather than in the page. The page used to
   * fit against its own window height, and two things made that a different
   * number on different opens of the same task: a fresh page's first
   * innerHeight is not final (so the first frame was fitted to a guess and
   * corrected a quarter second later, every open), and all three lenses share
   * one box whose height follows the footer (Changes has no input row), so
   * the page's running maximum learned a pane taller than the Terminal lens.
   *
   * So: the WebView's own layout height, recorded while the footer is in its
   * reference state with the soft keyboard DOWN (a KeyboardAvoidingView pads
   * the screen while it is up), from the Terminal lens or provisionally from
   * another one (see onWebViewLayout). The LATEST such layout wins, so a
   * rotation is simply a new value. onLayout fires before the page reports
   * ready, so the very first init carries it. Null only until the first
   * layout, when the page falls back to its own tracker.
   *
   * Not a running maximum, which is what this was first written as: a
   * maximum locks in any layout that is ever taller than the settled pane.
   * Measured on a release build (emulator, 2026-10-03): the first open of a
   * 210x48 session fitted to a host height of 693 while the page's own
   * innerHeight read 670, so the 695 px grid overflowed the pane and its last
   * row, the status line, was cut off. The keyboard is the only shrink a fit
   * must ignore, and it is gated directly.
   */
  const hostFitHeightRef = useRef<number | null>(null);
  // Whether that height was measured with THIS lens showing, and at which
  // width. See the provisional rule in onWebViewLayout.
  const hostFitHeightFromActiveRef = useRef(false);
  const hostFitWidthRef = useRef<number | null>(null);
  useEffect(() => {
    terminalReadyRef.current = terminalReady;
  }, [terminalReady]);
  // Whether the soft keyboard is up, by the same events the screen's
  // KeyboardAvoidingView pads on: keyboardWillShow/WillHide on iOS and
  // keyboardDidShow/DidHide on Android (the other pair never fires there).
  // Keyboard.isVisible() alone follows only the Did events, which on iOS
  // land AFTER the padded layout this gate exists to ignore.
  const keyboardVisibleRef = useRef(Keyboard.isVisible());
  useEffect(() => {
    const markShown = (): void => {
      keyboardVisibleRef.current = true;
    };
    const markHidden = (): void => {
      keyboardVisibleRef.current = false;
    };
    const subscriptions = [
      Keyboard.addListener('keyboardWillShow', markShown),
      Keyboard.addListener('keyboardDidShow', markShown),
      Keyboard.addListener('keyboardWillHide', markHidden),
      Keyboard.addListener('keyboardDidHide', markHidden),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  // Records the fit height by the rules above and tells a live page when it
  // changes - a first measurement after the page came up on another lens, a
  // settled pane after a transient one, or a rotation.
  //
  // A layout taken while ANOTHER lens shows is PROVISIONAL. All three panes
  // share one box, and Chat's footer is the same height as Terminal's, so a
  // switch from Chat to Terminal fires no layout event at all: a pane that
  // mounted under Chat (a push tap onto a remembered Chat lens) used to never
  // learn a height, and its page fell back to its own running maximum, which
  // a visit to the taller Changes pane pollutes. Measured on a release build
  // 2026-10-03 as fitHeightPx=n/a on the Terminal lens. So an inactive layout
  // is taken until a Terminal-lens layout exists; any box that really differs
  // for Terminal (Changes, a grown composer) fires a layout on the switch,
  // which then overrides it. A Terminal-lens value stays authoritative against
  // inactive layouts at the same width; a new width is a rotation, so it wins.
  //
  // The gate reads isActive and fitLayoutIsReference from the CLOSURE, not
  // from refs synced in passive effects: the handler attached to the WebView
  // is the one from the commit that produced the layout, while a passive
  // effect can run after that commit's layout event is dispatched. A ref one
  // commit stale would record the taller switcher-only pane as the reference.
  const onWebViewLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (!fitLayoutIsReference || keyboardVisibleRef.current) return;
      const { width, height } = event.nativeEvent.layout;
      if (!(width > 0) || !(height > 0)) return;
      const widthKey = Math.round(width);
      if (!isActive && hostFitHeightFromActiveRef.current && widthKey === hostFitWidthRef.current) return;
      hostFitHeightFromActiveRef.current = isActive;
      hostFitWidthRef.current = widthKey;
      const fitHeight = Math.round(height);
      if (fitHeight === hostFitHeightRef.current) return;
      traceConnection('terminal-fit-height', {
        fitHeightPx: fitHeight,
        previousPx: hostFitHeightRef.current ?? 'n/a',
        ready: terminalReadyRef.current,
        active: isActive,
      });
      hostFitHeightRef.current = fitHeight;
      if (terminalReadyRef.current) postToTerminal({ type: 'fit-height', fitHeightPx: fitHeight });
    },
    [isActive, fitLayoutIsReference, postToTerminal],
  );

  /**
   * THE HOLD RULE: never post an init that would replace a painted frame with
   * a blank grid, and never build the successor's frame from chunks its seed
   * is about to replace.
   *
   * Five refs carry it. `initSeqRef` stamps every init so the page's
   * 'painted' report can be attributed to the init it answers;
   * `lastInitSessionIdRef` is which session that init was for.
   * `displayedFrameSessionIdRef` is the session whose PAINTABLE bytes were
   * last posted (null on a fresh page, where there is nothing to protect).
   * `heldInitSessionIdRef` is a session whose init is deferred until its ring
   * is SEEDED and carries visible glyphs - the seed, swap and re-activation
   * paths all route through postInitOrHold, and the chunk listener releases
   * the hold.
   *
   * Why a hold and not a byte-count gate: a fresh PTY's first seed is often
   * escape-only (the alternate-screen switch, a clear), which has bytes and
   * paints nothing. The previous gate counted dims as a frame and posted an
   * empty grid over the dead session's last frame on every column move.
   *
   * Why the seed as well as glyphs: the desktop pushes a successor's live
   * output the moment the subscription exists and answers the subscribe with
   * the serialised scrollback a beat later. A frame built from those early
   * chunks paints, the veil lets go, and then the seed's own init resets the
   * grid and replays - measured live as a black grid for about a second, in
   * the open, on a column move. Waiting for the seed makes the successor's
   * first init its last.
   */
  const initSeqRef = useRef(0);
  const lastInitSessionIdRef = useRef<string | null>(null);
  const displayedFrameSessionIdRef = useRef<string | null>(null);
  const heldInitSessionIdRef = useRef<string | null>(null);

  /**
   * A PATH BACK FROM BLACK. Every init (and every hold) arms a deadline; when it
   * fires, the pane checks the two ways a mirror can be left with nothing on it
   * and repairs whichever applies, so a black terminal no longer needs the
   * screen remounted to recover:
   *
   * - The PAGE is dead: no paint report of ANY kind has arrived for the current
   *   init. Every init produces exactly one once its seed flushes, blank or not
   *   (scripts/xterm-page/lifecycle.js seedAndSettle, modes.js
   *   reportPaintedIfAwaiting), so silence is the precise signal - a renderer
   *   gone without onRenderProcessGone, a page that never ran the init. Remount
   *   the WebView; its 'ready' re-inits from the ring. Never keyed on a BLANK
   *   report: the page judges blankness from the viewport rows alone, and a
   *   healthy page reports blank over a paintable ring after a clear or before a
   *   TUI redraws.
   * - The BYTES never came: the ring has never been seeded since it was
   *   retained. Ask the desktop for a fresh frame. Not "the ring is empty": a
   *   seeded empty ring under a live subscription is a legitimate state.
   *
   * Only while this pane is the visible page, the app is in the foreground
   * (requestAnimationFrame, which the paint report rides, does not run in the
   * background) and the channel is established (a channel still coming up
   * cannot deliver a seed, and would burn the attempts). The reactivate init,
   * the foreground listener and the established edge re-arm it.
   */
  const lastPaintReportSeqRef = useRef<number | null>(null);
  const blankRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blankRecoveryAttemptsRef = useRef(0);
  const runBlankRecoveryRef = useRef<() => void>(() => undefined);
  const clearBlankRecovery = useCallback(() => {
    if (blankRecoveryTimerRef.current !== null) {
      clearTimeout(blankRecoveryTimerRef.current);
      blankRecoveryTimerRef.current = null;
    }
  }, []);
  const armBlankRecovery = useCallback(() => {
    clearBlankRecovery();
    blankRecoveryTimerRef.current = setTimeout(() => {
      blankRecoveryTimerRef.current = null;
      runBlankRecoveryRef.current();
    }, BLANK_RECOVERY_DELAY_MS);
  }, [clearBlankRecovery]);
  const runBlankRecovery = useCallback(() => {
    if (!isActiveRef.current || AppState.currentState !== 'active' || !useChannelStore.getState().established) return;
    const pageSilent = initSeqRef.current > 0 && lastPaintReportSeqRef.current !== initSeqRef.current;
    const neverSeeded = !hasSeed(sessionId);
    if (!pageSilent && !neverSeeded) {
      blankRecoveryAttemptsRef.current = 0;
      return;
    }
    if (blankRecoveryAttemptsRef.current >= BLANK_RECOVERY_MAX_ATTEMPTS) return;
    blankRecoveryAttemptsRef.current += 1;
    traceConnection('terminal-recovery', {
      action: pageSilent ? 'remount' : 'refresh',
      attempt: blankRecoveryAttemptsRef.current,
    });
    if (pageSilent) {
      // The remounted page's 'ready' init arms the next check.
      recoverWebView();
      return;
    }
    refreshTerminalStream(sessionId);
    armBlankRecovery();
  }, [sessionId, recoverWebView, armBlankRecovery]);
  useEffect(() => {
    runBlankRecoveryRef.current = runBlankRecovery;
  }, [runBlankRecovery]);
  useEffect(() => clearBlankRecovery, [clearBlankRecovery]);

  const postInit = useCallback(
    (reason: TerminalInitReason) => {
      lastInitPostAtRef.current = Date.now();
      initSeqRef.current += 1;
      // Hold the frame on screen across the reset whenever there is one to
      // hold; keep a pinch only across a re-init of the SAME session (a lens
      // switch back, a re-seed), never across a swap or onto a fresh page.
      const holdFrame = displayedFrameSessionIdRef.current !== null;
      const preservePinch = holdFrame && lastInitSessionIdRef.current === sessionId;
      lastInitSessionIdRef.current = sessionId;
      heldInitSessionIdRef.current = null;
      const scrollback = getBufferedData(sessionId);
      // The RAW ring decides, not the mode-restore-prefixed string below: the
      // prefix is escape sequences by construction and would count as content.
      if (hasVisibleContent(scrollback)) displayedFrameSessionIdRef.current = sessionId;
      const ptyDimensions = getTerminalDimensions(sessionId);
      traceConnection('terminal-init', {
        reason,
        cols: ptyDimensions ? ptyDimensions.cols : 'n/a',
        rows: ptyDimensions ? ptyDimensions.rows : 'n/a',
        fitHeightPx: hostFitHeightRef.current ?? 'n/a',
        holdFrame,
        preservePinch,
      });
    // Put the terminal back into the modes the desktop's TUI set once at
    // startup BEFORE replaying the tail. The feed is a ring, so those DECSETs
    // are long evicted, and without this every re-init comes up in the normal
    // buffer with mouse reporting off while the PTY is in the alternate screen
    // with it on - which silently disables history scrolling. See
    // src/terminal/modeRestore.ts for the measurements.
      const modeRestore = buildModeRestoreSequence(
        useTerminalUiStore.getState().stickyModesBySessionId[sessionId] ?? null,
      );
      postToTerminal({
        type: 'init',
        seq: initSeqRef.current,
        scrollback: modeRestore + scrollback,
        // The desktop's exact grid. When the dims have not arrived yet (e.g.
        // mid-reconnect, before the snapshot lands) infer cols from content and
        // leave rows null; the real grid arrives shortly as a 'resize'.
        cols: ptyDimensions ? ptyDimensions.cols : parseColsFromScrollback(scrollback),
        rows: ptyDimensions ? ptyDimensions.rows : null,
        fitHeightPx: hostFitHeightRef.current,
        theme: buildXtermTheme(theme.terminalPalette, theme.colors),
        cleanFeed: cleanFeedEnabled,
        holdFrame,
        preservePinch,
        // The computed fit (scripts/xterm-page/cellFit.js); the retention
        // probe's control arm selects the older measured chain.
        fitStrategy: getRetentionProbeVariant() === 'measured-fit' ? 'measured' : 'computed',
        // The page cancels the long-press menu (the "Autofill" pill); the
        // probe's control arm leaves it to the WebView.
        longPressMenuGuard: getRetentionProbeVariant() !== 'autofillable-terminal-input',
      });
      armBlankRecovery();
    },
    [postToTerminal, sessionId, theme, cleanFeedEnabled, armBlankRecovery],
  );

  /**
   * Init now, or hold until this session's ring is seeded AND can paint
   * something. With a frame on screen, an init from a ring with no visible
   * bytes is the blank grid this pane exists to never show, and an init from
   * live chunks the seed has not caught up with is a frame the seed tears
   * down a beat later; the seed listener and the chunk listener post the
   * deferred init once both hold, replaying the whole ring. A fresh page
   * (nothing displayed yet) always inits: an empty grid is the honest state
   * there, and the page's 'ready' depends on it.
   */
  const postInitOrHold = useCallback(
    (reason: TerminalInitReason) => {
      if (displayedFrameSessionIdRef.current !== null && (!hasSeed(sessionId) || !hasPaintableFrame(sessionId))) {
        heldInitSessionIdRef.current = sessionId;
        // A hold waiting on a seed that never comes is the frozen half of the
        // same failure: check on it.
        armBlankRecovery();
        return;
      }
      postInit(reason);
    },
    [postInit, sessionId, armBlankRecovery],
  );

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
        // queued and re-init the terminal from the new scrollback - unless
        // that scrollback paints nothing, in which case the frame on screen
        // stays until it does (postInitOrHold).
        pendingChunksRef.current = [];
        clearFlushTimer();
        postInitOrHold('seed');
        return;
      }
      if (heldInitSessionIdRef.current === sessionId) {
        // A held init: never WRITE into the frame on screen (it belongs to
        // another session, or to this one before its blank re-seed). The ring
        // already holds this chunk; once the ring can paint, the deferred
        // init replays all of it. The chunk alone decides the glyph half - the
        // ring had no visible bytes when the hold began, so only what arrived
        // since can change the answer - and a chunk that beat the seed never
        // releases: that seed replaces the ring, and inits from it.
        if (hasSeed(sessionId) && hasVisibleContent(event.data)) {
          pendingChunksRef.current = [];
          clearFlushTimer();
          postInit('chunk-release');
        }
        return;
      }
      pendingChunksRef.current.push(event.data);
      // Echo fast path: see INPUT_ECHO_WINDOW_MS. The scroll repaint (or the
      // typed key's echo) paints the moment it arrives instead of waiting out
      // the firehose batch.
      if (Date.now() - lastInputSentAtRef.current < INPUT_ECHO_WINDOW_MS) {
        clearFlushTimer();
        flushPendingChunks();
        return;
      }
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
  }, [terminalReady, sessionId, postInit, postInitOrHold, flushPendingChunks, clearFlushTimer, postToTerminal]);

  // Pause/resume rendering with tab visibility. When the terminal becomes the
  // visible page again, drop any queued writes and re-seed from the ring so the
  // WebView jumps straight to the latest frame it missed while paused. Through
  // the hold: a pane that swapped sessions while hidden must not come back to
  // an empty successor grid.
  useEffect(() => {
    const wasActive = isActiveRef.current;
    isActiveRef.current = isActive;
    if (isActive && !wasActive && terminalReady) {
      pendingChunksRef.current = [];
      clearFlushTimer();
      postInitOrHold('reactivate');
    }
  }, [isActive, terminalReady, postInitOrHold, clearFlushTimer]);

  // Coming back from the background can leave the mirror with holes: the
  // WebView survives (no 'ready', so nothing re-inits) but its renderer has
  // dropped glyphs, and single characters go missing mid-line and STAY
  // missing. Observed on a Pixel - "110 +" rendered as "10", "progress" as
  // "p ogress" - and repaired completely by a refit, which relaid the whole
  // frame out. The fit is deterministic now, so a refit no longer changes
  // anything and would no longer repaint; the repaint is asked for directly
  // instead (the glyph atlas dropped, every row redrawn). Purely local, no
  // wire traffic. That it still repairs the dropped glyphs is a HARDWARE
  // check: the emulator may never drop them.
  useEffect(() => {
    if (!terminalReady) return;
    const subscription = AppState.addEventListener('change', (status) => {
      if (status !== 'active' || !isActiveRef.current) return;
      postToTerminal({ type: 'repaint' });
      // The page may have died while backgrounded; check once it has had
      // the chance to answer.
      armBlankRecovery();
    });
    return () => subscription.remove();
  }, [terminalReady, postToTerminal, armBlankRecovery]);

  // A channel coming up (a reconnect, or the first connection after a
  // cold-launch notification tap) is when a missing seed can finally arrive;
  // check on it once it has had the chance.
  const channelEstablished = useChannelStore((state) => state.established);
  useEffect(() => {
    if (channelEstablished && terminalReady) armBlankRecovery();
  }, [channelEstablished, terminalReady, armBlankRecovery]);

  // Session swap under a mounted pane (the desktop respawned the task's
  // session): the WebView survives but its grid belongs to the dead session.
  // Drop anything queued and re-init from the NEW session's ring; the
  // successor's seed may already have landed while this pane was bound to the
  // old session, so waiting for a 'seed' event alone is not enough.
  //
  // But re-init ONLY when the successor's seed has landed and has something
  // to paint. A swap normally arrives before its first snapshot does -
  // SessionScreen retains the new ring and asks the desktop for it, and the
  // answer is a round trip away - so an unconditional init here posts an
  // EMPTY grid, which is the black terminal this whole path is about.
  // postInitOrHold keeps the dead session's last frame until the successor's
  // ring is seeded and can paint (the seed and chunk listeners release the
  // hold); SessionScreen's swap veil covers that frame and lets go once the
  // page reports the successor painted. The init it finally posts holds the
  // predecessor's frame (holdFrame) until the successor paints, and the
  // successor's grid comes up in the same reference cell whatever its row
  // count, so nothing jumps.
  //
  // A clean-feed flip goes through the same hold. The flag only takes effect
  // at init, and on a fresh page (nothing displayed) it posts at once; with a
  // frame on screen and an empty ring, the deferred init carries the flag
  // when it lands, so the parser still comes up in the right mode.
  const previousSessionIdRef = useRef(sessionId);
  const previousCleanFeedRef = useRef(cleanFeedEnabled);
  useEffect(() => {
    const sessionChanged = previousSessionIdRef.current !== sessionId;
    const cleanFeedChanged = previousCleanFeedRef.current !== cleanFeedEnabled;
    if (!sessionChanged && !cleanFeedChanged) return;
    previousSessionIdRef.current = sessionId;
    previousCleanFeedRef.current = cleanFeedEnabled;
    // A new session is a new episode: it gets its own repair attempts.
    if (sessionChanged) blankRecoveryAttemptsRef.current = 0;
    if (!terminalReady) return;
    pendingChunksRef.current = [];
    clearFlushTimer();
    postInitOrHold(sessionChanged ? 'swap' : 'clean-feed');
  }, [sessionId, cleanFeedEnabled, terminalReady, postInitOrHold, clearFlushTimer]);

  // Drop this session's DECCKM + reading-view state on unmount. There is
  // nothing to release - the mirror never resized the PTY.
  useEffect(() => {
    return () => {
      useTerminalUiStore.getState().clearSession(sessionId);
      useReadingViewStore.getState().clearSession(sessionId);
    };
  }, [sessionId]);

  // The prompt cards' "Answer in terminal" escape hatch: consume the
  // one-shot keyboard-focus request only once this pane is actually the
  // visible page AND the WebView has finished construction - firing it
  // earlier would focus a hidden or not-yet-ready input. Not tied to a
  // manual lens toggle (SessionScreen's onModeChange never sets this flag),
  // so switching to Terminal by hand never pops the keyboard.
  const focusKeyboardRequested = useTerminalUiStore(
    (state) => state.focusKeyboardRequestBySessionId[sessionId] ?? false,
  );
  useEffect(() => {
    if (!focusKeyboardRequested || !isActive || !terminalReady) return;
    directKeyRef.current?.focus();
    useTerminalUiStore.getState().consumeFocusKeyboardRequest(sessionId);
  }, [focusKeyboardRequested, isActive, terminalReady, sessionId]);

  const onWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      // Eval replies are dev-harness traffic, not part of the terminal bridge
      // protocol; consume them before the decoder so it never sees them.
      if (inspectEnabled && settleTerminalEval(event.nativeEvent.data, pendingEvalsRef.current)) return;
      const message = decodeTerminalMessage(event.nativeEvent.data);
      if (message === null) return;
      if (message.type === 'ready') {
        // A fresh page (first load, or the remount after a killed renderer)
        // displays nothing yet, so there is no frame for the hold to protect:
        // init unconditionally, even from an empty ring.
        displayedFrameSessionIdRef.current = null;
        heldInitSessionIdRef.current = null;
        setAwaitingFirstFrame(true);
        postInit('ready');
        terminalReadyRef.current = true;
        setTerminalReady(true);
        return;
      }
      if (message.type === 'painted') {
        // Attributed by seq, never by the currently bound session: a late
        // report for the dead session's init must not be credited to the
        // successor. Only a NON-BLANK paint counts as the frame being on
        // screen; a blank one just says the page is up and waiting for bytes.
        if (message.seq !== null && message.seq !== initSeqRef.current) return;
        // Any report for the current init, blank or not, proves the page is
        // alive (see runBlankRecovery); a non-blank one ends the episode.
        lastPaintReportSeqRef.current = initSeqRef.current;
        if (!message.blank) {
          clearBlankRecovery();
          blankRecoveryAttemptsRef.current = 0;
        }
        traceConnection('terminal-painted', {
          blank: message.blank,
          sinceInitMs: Date.now() - lastInitPostAtRef.current,
        });
        if (!message.blank && lastInitSessionIdRef.current !== null) {
          useTerminalUiStore.getState().markTerminalPainted(lastInitSessionIdRef.current);
        }
        // The wait ends with the desktop's answer ON SCREEN, which only a
        // non-blank report says. Not a blank one even once the ring holds the
        // seed: measured on the Pixel (task #107), a seed's own flush parsed
        // to a blank viewport and the frame arrived with the next live write
        // 395 ms later, so ending the wait there showed a bare black pane.
        if (!message.blank) setAwaitingFirstFrame(false);
        return;
      }
      if (message.type === 'modes') {
        const terminalUi = useTerminalUiStore.getState();
        terminalUi.setApplicationCursorMode(sessionId, message.applicationCursorKeys);
        // Remembered so the NEXT init can replay them. The WebView's parser is
        // the only place these are known, and a terminal rebuilt from a ring
        // that has evicted the TUI's startup DECSETs cannot rediscover them.
        //
        // An INITIAL report is skipped once something is already stored: it
        // only describes what the seed established, so letting it write would
        // let a seed that lacked the DECSETs overwrite the very modes being
        // held to restore them - and since every later init would report the
        // same degraded baseline, the terminal could never climb back out.
        // Observed exactly that way while testing this fix.
        const alreadyStored = terminalUi.stickyModesBySessionId[sessionId] !== undefined;
        if (!message.initial || !alreadyStored) {
          terminalUi.setStickyModes(sessionId, {
            applicationCursorKeys: message.applicationCursorKeys,
            mouseTrackingMode: message.mouseTrackingMode,
            mouseEncoding: message.mouseEncoding,
            alternateBuffer: message.alternateBuffer,
          });
        }
        return;
      }
      if (message.type === 'font-size') {
        // The page's fit report: a fit chain settled, or the texture cap
        // clamped a pinch. Keep the pinch baseline on the size the page
        // actually shows, so the next pinch starts from it rather than
        // jumping. Nothing is persisted: the fit is a pure function of the
        // grid and the pane, so there is nothing worth remembering.
        const syncedFontSize = clampTerminalFontSize(Math.round(message.fontSizePx));
        fontSizePxRef.current = syncedFontSize;
        pinchBaseFontSizeRef.current = syncedFontSize;
        traceConnection('terminal-fit', {
          source: message.source,
          trigger: message.trigger,
          fontSizePx: message.fontSizePx,
          lineHeight: message.lineHeight === null ? 'n/a' : Math.round(message.lineHeight * 1000) / 1000,
          cols: message.cols ?? 'n/a',
          rows: message.rows ?? 'n/a',
          fitHeightPx: message.fitHeightPx ?? 'n/a',
          hostFitHeightPx: hostFitHeightRef.current ?? 'n/a',
          innerHeightPx: message.innerHeightPx ?? 'n/a',
          innerWidthPx: message.innerWidthPx ?? 'n/a',
          gridHeightPx: message.gridHeightPx ?? 'n/a',
          devicePixelRatio: message.devicePixelRatio ?? 'n/a',
          maxTextureSize: message.maxTextureSize ?? 'n/a',
          // The chain's cost: each cell write resized and cleared the canvas.
          fitStrategy: message.fitStrategy ?? 'n/a',
          chainMs: message.chainMs ?? 'n/a',
          cellWrites: message.cellWrites ?? 'n/a',
          cellWriteMs: message.cellWriteMs ?? 'n/a',
          maxCellWriteMs: message.maxCellWriteMs ?? 'n/a',
          active: isActiveRef.current,
        });
        return;
      }
      if (message.type === 'renderer') {
        // Observability, mirroring the desktop's renderer report: WebGL is the
        // fast path; a 'dom' report means WebGL was unavailable or its context
        // was lost. On the flag-gated connection trace, and WITHOUT the session
        // id: this used to be a bare console.log that put the id into every
        // release build's logcat on every terminal open, which the trace's own
        // rule (phases and milliseconds, never an identifier) exists to avoid.
        traceConnection('terminal-renderer', { renderer: message.renderer });
        return;
      }
      if (message.type === 'clean-lines') {
        useReadingViewStore.getState().applyCleanLines(sessionId, message.lines, message.reset);
        return;
      }
      if (message.type === 'tapped') {
        // A clean tap (never a drag or pinch - the WebView's own gesture
        // code decides) toggles the soft keyboard for direct typing.
        directKeyRef.current?.toggle();
        return;
      }
      // 'input': keys typed inside the xterm WebView go to the desktop PTY.
      // Failures (not connected, capability revoked) are dropped silently -
      // the connection banner is the surface for that state - but they are
      // COUNTED, because a silent write failure is otherwise indistinguishable
      // from a gesture that never fired.
      terminalWriteStatsRef.current.attempts += 1;
      terminalWriteStatsRef.current.lastAttemptAt = Date.now();
      lastInputSentAtRef.current = Date.now();
      void writeTerminal(sessionId, message.data).catch((writeError: unknown) => {
        terminalWriteStatsRef.current.failures += 1;
        terminalWriteStatsRef.current.lastError =
          writeError instanceof Error ? writeError.message : String(writeError);
      });
    },
    [postInit, sessionId, clearBlankRecovery],
  );

  /* eslint-disable react-hooks/refs, react-hooks/purity -- the pinch callbacks run on touch
     events (runOnJS), never during render; the refs carry gesture-lifetime state and Date.now()
     throttles those event posts. The lint cannot see that .onUpdate/.onEnd are event handlers. */
  const pinchGesture = Gesture.Pinch()
    .runOnJS(true)
    // The WebView cannot tell reliably that a pinch is happening: once this
    // gesture claims the touches, the page can stop receiving touchend for a
    // finger and counts it as still down forever, so its own touch list shows a
    // phantom second finger and every later one-finger drag reads as
    // multi-touch. Measured live at 15 touchstarts against 13 touchends, with
    // history scrolling dead until the terminal was rebuilt. This layer owns the
    // gesture, so it is the one that can say.
    //
    // Two FINGERS, never the gesture lifecycle: RNGH's PinchGestureHandler
    // begins on the FIRST touch of any kind (PinchGestureHandler.kt calls
    // begin() from STATE_UNDETERMINED, one finger included), so an onBegin
    // report marked every one-finger drag as a pinch and the page refused the
    // very drag the report was part of. Measured live: 524 touchmoves, 3
    // scrolls (the message-latency window), every other move exiting
    // 'pinch-active'. onStart backs this up at activation in case the second
    // finger lands mid-gesture in an order touches events miss.
    .onTouchesDown((touchesEvent) => {
      if (touchesEvent.numberOfTouches >= 2) postToTerminal({ type: 'pinch', active: true });
    })
    .onStart(() => {
      postToTerminal({ type: 'pinch', active: true });
    })
    // Fingers dropping below two END the pinch for scrolling purposes, even
    // though RNGH keeps the handler alive until the LAST finger lifts
    // (PinchGestureHandler.kt ends only on ACTION_UP, and deliberately ignores
    // onScaleEnd) - so waiting for onFinalize left the flag up through the
    // whole "pinch, keep one finger, drag" motion and blocked the drag.
    // Reproduced end to end on the emulator with raw multi-touch: the
    // human-timed replay dragged for 600ms after the lift and every move
    // exited 'pinch-active'. numberOfTouches here reports the count AFTER the
    // lifted finger is removed (trackedPointersCount decrements before the
    // touch event dispatches).
    .onTouchesUp((touchesEvent) => {
      if (touchesEvent.numberOfTouches <= 1) postToTerminal({ type: 'pinch', active: false });
    })
    .onTouchesCancelled((touchesEvent) => {
      if (touchesEvent.numberOfTouches <= 1) postToTerminal({ type: 'pinch', active: false });
    })
    .onFinalize(() => {
      postToTerminal({ type: 'pinch', active: false });
    })
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
        <WebView<object>
          key={`terminal-webview-${webViewGeneration}`}
          ref={webViewRef}
          testID="terminal-webview"
          source={{ uri: terminalHtmlUri }}
          originWhitelist={['*']}
          allowFileAccess
          javaScriptEnabled
          scrollEnabled={false}
          setSupportMultipleWindows={false}
          onMessage={onWebViewMessage}
          onLayout={onWebViewLayout}
          onRenderProcessGone={recoverWebView}
          onContentProcessDidTerminate={recoverWebView}
          style={[styles.flex, { backgroundColor: theme.colors.terminalBackground }]}
        />
        {awaitingFirstFrame ? <TerminalWaitOverlay key={sessionId} sessionId={sessionId} active={isActive} /> : null}
        <DirectKeyInput ref={directKeyRef} sessionId={sessionId} />
        <View style={styles.scrollLatestButton}>
          <IconButton
            iconName="to-latest"
            variant="raised"
            testID="terminal-scroll-latest"
            accessibilityLabel="Jump to the latest terminal output"
            onPress={() => postToTerminal({ type: 'scroll-latest' })}
          />
        </View>
        <View style={styles.refitButton}>
          <IconButton
            iconName="contract"
            variant="raised"
            testID="terminal-refit"
            accessibilityLabel="Fit the terminal to the screen"
            onPress={() => {
              // The fitted view back, from ANY state, at once: the page drops
              // the pinch and re-fits to the reference cell. The ring's grid
              // rides along, so a page that inited before the desktop reported
              // one fits the real grid. It used to wait on a re-seed's init
              // (a one-shot any unrelated init could consume) and fall back to
              // a local refit 700 ms later - which with the grid unknown could
              // only stretch the line height, leaving a pinched-tiny view tiny.
              const ptyDimensions = getTerminalDimensions(sessionId);
              postToTerminal({
                type: 'refit',
                cols: ptyDimensions ? ptyDimensions.cols : null,
                rows: ptyDimensions ? ptyDimensions.rows : null,
              });
              // And a fresh frame from the desktop: the button is also the
              // user's way to unstick a mirror a missed byte has wedged. Its
              // init lands on the same deterministic fit, so it does not
              // resize anything a second time.
              refreshTerminalStream(sessionId);
            }}
          />
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  refitButton: {
    bottom: 12,
    position: 'absolute',
    right: 12,
  },
  scrollLatestButton: {
    bottom: 64,
    position: 'absolute',
    right: 12,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
