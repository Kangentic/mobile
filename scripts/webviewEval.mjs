#!/usr/bin/env node
// Evaluate a JavaScript expression inside the app's terminal WebView via the
// Chrome DevTools Protocol. The dev build's WebView exposes a devtools socket;
// this discovers it, forwards a local port, and runs Runtime.evaluate - the
// ground-truth companion to mobileInspect when the terminal LOOKS wrong but
// the RN layer says everything is fine (it is how the GPU MAX_TEXTURE_SIZE
// canvas clamp was diagnosed).
//
// Usage:
//   node scripts/webviewEval.mjs "window.innerWidth"
//   node scripts/webviewEval.mjs --serial <adb serial> "document.querySelector('.xterm-screen').getBoundingClientRect().width"
//
// --serial (or the ANDROID_SERIAL env var) picks the device when more than
// one is attached; with several ready devices and no selection this fails
// early instead of letting adb error.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const WebSocket = nodeRequire('ws');

const FORWARD_PORT = 9223;
const scriptArguments = process.argv.slice(2);
const serialFlagIndex = scriptArguments.indexOf('--serial');
if (serialFlagIndex !== -1) {
  const serial = scriptArguments[serialFlagIndex + 1];
  if (!serial) {
    console.error('--serial needs a value');
    process.exit(1);
  }
  process.env.ANDROID_SERIAL = serial;
  scriptArguments.splice(serialFlagIndex, 2);
}
const expression = scriptArguments[0];
if (!expression) {
  console.error('usage: node scripts/webviewEval.mjs [--serial <adb serial>] <expression>');
  process.exit(1);
}

function adb(...adbArguments) {
  return execFileSync('adb', adbArguments, { encoding: 'utf8' });
}

if (!process.env.ANDROID_SERIAL) {
  const readyDevices = adb('devices')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('\t'))
    .map((line) => line.split('\t').map((column) => column.trim()))
    .filter(([, state]) => state === 'device')
    .map(([serial]) => serial);
  if (readyDevices.length > 1) {
    console.error(`multiple devices attached (${readyDevices.join(', ')}); pass --serial <serial> or set ANDROID_SERIAL`);
    process.exit(1);
  }
}

const unixSockets = adb('shell', 'cat /proc/net/unix');
const socketMatch = unixSockets.match(/@(webview_devtools_remote_\d+)/);
if (!socketMatch) {
  console.error('no WebView devtools socket found; is the app (a dev build) running with the terminal open?');
  process.exit(1);
}
adb('forward', `tcp:${FORWARD_PORT}`, `localabstract:${socketMatch[1]}`);

const listResponse = await fetch(`http://localhost:${FORWARD_PORT}/json/list`);
const pages = await listResponse.json();
const page = pages.find((candidate) => candidate.type === 'page');
if (!page) {
  console.error('the WebView exposed no page target');
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
socket.on('open', () => {
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
});
socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id === 1) {
    console.log(JSON.stringify(message.result, null, 2));
    socket.close();
    process.exit(0);
  }
});
setTimeout(() => {
  console.error('timed out waiting for the evaluate result');
  process.exit(1);
}, 10000);
