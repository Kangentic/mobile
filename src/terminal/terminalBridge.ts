/**
 * The RN <-> WebView postMessage protocol for the xterm terminal pane:
 * message types, encoding, and validating decoding. No WebView imports; the
 * generated xterm.html glue and the RN host both consume this module, and
 * both treat the boundary as untrusted-ish (anything malformed decodes to
 * null and is dropped).
 *
 * The pane is a FAITHFUL MIRROR: it renders the desktop's exact grid 1:1 and
 * NEVER resizes the desktop PTY (a shared session must not be reshaped by the
 * phone). The PAGE owns the cell size: every grid renders in one reference
 * cell, pinned top-left (see REFERENCE_GRID_ROWS in scripts/xterm-page/state.js),
 * and pinch-zoom + pan read the detail. `rows: null` on init means the desktop
 * never reported its grid (pre-0.4.0) - the glue then infers cols from
 * content and lays rows out to the viewport until the real dims arrive.
 *
 * The theme record maps xterm ITheme keys (black, red, ..., brightWhite,
 * background, foreground, cursor) to hex color strings. It stays a plain
 * Record<string, string> so this module never depends on the app theme type
 * or on xterm's own typings.
 */

/** Why the page reported a fit: a settled fit chain, or the texture cap clamping a pinch. */
export type TerminalFitSource = 'settled' | 'texture-cap' | 'unknown';

/**
 * How the page finds the cell (scripts/xterm-page/cellFit.js): 'computed'
 * works the final cell out from the font's metrics and writes it once, which
 * resizes (and so clears) the renderer's canvas at most twice; 'measured' is
 * the older chain that stretches the line height a frame at a time, resizing
 * the canvas on every pass. 'measured' is the retention probe's control arm.
 */
export type TerminalFitStrategy = 'computed' | 'measured';

/** What a settled chain actually ran: a strategy, or a computed fit that missed and handed over to the measured chain. */
export type TerminalFitChainStrategy = TerminalFitStrategy | 'computed-miss';

const TERMINAL_FIT_CHAIN_STRATEGIES: readonly TerminalFitChainStrategy[] = ['computed', 'measured', 'computed-miss'];

/**
 * What started the fit chain a report describes (the page's activeFitTrigger).
 * A closed set rather than any string because it lands in the release-build
 * connection trace, which must never carry free text from the page.
 */
export const TERMINAL_FIT_TRIGGERS = [
  'init',
  'ro-settle',
  'ro-raf',
  'window-resize',
  'refit-msg',
  'resize-msg',
  'fit-height',
] as const;
export type TerminalFitTrigger = (typeof TERMINAL_FIT_TRIGGERS)[number] | 'unknown';

