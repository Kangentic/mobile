/**
 * The RN <-> WebView postMessage protocol for the xterm terminal pane:
 * message types, encoding, and validating decoding. No WebView imports; the
 * generated xterm.html glue and the RN host both consume this module, and
 * both treat the boundary as untrusted-ish (anything malformed decodes to
 * null and is dropped).
 *
 * The pane is a FAITHFUL MIRROR: it renders the desktop's exact grid 1:1 and
 * NEVER resizes the desktop PTY (a shared session must not be reshaped by the
 * phone). It sizes the font so the whole frame fits the phone screen, and
 * pinch-zoom + pan read the detail. `rows: null` on init means the desktop
 * never reported its grid (pre-0.4.0) - the glue then infers cols from
 * content and fits rows to the viewport until the real dims arrive.
 *
 * The theme record maps xterm ITheme keys (black, red, ..., brightWhite,
 * background, foreground, cursor) to hex color strings. It stays a plain
 * Record<string, string> so this module never depends on the app theme type
 * or on xterm's own typings.
 */

export type HostToTerminalMessage =
  | {
      type: 'init';
      scrollback: string;
      cols: number;
      /** The PTY's rows, or null when the desktop never reported dims (legacy inference). */
      rows: number | null;
      fontSizePx: number;
      theme: Record<string, string>;
      /**
       * True enables the CLEAN FEED: a second, headless parser over the same
       * bytes whose debounced serialize -> line diff posts readable lines
       * back as 'clean-lines' (the chat reading view for agents without a
       * structured transcript). Costs a parse per chunk; off by default.
       */
      cleanFeed: boolean;
    }
  | { type: 'write'; data: string }
  | { type: 'set-font-size'; fontSizePx: number }
  /** Snap back to the fitted view: recompute the fit-to-screen font and reset pan. */
  | { type: 'refit' }
  /**
   * Jump to the newest output. Mechanism-aware in the page: local
   * scrollToBottom when the buffer has real scrollback; otherwise Ctrl+End
   * (the TUI's own depth-independent jump binding), plus one delayed
   * wheel-down nudge under mouse tracking so a quiet TUI repaints. Never an
   * overshoot burst - a big burst can mis-split into the agent's composer as
   * literal text (see scrollToLatest in scripts/xterm-page/historyScroll.js).
   */
  | { type: 'scroll-latest' }
  /** The authoritative PTY grid changed (desktop refit); adopt it and re-fit the frame to screen. */
  | { type: 'resize'; cols: number; rows: number }
  /**
   * A pinch is in progress (or just ended), reported by the RN gesture layer
   * that actually owns it. The page cannot tell reliably on its own: when the
   * gesture handler above the WebView claims a pinch, the page can stop
   * receiving touchend for a finger and keeps counting it forever, so its own
   * touch list reports a phantom second finger and every later one-finger drag
   * looks like a pinch. Measured live: 15 touchstarts against 13 touchends.
   */
  | { type: 'pinch'; active: boolean };

export type TerminalToHostMessage =
  | { type: 'ready' }
  | { type: 'input'; data: string }
  /**
   * The STICKY VT modes, reported whenever any of them flips. Parsed truth from
   * the WebView's own VT parser, which is the only place they are known.
   *
   * `applicationCursorKeys` (DECCKM) tells the quick keys to send SS3 arrows
   * instead of CSI. The rest exist to be REPLAYED: a TUI sets them once at
   * startup, the phone's feed ring evicts those bytes, and every later re-init
   * would otherwise come up in a different state than the desktop PTY. See
   * src/terminal/modeRestore.ts.
   */
  | {
      type: 'modes';
      applicationCursorKeys: boolean;
      mouseTrackingMode: string;
      mouseEncoding: string;
      alternateBuffer: boolean;
      /**
       * True for the FIRST report after a (re-)init: a baseline describing
       * whatever the replayed seed established, not a mode the desktop changed.
       * A baseline must never overwrite stored modes, or a seed that lacked the
       * DECSETs latches the degraded state in permanently.
       */
      initial: boolean;
    }
  /** The glue changed the font size autonomously (fit-to-screen zoom); keeps the host's pinch base in sync. */
  | { type: 'font-size'; fontSizePx: number }
  /** Which renderer backs the terminal: WebGL (GPU) or the DOM fallback. Observability for a degraded terminal. */
  | { type: 'renderer'; renderer: 'webgl' | 'dom' }
  /**
   * Cleaned readable lines derived from the terminal (cleanFeed on).
   * reset=false appends to what the reader already shows; reset=true
   * REPLACES it (a fullscreen repaint rewrote content above the tail).
   */
  | { type: 'clean-lines'; lines: string[]; reset: boolean }
  /** A clean tap on the terminal (no drag, no pinch): the host toggles the soft keyboard for direct typing. */
  | { type: 'tapped' };

