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
  var MIN_AUTO_FONT_PX = 6;
  // Cap the fit-to-screen font so a small grid does not balloon; pinch zoom
  // goes higher on demand.
  var MAX_CONTAIN_FONT_PX = 20;
  // Monospace cell size relative to font size (Menlo/Consolas ~0.6 wide, ~1.2
  // tall); good enough for the fit-to-screen guess.
  var CELL_WIDTH_RATIO = 0.6;
  var CELL_HEIGHT_RATIO = 1.2;

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

  // Pick the largest font at which the WHOLE desktop grid (all cols AND all
  // rows) fits the phone screen, so the frame is shown with nothing cut off
  // (letterboxed like a video). Pinch zoom goes larger from there. Reported to
  // the host so its pinch baseline matches.
  function autoFitFontToScreen() {
    if (knownRows === null || knownRows < 1 || knownCols < 1) return;
    var forWidth = window.innerWidth / (knownCols * CELL_WIDTH_RATIO);
    var forHeight = window.innerHeight / (knownRows * CELL_HEIGHT_RATIO);
    var fitted = Math.floor(Math.min(forWidth, forHeight));
    var next = Math.max(MIN_AUTO_FONT_PX, Math.min(MAX_CONTAIN_FONT_PX, fitted));
    if (next !== currentFontSizePx) {
      currentFontSizePx = next;
      if (terminal) terminal.options.fontSize = next;
      postToHost({ type: 'font-size', fontSizePx: next });
    }
  }

  // Render the desktop's EXACT grid 1:1. Legacy (no dims reported yet) falls
  // back to inferred cols + a viewport-height row estimate until real dims
  // arrive. #terminal { margin: auto } centers the frame; a grid larger than
  // the screen (zoomed in) pans inside #scroll-container.
  function applyGeometry() {
    if (!terminal) return;
    resizePreservingBottom(knownCols, knownRows !== null ? knownRows : fallbackRowCount(currentFontSizePx));
  }

  // Keep the cursor in view while output streams once the frame is zoomed in
  // past the viewport. Skips while the user is mid-pan.
  function panToCursor() {
    if (!terminal || Date.now() < manualPanUntil) return;
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

  function createTerminal(initMessage) {
    knownCols = initMessage.cols;
    knownRows = typeof initMessage.rows === 'number' ? initMessage.rows : null;
    currentFontSizePx = initMessage.fontSizePx;
    lastAppCursorMode = false;
    manualPanUntil = 0;
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
    fitAddon = new window.FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(document.getElementById('terminal'));
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
    } else {
      applyGeometry();
    }
    // Cell metrics can settle a frame after open(); re-apply once they have.
    requestAnimationFrame(applyGeometry);
  }

  function applyFontSize(fontSizePx) {
    if (!terminal) return;
    currentFontSizePx = fontSizePx;
    terminal.options.fontSize = fontSizePx;
    // Pinch changed the cell size; the grid (cols/rows) is unchanged.
    applyGeometry();
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
      if (terminal && typeof message.data === 'string') terminal.write(message.data, afterWriteFlushed);
    } else if (message.type === 'set-font-size') {
      if (typeof message.fontSizePx === 'number') applyFontSize(message.fontSizePx);
    } else if (message.type === 'resize') {
      // The desktop's authoritative grid (snapshot, or a desktop-side refit, or
      // the FIRST time dims arrive when they lost the race with init). Adopt it
      // and re-fit the whole frame to screen. READ-ONLY - nothing is sent back.
      if (terminal && typeof message.cols === 'number' && typeof message.rows === 'number') {
        knownCols = message.cols;
        knownRows = message.rows;
        manualPanUntil = 0;
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
  window.addEventListener('resize', function () {
    autoFitFontToScreen();
    applyGeometry();
  });

  window.addEventListener('load', function () {
    var container = scrollContainer();
    if (container) {
      container.addEventListener('touchstart', function () {
        manualPanUntil = Date.now() + MANUAL_PAN_PAUSE_MS;
      }, { passive: true });
      container.addEventListener('click', function () {
        if (terminal) terminal.focus();
      });
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
/* Flex column with the terminal centered by margin:auto: the whole faithful frame is centered
   (balanced letterbox) when it fits, and pans symmetrically once pinch-zoomed larger than the
   viewport. align-items:flex-start keeps the terminal its natural (max-content) width so a frame
   wider than the viewport still overflows-and-pans; margin:auto overrides the cross-axis
   alignment to center it. */
#scroll-container { width: 100%; height: 100%; overflow: auto; -webkit-overflow-scrolling: touch; display: flex; flex-direction: column; align-items: flex-start; }
#terminal { width: max-content; margin: auto; }
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
${bridgeGlue}
</script>
</body>
</html>
`;

const outputPath = join(repoRoot, 'src', 'terminal', 'xterm.html');
writeFileSync(outputPath, html);
process.stdout.write(`Wrote ${outputPath} (xterm ${xtermVersion}, ${(html.length / 1024).toFixed(0)} KiB)\n`);