export type HostToTerminalMessage =
  | {
      type: 'init';
      /**
       * The host's own init counter, monotonic per pane. The page echoes it on
       * every 'painted' report so the host can tell which init a report
       * answers (a double swap inside one frame would otherwise credit the
       * dead session's late report to the successor).
       */
      seq: number;
      scrollback: string;
      cols: number;
      /** The PTY's rows, or null when the desktop never reported dims (legacy inference). */
      rows: number | null;
      /**
       * The Terminal lens's own height as the host measured it (the WebView's
       * layout with the quick-key row showing and the keyboard down), or null
       * before the host has one. The page fits to it, so a fresh page's first
       * frame is already the final cell.
       */
      fitHeightPx: number | null;
      theme: Record<string, string>;
      /**
       * True enables the CLEAN FEED: a second, headless parser over the same
       * bytes whose debounced serialize -> line diff posts readable lines
       * back as 'clean-lines' (the chat reading view for agents without a
       * structured transcript). Costs a parse per chunk; off by default.
       */
      cleanFeed: boolean;
      /**
       * True HOLDS the frame on screen (a text copy over the grid) until the
       * new one paints: the host sends it on every re-init over a painted
       * frame (a session swap, a lens switch back, a re-seed), so the reset
       * and replay never shows a blank grid. Nothing to do with the size any
       * more: the page fits every init to the same reference cell.
       */
      holdFrame: boolean;
      /**
       * True keeps a pinch the user made: the host sends it for a re-init of
       * the SAME session (a lens switch back, a re-seed). The page still drops
       * the pinch when the grid changed.
       */
      preservePinch: boolean;
      /** How the page fits the cell for this init and its refits (see TerminalFitStrategy). */
      fitStrategy: TerminalFitStrategy;
      /**
       * True cancels the WebView's long-press menu. Without it a long-press
       * raises Android's text menu over xterm's hidden textarea, which offers
       * only "Autofill" where an autofill service is set (seen on a Pixel with
       * 1Password). False only under the retention probe's control arm.
       */
      longPressMenuGuard: boolean;
    }
  | { type: 'write'; data: string }
  | { type: 'set-font-size'; fontSizePx: number }
  /**
   * The fit button: snap back to the fitted view from ANY state. Drops a
   * pinch and the converged cell and re-fits from scratch. Carries the ring's
   * grid (null when unknown) so a page that inited before the desktop reported
   * one fits the real grid rather than a guess.
   */
  | { type: 'refit'; cols: number | null; rows: number | null }
  /** The host re-measured the Terminal lens's height (a first measurement, a rotation). */
  | { type: 'fit-height'; fitHeightPx: number }
  /** Back from the background: drop the glyph atlas and redraw every row, without touching the fit. */
  | { type: 'repaint' }
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
  /**
   * A fit report: a fit chain SETTLED ('settled', every settle, changed or not)
   * or the texture cap clamped a pinch ('texture-cap'). Keeps the host's pinch
   * baseline in sync and feeds the release-build `terminal-fit` trace; the
   * host persists nothing. Every field past `fontSizePx` is diagnostic and
   * decodes to a default from an older page.
   */
  | {
      type: 'font-size';
      fontSizePx: number;
      source: TerminalFitSource;
      trigger: TerminalFitTrigger;
      cols: number | null;
      rows: number | null;
      lineHeight: number | null;
      fitHeightPx: number | null;
      innerHeightPx: number | null;
      innerWidthPx: number | null;
      gridHeightPx: number | null;
      devicePixelRatio: number | null;
      maxTextureSize: number | null;
      /**
       * The settled chain's cost, null on a texture-cap report or from an
       * older page: which strategy ran, the chain's wall time, and how many
       * font or line-height writes it made and how long they blocked. Each
       * such write resizes and clears the renderer's canvas, so these are what
       * the black-pane fix is measured by.
       */
      fitStrategy: TerminalFitChainStrategy | null;
      chainMs: number | null;
      cellWrites: number | null;
      cellWriteMs: number | null;
      maxCellWriteMs: number | null;
    }
  /** Which renderer backs the terminal: WebGL (GPU) or the DOM fallback. Observability for a degraded terminal. */
  | { type: 'renderer'; renderer: 'webgl' | 'dom' }
  /**
   * Cleaned readable lines derived from the terminal (cleanFeed on).
   * reset=false appends to what the reader already shows; reset=true
   * REPLACES it (a fullscreen repaint rewrote content above the tail).
   */
  | { type: 'clean-lines'; lines: string[]; reset: boolean }
  /** A clean tap on the terminal (no drag, no pinch): the host toggles the soft keyboard for direct typing. */
  | { type: 'tapped' }
  /**
   * The first PAINT after an init: reported once when the init's seed has
   * flushed (blank or not), then once more on the first write that leaves
   * visible glyphs, after which the page stays quiet until the next init.
   * `seq` echoes the init's counter (null from an older page). The host's
   * session-swap veil releases on the first `blank: false` for the successor.
   * One animation frame after the parse flush, so "painted" is inferred from
   * the renderer's ordering rather than measured.
   */
  | { type: 'painted'; seq: number | null; blank: boolean };

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

function finiteNumberOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function decodeFitSource(value: unknown): TerminalFitSource {
  return value === 'settled' || value === 'texture-cap' ? value : 'unknown';
}

function decodeFitTrigger(value: unknown): TerminalFitTrigger {
  const knownTrigger = TERMINAL_FIT_TRIGGERS.find((trigger) => trigger === value);
  return knownTrigger ?? 'unknown';
}