export function encodeHostMessage(message: HostToTerminalMessage): string {
  return JSON.stringify(message);
}

export function encodeTerminalMessage(message: TerminalToHostMessage): string {
  return JSON.stringify(message);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  for (const entryValue of Object.values(value)) {
    if (typeof entryValue !== 'string') {
      return false;
    }
  }
  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Decode a message received FROM the WebView terminal; null on anything malformed. */
export function decodeTerminalMessage(raw: string): TerminalToHostMessage | null {
  const parsedObject = parseJsonObject(raw);
  if (parsedObject === null) {
    return null;
  }
  if (parsedObject.type === 'ready') {
    return { type: 'ready' };
  }
  if (parsedObject.type === 'input' && typeof parsedObject.data === 'string') {
    return { type: 'input', data: parsedObject.data };
  }
  if (parsedObject.type === 'modes' && typeof parsedObject.applicationCursorKeys === 'boolean') {
    // The three sticky fields default rather than reject: a page from an older
    // build reports only the DECCKM flag, and losing the arrow-key mode over a
    // missing field would break typing to fix a scrolling bug.
    return {
      type: 'modes',
      applicationCursorKeys: parsedObject.applicationCursorKeys,
      mouseTrackingMode: typeof parsedObject.mouseTrackingMode === 'string' ? parsedObject.mouseTrackingMode : 'none',
      mouseEncoding: typeof parsedObject.mouseEncoding === 'string' ? parsedObject.mouseEncoding : 'DEFAULT',
      alternateBuffer: parsedObject.alternateBuffer === true,
      // Defaults TRUE for an older page: treating an unknown report as a
      // baseline is the safe direction, since the cost is a missed mode change
      // rather than a permanently latched degraded state.
      initial: parsedObject.initial !== false,
    };
  }
  if (parsedObject.type === 'font-size' && isFiniteNumber(parsedObject.fontSizePx)) {
    return { type: 'font-size', fontSizePx: parsedObject.fontSizePx };
  }
  if (parsedObject.type === 'renderer' && (parsedObject.renderer === 'webgl' || parsedObject.renderer === 'dom')) {
    return { type: 'renderer', renderer: parsedObject.renderer };
  }
  if (
    parsedObject.type === 'clean-lines' &&
    Array.isArray(parsedObject.lines) &&
    parsedObject.lines.every((line) => typeof line === 'string') &&
    typeof parsedObject.reset === 'boolean'
  ) {
    return { type: 'clean-lines', lines: parsedObject.lines as string[], reset: parsedObject.reset };
  }
  if (parsedObject.type === 'tapped') {
    return { type: 'tapped' };
  }
  return null;
}

/**
 * Decode a message sent TO the WebView terminal. Used by the generated
 * xterm.html glue and by tests to round-trip encodeHostMessage.
 */
export function decodeHostMessage(raw: string): HostToTerminalMessage | null {
  const parsedObject = parseJsonObject(raw);
  if (parsedObject === null) {
    return null;
  }
  if (parsedObject.type === 'write' && typeof parsedObject.data === 'string') {
    return { type: 'write', data: parsedObject.data };
  }
  if (parsedObject.type === 'set-font-size' && isFiniteNumber(parsedObject.fontSizePx)) {
    return { type: 'set-font-size', fontSizePx: parsedObject.fontSizePx };
  }
  if (parsedObject.type === 'refit') {
    return { type: 'refit' };
  }
  if (parsedObject.type === 'scroll-latest') {
    return { type: 'scroll-latest' };
  }
  if (parsedObject.type === 'pinch' && typeof parsedObject.active === 'boolean') {
    return { type: 'pinch', active: parsedObject.active };
  }
  if (parsedObject.type === 'resize' && isFiniteNumber(parsedObject.cols) && isFiniteNumber(parsedObject.rows)) {
    return { type: 'resize', cols: parsedObject.cols, rows: parsedObject.rows };
  }
  if (
    parsedObject.type === 'init' &&
    typeof parsedObject.scrollback === 'string' &&
    isFiniteNumber(parsedObject.cols) &&
    (parsedObject.rows === null || isFiniteNumber(parsedObject.rows)) &&
    isFiniteNumber(parsedObject.fontSizePx) &&
    isStringRecord(parsedObject.theme) &&
    typeof parsedObject.cleanFeed === 'boolean'
  ) {
    return {
      type: 'init',
      scrollback: parsedObject.scrollback,
      cols: parsedObject.cols,
      rows: parsedObject.rows === null ? null : parsedObject.rows,
      fontSizePx: parsedObject.fontSizePx,
      theme: parsedObject.theme,
      cleanFeed: parsedObject.cleanFeed,
    };
  }
  return null;
}
