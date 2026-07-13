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
const xtermVersion = JSON.parse(readFileSync(join(repoRoot, 'node_modules', '@xterm', 'xterm', 'package.json'), 'utf8')).version;

const bridgeGlue = `
(function () {
  'use strict';
  var terminal = null;
  var currentCols = 80;
  var currentFontSizePx = 12;

  function postToHost(message) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  function measuredRowCount(fontSizePx) {
    // Approximate cell height (xterm default lineHeight 1.0 plus padding);
    // rows only size the viewport - scrollback holds the real history.
    var approximateCellHeight = Math.ceil(fontSizePx * 1.4);
    var rows = Math.floor(window.innerHeight / approximateCellHeight);
    return Math.max(24, rows);
  }

  function createTerminal(initMessage) {
    currentCols = initMessage.cols;
    currentFontSizePx = initMessage.fontSizePx;
    terminal = new window.Terminal({
      cols: initMessage.cols,
      rows: measuredRowCount(initMessage.fontSizePx),
      fontSize: initMessage.fontSizePx,
      fontFamily: 'Menlo, Consolas, monospace',
      theme: initMessage.theme,
      scrollback: 10000,
      convertEol: false,
      cursorBlink: false,
    });
    terminal.open(document.getElementById('terminal'));
    // Hardware/Bluetooth keyboard typing directly into the WebView flows to
    // the PTY the same way quick keys do (the host routes both through the
    // interactive-terminal verb).
    terminal.onData(function (data) {
      postToHost({ type: 'input', data: data });
    });
    if (initMessage.scrollback) {
      terminal.write(initMessage.scrollback, function () {
        terminal.scrollToBottom();
      });
    }
  }

  function applyFontSize(fontSizePx) {
    if (!terminal) return;
    currentFontSizePx = fontSizePx;
    terminal.options.fontSize = fontSizePx;
    terminal.resize(currentCols, measuredRowCount(fontSizePx));
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
      if (terminal && typeof message.data === 'string') terminal.write(message.data);
    } else if (message.type === 'set-font-size') {
      if (typeof message.fontSizePx === 'number') applyFontSize(message.fontSizePx);
    }
  }

  // react-native-webview delivers injected messages on 'message' events:
  // document on Android, window on iOS - listen on both.
  var handleMessageEvent = function (event) {
    if (typeof event.data === 'string') onHostMessage(event.data);
  };
  window.addEventListener('message', handleMessageEvent);
  document.addEventListener('message', handleMessageEvent);

  window.addEventListener('load', function () {
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
#scroll-container { width: 100%; height: 100%; overflow: auto; -webkit-overflow-scrolling: touch; }
#terminal { min-width: 100%; width: max-content; height: 100%; }
</style>
</head>
<body>
<div id="scroll-container"><div id="terminal"></div></div>
<script>
${xtermJs}
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