/** A closed set, like the trigger: it lands in the release-build trace, which never carries free text from the page. */
function decodeFitChainStrategy(value: unknown): TerminalFitChainStrategy | null {
  return TERMINAL_FIT_CHAIN_STRATEGIES.find((strategy) => strategy === value) ?? null;
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
    // Only the size is required: every other field is diagnostic and
    // defaults rather than rejects, so an older page's bare report still
    // keeps the pinch baseline in sync.
    return {
      type: 'font-size',
      fontSizePx: parsedObject.fontSizePx,
      source: decodeFitSource(parsedObject.source),
      trigger: decodeFitTrigger(parsedObject.trigger),
      cols: finiteNumberOrNull(parsedObject.cols),
      rows: finiteNumberOrNull(parsedObject.rows),
      lineHeight: finiteNumberOrNull(parsedObject.lineHeight),
      fitHeightPx: finiteNumberOrNull(parsedObject.fitHeightPx),
      innerHeightPx: finiteNumberOrNull(parsedObject.innerHeightPx),
      innerWidthPx: finiteNumberOrNull(parsedObject.innerWidthPx),
      gridHeightPx: finiteNumberOrNull(parsedObject.gridHeightPx),
      devicePixelRatio: finiteNumberOrNull(parsedObject.devicePixelRatio),
      maxTextureSize: finiteNumberOrNull(parsedObject.maxTextureSize),
      fitStrategy: decodeFitChainStrategy(parsedObject.fitStrategy),
      chainMs: finiteNumberOrNull(parsedObject.chainMs),
      cellWrites: finiteNumberOrNull(parsedObject.cellWrites),
      cellWriteMs: finiteNumberOrNull(parsedObject.cellWriteMs),
      maxCellWriteMs: finiteNumberOrNull(parsedObject.maxCellWriteMs),
    };
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
  if (parsedObject.type === 'painted' && typeof parsedObject.blank === 'boolean') {
    return {
      type: 'painted',
      seq: isFiniteNumber(parsedObject.seq) ? parsedObject.seq : null,
      blank: parsedObject.blank,
    };
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
    return { type: 'refit', cols: finiteNumberOrNull(parsedObject.cols), rows: finiteNumberOrNull(parsedObject.rows) };
  }
  if (parsedObject.type === 'fit-height' && isFiniteNumber(parsedObject.fitHeightPx)) {
    return { type: 'fit-height', fitHeightPx: parsedObject.fitHeightPx };
  }
  if (parsedObject.type === 'repaint') {
    return { type: 'repaint' };
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
    isFiniteNumber(parsedObject.seq) &&
    typeof parsedObject.scrollback === 'string' &&
    isFiniteNumber(parsedObject.cols) &&
    (parsedObject.rows === null || isFiniteNumber(parsedObject.rows)) &&
    (parsedObject.fitHeightPx === null || isFiniteNumber(parsedObject.fitHeightPx)) &&
    isStringRecord(parsedObject.theme) &&
    typeof parsedObject.cleanFeed === 'boolean' &&
    typeof parsedObject.holdFrame === 'boolean' &&
    typeof parsedObject.preservePinch === 'boolean'
  ) {
    return {
      type: 'init',
      seq: parsedObject.seq,
      scrollback: parsedObject.scrollback,
      cols: parsedObject.cols,
      rows: parsedObject.rows === null ? null : parsedObject.rows,
      fitHeightPx: parsedObject.fitHeightPx === null ? null : parsedObject.fitHeightPx,
      theme: parsedObject.theme,
      cleanFeed: parsedObject.cleanFeed,
      holdFrame: parsedObject.holdFrame,
      preservePinch: parsedObject.preservePinch,
      // Defaults rather than rejects, as the page does: only an explicit
      // 'measured' selects the older chain.
      fitStrategy: parsedObject.fitStrategy === 'measured' ? 'measured' : 'computed',
      // Likewise: only an explicit false turns the guard off.
      longPressMenuGuard: parsedObject.longPressMenuGuard !== false,
    };
  }
  return null;
}
