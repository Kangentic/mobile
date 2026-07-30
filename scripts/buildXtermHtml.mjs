#!/usr/bin/env node
/**
 * Generates src/terminal/xterm.html: a fully self-contained, offline,
 * CSP-locked page that hosts xterm.js for the raw-terminal mirror. Inlines
 * xterm's JS and CSS from the @xterm/xterm devDependency plus the RN <->
 * WebView bridge glue below, so the WebView never touches the network.
 *
 * Run manually after an @xterm/xterm upgrade, then commit the regenerated
 * asset:
 *   node scripts/buildXtermHtml.mjs
 *
 * The bridge protocol (message shapes) is defined in
 * src/terminal/terminalBridge.ts; the glue here implements the same
 * contract by hand because this page cannot import TypeScript.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const xtermJs = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'), 'utf8');
const xtermCss = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'utf8');
const xtermFitJs = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'), 'utf8');
const xtermWebglJs = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'addon-webgl', 'lib', 'addon-webgl.js'), 'utf8');
// @xterm/headless ships a CJS-only bundle (assigns to `exports`, no UMD); the
// wrapper below fakes `exports` and captures the module as a page global. It
// backs the clean feed: a PARSER-ONLY second terminal (no renderer at all),
// far cheaper than a hidden DOM terminal for the same job. The frame is read
// straight from the parsed buffer as PLAIN CELL TEXT (translateToString), so
// no escape sequence can ever leak into the reading view.
const xtermHeadlessJs = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'headless', 'lib-headless', 'xterm-headless.js'), 'utf8');
const xtermVersion = JSON.parse(readFileSync(join(repoRoot, 'node_modules', '@xterm', 'xterm', 'package.json'), 'utf8')).version;

const bridgeGlue = `
(function () {
  'use strict';
  // FAITHFUL MIRROR ONLY. This glue renders the desktop's exact grid 1:1 and
  // NEVER resizes the desktop PTY - a shared session must not be reshaped by
  // the phone. The only thing sent up is typed input. The font is sized so the
  // whole frame fits the screen; pinch zoom + pan read the detail.
  var terminal = null;
  var fitAddon = null;
  // WebGL renderer state, reset per createTerminal. See attachWebgl.
  var webglAddon = null;
  var webglRetryTimer = null;
  var webglLossCount = 0;
  // The desktop's grid. knownRows === null means the desktop has not reported
  // its grid yet (pre-0.4.0, or mid-reconnect before the snapshot): infer cols
  // from content and fit rows to the viewport until the real grid arrives as a
  // 'resize'. Fullscreen TUIs cursor-address against the exact grid, so we
  // never render at any other cols/rows; a wider-than-screen grid pans.
  var knownCols = 80;
  var knownRows = null;
  var currentFontSizePx = 12;
  var lastAppCursorMode = false;
  // Manual pan suppresses follow-the-cursor briefly so incoming output does
  // not fight the user's finger; auto-pan resumes after the pause.
  var MANUAL_PAN_PAUSE_MS = 4000;
  var manualPanUntil = 0;
  // A desktop grid is far wider than a phone, so where the frame OPENS
  // matters. Follow-the-cursor would immediately drag the view to wherever
  // the TUI's cursor happens to sit, dropping the user into the middle of
  // lines with the left edge (where every line, prompt and tree begins) off
  // screen. Open pinned to column 0 at the newest output instead, and hand
  // control over the moment the user actually touches or types.
  var pinnedToStart = true;
  var MIN_AUTO_FONT_PX = 6;
  // Cap the auto-fit font so a very short grid does not produce absurd glyphs;
  // pinch zoom goes higher or lower on demand, bounded by the host's own
  // MAX_TERMINAL_FONT_SIZE_PX rather than anything in this file.
  var MAX_AUTO_FIT_FONT_PX = 20;
  // Monospace cell size relative to font size (Menlo/Consolas ~0.6 wide, ~1.2
  // tall); good enough for the fit-to-screen guess.
  var CELL_WIDTH_RATIO = 0.6;
  var CELL_HEIGHT_RATIO = 1.2;
  // CLEAN FEED (the chat reading view for agents without a structured
  // transcript): a second, HEADLESS terminal (parser + buffer, no renderer)
  // consumes the same bytes; a debounced serialize -> line diff posts
  // readable lines to the host. Off unless init says cleanFeed: true.
  var cleanFeedEnabled = false;
  var cleanTerminal = null;
  var cleanDebounceTimer = null;
  var cleanLastLines = [];
  var CLEAN_FEED_DEBOUNCE_MS = 48;
  var CLEAN_FEED_SCROLLBACK = 200;

  function postToHost(message) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  function scrollContainer() {
    return document.getElementById('scroll-container');
  }

  function fallbackRowCount(fontSizePx) {
    // Only used before the desktop's rows are known: a rough guess so the
    // first paint is close, corrected when the real grid arrives.
    var approximateCellHeight = Math.ceil(fontSizePx * 1.35);
    return Math.max(8, Math.floor(window.innerHeight / approximateCellHeight));
  }

  function resizePreservingBottom(cols, rows) {
    if (cols === terminal.cols && rows === terminal.rows) return;
    var buffer = terminal.buffer.active;
    var wasAtBottom = buffer.viewportY >= buffer.baseY;
    terminal.resize(cols, rows);
    // Follow-tail only when the user was already at the bottom; a reader
    // scrolled up into history must never be yanked back down by a refit.
    if (wasAtBottom) terminal.scrollToBottom();
  }

  // Pick the font so the desktop grid's ROWS fill the FULL phone height,
  // maximizing vertical use of the screen. A wide grid then overflows the width
  // and pans horizontally (follow-the-cursor keeps the active column in view);
  // pinch zoom adjusts from there. Recomputed on rotation so it fills the height
  // in portrait AND landscape. Reported to the host so its pinch baseline
  // matches (no jump on the first pinch).
  function autoFitFontToScreen() {
    if (knownRows === null || knownRows < 1 || knownCols < 1) return;
    var forHeight = window.innerHeight / (knownRows * CELL_HEIGHT_RATIO);
    var fitted = Math.floor(forHeight);
    // AUTO-fit gets a far lower ceiling than pinch: a SHORT desktop grid
    // (a fresh session with ten rows) would otherwise blow up to poster
    // print - a giant prompt glyph filling the phone. Pinch can still go
    // higher for detail work.
    var next = Math.max(MIN_AUTO_FONT_PX, Math.min(MAX_AUTO_FIT_FONT_PX, fitted));
    // The texture cap outranks the fill floor: a very wide desktop grid (the
    // desktop's bottom terminal panel parks sessions around 300 cols) must
    // render small and CORRECT rather than large and clamped-blurry.
    next = textureCappedFontPx(next, knownCols, knownRows);
    if (next !== currentFontSizePx) {
      currentFontSizePx = next;
      if (terminal) terminal.options.fontSize = next;
      postToHost({ type: 'font-size', fontSizePx: next });
    }
  }

  // Render the desktop's EXACT grid 1:1. Legacy (no dims reported yet) falls
  // back to inferred cols + a viewport-height row estimate until real dims
  // arrive. The grid is top/left-aligned; a grid wider (or taller) than the
  // screen pans inside #scroll-container.
  function applyGeometry() {
    if (!terminal) return;
    resizePreservingBottom(knownCols, knownRows !== null ? knownRows : fallbackRowCount(currentFontSizePx));
  }

  // Keep the cursor in view while output streams once the frame is zoomed in
  // past the viewport. Skips while the user is mid-pan, and until the user
  // has taken the wheel at all (see pinnedToStart).
  function panToCursor() {
    if (!terminal || pinnedToStart || Date.now() < manualPanUntil) return;
    var container = scrollContainer();
    var screen = document.querySelector('.xterm-screen');
    if (!container || !screen) return;
    var screenWidth = screen.getBoundingClientRect().width;
    if (!(screenWidth > 0) || container.scrollWidth <= container.clientWidth) return;
    var cellWidth = screenWidth / terminal.cols;
    var cursorLeft = terminal.buffer.active.cursorX * cellWidth;
    var margin = cellWidth * 4;
    if (cursorLeft < container.scrollLeft + margin) {
      container.scrollLeft = Math.max(0, cursorLeft - margin);
    } else if (cursorLeft > container.scrollLeft + container.clientWidth - margin) {
      container.scrollLeft = cursorLeft - container.clientWidth + margin;
    }
  }

  function reportModesIfFlipped() {
    if (!terminal || !terminal.modes) return;
    var appCursor = terminal.modes.applicationCursorKeysMode === true;
    if (appCursor !== lastAppCursorMode) {
      lastAppCursorMode = appCursor;
      postToHost({ type: 'modes', applicationCursorKeys: appCursor });
    }
  }

  function afterWriteFlushed() {
    reportModesIfFlipped();
    panToCursor();
  }

  // Ported from the desktop renderer's terminal-webgl.ts. xterm's WebGL renderer
  // is 10-50x faster than the DOM fallback for output bursts. The GPU can drop
  // the context (driver reset, memory pressure); the naive "dispose on loss"
  // permanently reverts to the DOM renderer, so every later burst becomes slow.
  // Instead, on a loss we RETRY re-init with a backoff, and only give up (DOM for
  // good) after the retries are exhausted. The desktop's per-page WebGL attach
  // budget / LRU coordinator is deliberately omitted: a phone hosts exactly one
  // xterm per WebView, so it never approaches Chromium's per-page context cap.
  var WEBGL_RETRY_DELAYS_MS = [2000, 10000];

  function attachWebgl() {
    if (!terminal) return false;
    try {
      var addon = new window.WebglAddon.WebglAddon();
      addon.onContextLoss(handleWebglContextLoss);
      terminal.loadAddon(addon);
      webglAddon = addon;
      return true;
    } catch (webglError) {
      // WebGL unavailable in this WebView (no GPU / blocklisted): DOM stays.
      webglAddon = null;
      return false;
    }
  }

  function handleWebglContextLoss() {
    if (webglAddon) {
      try { webglAddon.dispose(); } catch (disposeError) { /* may already be gone */ }
      webglAddon = null;
    }
    reportRenderer(); // now on the DOM renderer until (and unless) a retry recovers WebGL
    webglLossCount += 1;
    if (webglLossCount > WEBGL_RETRY_DELAYS_MS.length) return; // give up: DOM renderer for good
    if (webglRetryTimer !== null) clearTimeout(webglRetryTimer);
    webglRetryTimer = setTimeout(function () {
      webglRetryTimer = null;
      attachWebgl();
      reportRenderer();
    }, WEBGL_RETRY_DELAYS_MS[webglLossCount - 1]);
  }

  function resetWebglState() {
    if (webglRetryTimer !== null) {
      clearTimeout(webglRetryTimer);
      webglRetryTimer = null;
    }
    // A fresh createTerminal disposed the old terminal (and its addon) already.
    webglAddon = null;
    webglLossCount = 0;
  }

  // Report the active renderer to the host (like the desktop's renderer report),
  // so a degraded terminal is observable rather than a silent DOM fallback.
  function reportRenderer() {
    postToHost({ type: 'renderer', renderer: webglAddon ? 'webgl' : 'dom' });
  }

  // --- Clean feed ---------------------------------------------------------
  // Hand-mirrors src/terminal/cleanFeedDiff.ts (this page cannot import TS);
  // tests/unit/cleanFeedDiff extracts this copy from the generated file and
  // asserts both implementations agree, so they cannot drift silently.
  function diffCleanLines(previousLines, serialized) {
    var newLines = serialized.split('\\n').map(function (line) { return line.replace(/\\s+$/, ''); });
    while (newLines.length > 0 && newLines[newLines.length - 1] === '') {
      newLines.pop();
    }
    var commonPrefixLength = 0;
    var comparableLength = Math.min(newLines.length, previousLines.length);
    for (var index = 0; index < comparableLength; index += 1) {
      if (newLines[index] === previousLines[index]) commonPrefixLength += 1;
      else break;
    }
    if (commonPrefixLength === newLines.length && newLines.length === previousLines.length) {
      return { lines: [], reset: false, nextLines: newLines };
    }
    var reset = commonPrefixLength < previousLines.length;
    var candidateLines = reset ? newLines : newLines.slice(commonPrefixLength);
    var decorative = /^[\\u2500-\\u257F\\s\\-=_\\u00B7\\u2022]+$/;
    var emitted = candidateLines.filter(function (line) {
      return line.length > 0 && !decorative.test(line);
    });
    return { lines: emitted, reset: reset, nextLines: newLines };
  }

  function teardownCleanFeed() {
    if (cleanDebounceTimer !== null) {
      clearTimeout(cleanDebounceTimer);
      cleanDebounceTimer = null;
    }
    if (cleanTerminal) {
      try { cleanTerminal.dispose(); } catch (disposeError) { /* already gone */ }
      cleanTerminal = null;
    }
    cleanLastLines = [];
  }

  function setupCleanFeed(colsForClean, rowsForClean) {
    teardownCleanFeed();
    if (!cleanFeedEnabled) return;
    cleanTerminal = new HeadlessXterm.Terminal({
      cols: colsForClean,
      rows: rowsForClean,
      scrollback: CLEAN_FEED_SCROLLBACK,
      allowProposedApi: true,
    });
  }

  // The parsed frame as PLAIN cell text: every buffer line (scrollback +
  // screen) via translateToString(trimRight) - escape codes never reach
  // cells, so the reading view gets pure text by construction. Fullscreen
  // TUIs live in the ALT buffer, and buffer.active follows them, which is
  // exactly what a reader wants to read.
  function cleanFeedFrameText() {
    var activeBuffer = cleanTerminal.buffer.active;
    var frameLines = [];
    for (var lineIndex = 0; lineIndex < activeBuffer.length; lineIndex += 1) {
      var bufferLine = activeBuffer.getLine(lineIndex);
      frameLines.push(bufferLine ? bufferLine.translateToString(true) : '');
    }
    return frameLines.join('\\n');
  }

  function cleanFeedWrite(data) {
    if (!cleanTerminal || typeof data !== 'string' || data.length === 0) return;
    cleanTerminal.write(data);
    if (cleanDebounceTimer !== null) clearTimeout(cleanDebounceTimer);
    cleanDebounceTimer = setTimeout(flushCleanFeed, CLEAN_FEED_DEBOUNCE_MS);
  }

  function flushCleanFeed() {
    cleanDebounceTimer = null;
    if (!cleanTerminal) return;
    // xterm parses write() asynchronously; a zero-length write's callback is
    // the flush barrier (the desktop's headless frame buffer uses the same).
    cleanTerminal.write('', function () {
      if (!cleanTerminal) return;
      var frameText;
      try {
        frameText = cleanFeedFrameText();
      } catch (frameError) {
        return;
      }
      var result = diffCleanLines(cleanLastLines, frameText);
      cleanLastLines = result.nextLines;
      if (result.lines.length === 0 && !result.reset) return;
      postToHost({ type: 'clean-lines', lines: result.lines, reset: result.reset });
    });
  }
  // --- end clean feed -----------------------------------------------------

  function createTerminal(initMessage) {
    knownCols = initMessage.cols;
    knownRows = typeof initMessage.rows === 'number' ? initMessage.rows : null;
    // Capped even on the legacy no-dims path (autoFitFontToScreen early-returns
    // there, so this is the only guard between a wide grid and the GPU limit).
    currentFontSizePx = textureCappedFontPx(initMessage.fontSizePx, knownCols, knownRows);
    lastAppCursorMode = false;
    manualPanUntil = 0;
    // Every (re-)init is a fresh open - including a session swap and the
    // re-seed when the pane becomes visible again - so the frame starts at
    // column 0 rather than inheriting the previous view's pan.
    pinnedToStart = true;
    cleanFeedEnabled = initMessage.cleanFeed === true;
    // The row-stretch fill can leave a sub-row remainder below the last row;
    // paint the page in the terminal's own background so it never reads as a
    // seam against the host screen.
    if (initMessage.theme && typeof initMessage.theme.background === 'string') {
      document.documentElement.style.background = initMessage.theme.background;
      document.body.style.background = initMessage.theme.background;
    }
    setupCleanFeed(knownCols, knownRows !== null ? knownRows : fallbackRowCount(currentFontSizePx));
    autoFitFontToScreen();
    terminal = new window.Terminal({
      cols: knownCols,
      rows: knownRows !== null ? knownRows : fallbackRowCount(currentFontSizePx),
      fontSize: currentFontSizePx,
      fontFamily: 'Menlo, Consolas, monospace',
      theme: initMessage.theme,
      scrollback: 2000,
      convertEol: false,
      cursorBlink: false,
    });
    resetWebglState();
    fitAddon = new window.FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(document.getElementById('terminal'));
    attachWebgl();
    reportRenderer();
    // Android predictive keyboards buffer composition text against xterm's
    // hidden textarea, echoing late and breaking Backspace - turn every
    // assist off so keys route straight through.
    if (terminal.textarea) {
      terminal.textarea.setAttribute('autocomplete', 'off');
      terminal.textarea.setAttribute('autocorrect', 'off');
      terminal.textarea.setAttribute('autocapitalize', 'none');
      terminal.textarea.setAttribute('spellcheck', 'false');
    }
    // Hardware/Bluetooth keyboard typing directly into the WebView flows to
    // the PTY the same way quick keys do (the host routes both through the
    // interactive-terminal verb). Typing also re-arms follow-the-cursor.
    terminal.onData(function (data) {
      manualPanUntil = 0;
      postToHost({ type: 'input', data: data });
    });
    if (initMessage.scrollback) {
      terminal.write(initMessage.scrollback, function () {
        applyGeometry();
        afterWriteFlushed();
      });
      cleanFeedWrite(initMessage.scrollback);
    } else {
      applyGeometry();
    }
    // Cell metrics AND the viewport height can settle a frame after open();
    // re-fit the font (not just the geometry) once they have.
    requestAnimationFrame(refit);
  }

  function applyFontSize(fontSizePx) {
    if (!terminal) return;
    // Pinch obeys the texture cap too: past it the GPU clamps the canvas and
    // the right side of the grid becomes undrawable, so the zoom ceiling is
    // the honest limit. (On real devices the limit is 8k-16k and the ceiling
    // is far above any font size a pinch can reach; a 4096 limit is an
    // emulator trait.)
    var capped = textureCappedFontPx(fontSizePx, knownCols, knownRows !== null ? knownRows : terminal.rows);
    currentFontSizePx = capped;
    terminal.options.fontSize = capped;
    // Keep the host's pinch baseline honest when the cap engaged.
    if (capped !== fontSizePx) postToHost({ type: 'font-size', fontSizePx: capped });
    // Pinch changed the cell size; the grid (cols/rows) is unchanged.
    applyGeometry();
  }

  // After the integer font fit, rows * cellHeight usually ends a strip short
  // of the viewport (font sizes are whole pixels). Stretch the LINE HEIGHT by
  // the remainder ratio so the grid consumes the full height - no dead band
  // under the last row. One-shot per refit, measured off the renderer's
  // actual cell height; clamped so a pathological measure cannot balloon rows.
  function stretchRowsToViewport() {
    if (!terminal) return;
    var screen = document.querySelector('.xterm-screen');
    if (!screen) return;
    var screenHeight = screen.getBoundingClientRect().height;
    if (!(screenHeight > 0) || terminal.rows < 1) return;
    var currentLineHeight = terminal.options.lineHeight || 1;
    var baseCellHeight = screenHeight / terminal.rows / currentLineHeight;
    if (!(baseCellHeight > 0)) return;
    var desiredLineHeight = window.innerHeight / (terminal.rows * baseCellHeight);
    var next = Math.max(1, Math.min(1.3, desiredLineHeight));
    if (Math.abs(next - currentLineHeight) > 0.005) {
      terminal.options.lineHeight = next;
    }
  }

  // The GPU's max texture edge, probed once. A canvas wider (or taller) than
  // this gets silently allocated at the clamped size and stretched back over
  // the element: the right side of the grid is never drawn and the left side
  // paints magnified and blurry (observed live: a 308-col desktop grid at
  // font 20 wants a 9548-device-px canvas on a 4096-limit WebView, so the
  // phone showed ~13 giant columns). Conservative default if probing fails.
  var maxGlTextureSize = 4096;
  (function probeMaxGlTextureSize() {
    try {
      var probeCanvas = document.createElement('canvas');
      var gl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
      if (gl) {
        var reported = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (typeof reported === 'number' && reported >= 1024) maxGlTextureSize = reported;
        var loseExtension = gl.getExtension('WEBGL_lose_context');
        if (loseExtension) loseExtension.loseContext();
      }
    } catch (probeError) { /* keep the conservative default */ }
  })();

  // Largest font at which the grid's canvas still fits inside the GPU texture
  // limit on BOTH axes. The 0.97 margin absorbs the cell-ratio guess erring
  // small against the renderer's true metrics.
  function textureCappedFontPx(fontPx, cols, rows) {
    var effectiveRows = rows !== null && rows >= 1 ? rows : fallbackRowCount(fontPx);
    var budget = maxGlTextureSize * 0.97;
    var widthCap = budget / (cols * CELL_WIDTH_RATIO * window.devicePixelRatio);
    var heightCap = budget / (effectiveRows * CELL_HEIGHT_RATIO * window.devicePixelRatio);
    var cap = Math.floor(Math.min(widthCap, heightCap));
    return Math.min(fontPx, Math.max(1, cap));
  }

  // A refit can SHRINK the grid (the soft keyboard halves the viewport
  // height, so the height-fitted font drops and the frame narrows). The
  // horizontal pan is not automatically reconciled, so a scrollLeft from the
  // wider layout can now point past the end of the content and the screen
  // renders BLANK. Clamp it to what the new content allows, then put the
  // cursor back in view.
  //
  // Live-verified failure this fixes: opening the keyboard in the terminal
  // (which the prompt cards' "More options in terminal" hatch does directly)
  // left scrollLeft at 706 against a 723-wide grid in a 411-wide viewport -
  // 2.3x past the maximum useful scroll - showing an empty frame.
  function clampHorizontalPan() {
    var container = scrollContainer();
    if (!container) return;
    // Still showing the opening view: hold column 0 so a relayout (the soft
    // keyboard, rotation) cannot drift the frame off the left edge before
    // the user has panned anywhere themselves.
    if (pinnedToStart) {
      container.scrollLeft = 0;
      return;
    }
    // Clamp against the RENDERED GRID width, never container.scrollWidth: a
    // shrinking refit leaves stale wider children inside #terminal, so
    // scrollWidth keeps authorizing scroll far past the last column.
    // Measured live on a Pixel 10 with the keyboard up: grid 723 CSS px but
    // container.scrollWidth still 1366, so a scrollLeft of 706 counted as
    // "in bounds" while showing an empty frame.
    var screen = document.querySelector('.xterm-screen') || document.querySelector('.xterm');
    var contentWidth = screen ? screen.getBoundingClientRect().width : container.scrollWidth;
    var maxScrollLeft = Math.max(0, contentWidth - container.clientWidth);
    if (container.scrollLeft > maxScrollLeft) container.scrollLeft = maxScrollLeft;
  }

  // Re-fit the font to the CURRENT viewport height, then re-apply the grid.
  // Called whenever the viewport settles or changes - the first-open layout
  // settle (window.innerHeight is not always final the instant the terminal is
  // created, which left the initial fit stale until a manual reload), the soft
  // keyboard, and rotation - so the fit is never left stale.
  function refit() {
    if (!terminal) return;
    autoFitFontToScreen();
    applyGeometry();
    // Measure AFTER the font/geometry pass paints, then true up the height.
    requestAnimationFrame(function () {
      stretchRowsToViewport();
      // A viewport change is not a user pan: clear the manual-pan pause so
      // the cursor is guaranteed back on screen after the relayout.
      manualPanUntil = 0;
      clampHorizontalPan();
      panToCursor();
    });
  }

  function onHostMessage(rawData) {
    var message;
    try {
      message = JSON.parse(rawData);
    } catch (parseError) {
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'init') {
      if (terminal) {
        terminal.dispose();
        terminal = null;
        var container = document.getElementById('terminal');
        while (container.firstChild) container.removeChild(container.firstChild);
      }
      createTerminal(message);
    } else if (message.type === 'write') {
      if (terminal && typeof message.data === 'string') {
        terminal.write(message.data, afterWriteFlushed);
        cleanFeedWrite(message.data);
      }
    } else if (message.type === 'set-font-size') {
      if (typeof message.fontSizePx === 'number') applyFontSize(message.fontSizePx);
    } else if (message.type === 'refit') {
      // Snap back to the fitted view: drop any manual pan and recompute the
      // fit-to-screen font (which reports the new size back to the host so
      // the pinch baseline stays in sync).
      manualPanUntil = 0;
      autoFitFontToScreen();
      applyGeometry();
    } else if (message.type === 'resize') {
      // The desktop's authoritative grid (snapshot, or a desktop-side refit, or
      // the FIRST time dims arrive when they lost the race with init). Adopt it
      // and re-fit the whole frame to screen. READ-ONLY - nothing is sent back.
      if (terminal && typeof message.cols === 'number' && typeof message.rows === 'number') {
        knownCols = message.cols;
        knownRows = message.rows;
        manualPanUntil = 0;
        if (cleanTerminal) cleanTerminal.resize(knownCols, knownRows);
        autoFitFontToScreen();
        applyGeometry();
      }
    }
  }

  // react-native-webview delivers injected messages on 'message' events:
  // document on Android, window on iOS - listen on both.
  var handleMessageEvent = function (event) {
    if (typeof event.data === 'string') onHostMessage(event.data);
  };
  window.addEventListener('message', handleMessageEvent);
  document.addEventListener('message', handleMessageEvent);

  // The WebView viewport changes when the soft keyboard shows/hides or on
  // rotation: re-fit the whole frame to the new viewport so it stays fully
  // visible.
  window.addEventListener('resize', refit);

  // Clean-tap detection (tap toggles the host-side keyboard; drags, pans,
  // and pinches never do): a single touch that ends within the slop radius
  // and time budget posts 'tapped' to the host. Any second finger or real
  // movement marks the gesture dirty.
  var TAP_SLOP_PX = 12;
  var TAP_MAX_MS = 350;
  var tapStartX = 0;
  var tapStartY = 0;
  var tapStartAt = 0;
  var tapDirty = true;

  window.addEventListener('load', function () {
    var container = scrollContainer();
    if (container) {
      container.addEventListener('touchstart', function (touchEvent) {
        // The user has taken the wheel: stop holding column 0 and let
        // follow-the-cursor resume once their pan settles.
        pinnedToStart = false;
        manualPanUntil = Date.now() + MANUAL_PAN_PAUSE_MS;
        if (touchEvent.touches.length === 1) {
          tapDirty = false;
          tapStartX = touchEvent.touches[0].clientX;
          tapStartY = touchEvent.touches[0].clientY;
          tapStartAt = Date.now();
        } else {
          tapDirty = true;
        }
      }, { passive: true });
      container.addEventListener('touchmove', function (touchEvent) {
        if (tapDirty || touchEvent.touches.length !== 1) {
          tapDirty = true;
          return;
        }
        var deltaX = touchEvent.touches[0].clientX - tapStartX;
        var deltaY = touchEvent.touches[0].clientY - tapStartY;
        if (deltaX * deltaX + deltaY * deltaY > TAP_SLOP_PX * TAP_SLOP_PX) tapDirty = true;
      }, { passive: true });
      container.addEventListener('touchend', function (touchEvent) {
        if (touchEvent.touches.length > 0) return;
        if (!tapDirty && Date.now() - tapStartAt <= TAP_MAX_MS) {
          postToHost({ type: 'tapped' });
        }
        tapDirty = true;
      }, { passive: true });
      container.addEventListener('click', function () {
        if (terminal) terminal.focus();
      });
      // The scroll-container is 100% of the WebView, so its box height tracks
      // window.innerHeight. Observing it re-fits the moment the viewport box
      // actually settles - which a plain 'resize' listener misses on first open
      // (the RN layout can finalize a beat after the terminal is created). This
      // is what removes the "needs a manual reload to fit" bug, and also covers
      // keyboard/rotation. Debounced to one fit per frame; refit changes only
      // the terminal's CONTENT size, never the container box, so it never loops.
      if (typeof ResizeObserver !== 'undefined') {
        var refitScheduled = false;
        var viewportObserver = new ResizeObserver(function () {
          if (refitScheduled) return;
          refitScheduled = true;
          requestAnimationFrame(function () {
            refitScheduled = false;
            refit();
          });
        });
        viewportObserver.observe(container);
      }
    }
    postToHost({ type: 'ready' });
  });
})();
`;

const html = `<!DOCTYPE html>
<!-- GENERATED FILE - do not hand-edit. Regenerate with: node scripts/buildXtermHtml.mjs (xterm ${xtermVersion}) -->
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<style>
${xtermCss}
html, body { margin: 0; padding: 0; background: #000000; height: 100%; overflow: hidden; }
/* The grid fills the phone HEIGHT (autoFitFontToScreen sizes the font to the row
   count) and is pinned top/left: column 0, row 0 start at the top-left corner. A
   wide grid overflows the width and pans right inside #scroll-container (follow-
   the-cursor tracks the active column); a grid taller than the viewport pans down.
   width:max-content keeps the terminal its natural grid width so the overflow is
   real and scrollable rather than wrapped. */
#scroll-container { width: 100%; height: 100%; overflow: auto; -webkit-overflow-scrolling: touch; }
/* Auto side margins CENTRE a grid narrower than the screen and do nothing to a
   wider one, which is exactly the split we want. The font is fitted to the
   pane's HEIGHT, so a grid whose aspect is taller than the pane's cannot fill
   the width at any font size - the leftover is inherent, not a bug. Pinned
   left it all piles up on the right and reads as a terminal cut short; split
   evenly it reads as a margin. When the grid IS wider, auto margins compute to
   zero, the overflow stays real, and the pan logic is untouched. */
#terminal { width: max-content; margin: 0 auto; }
</style>
</head>
<body>
<div id="scroll-container"><div id="terminal"></div></div>
<script>
${xtermJs}
</script>
<script>
${xtermFitJs}
</script>
<script>
${xtermWebglJs}
</script>
<script>
var HeadlessXterm = (function () { var exports = {}; ${xtermHeadlessJs}
return exports; })();
</script>
<script>
${bridgeGlue}
</script>
</body>
</html>
`;

const outputPath = join(repoRoot, 'src', 'terminal', 'xterm.html');
writeFileSync(outputPath, html);
process.stdout.write(`Wrote ${outputPath} (xterm ${xtermVersion}, ${(html.length / 1024).toFixed(0)} KiB)\n`);
