#!/usr/bin/env node
/**
 * The mobile inspect loop's CLI half: see, poke, and interrogate the app on
 * the attached emulator/device in single commands an agent (or human) can
 * chain into a verify loop.
 *
 *   node scripts/mobileInspect.mjs screenshot [--out <path>]
 *   node scripts/mobileInspect.mjs tap <x> <y>
 *   node scripts/mobileInspect.mjs text "<string>"
 *   node scripts/mobileInspect.mjs key <ANDROID_KEYCODE>
 *   node scripts/mobileInspect.mjs logcat [--lines <n>] [--tag <tag>]
 *   node scripts/mobileInspect.mjs state <connection|stores|subscriptions|feed-stats|route>
 *   node scripts/mobileInspect.mjs serve
 *
 * screenshot/tap/text/key/logcat are plain adb and need NO app cooperation
 * (they keep working when the JS bundle is broken). `state` hosts a local
 * WebSocket server on 127.0.0.1:8791 that the app's dev-only inspect bridge
 * (src/devsupport/inspectBridge.ts, enabled by the dev rig's
 * EXPO_PUBLIC_KANGENTIC_INSPECT=1 plus `adb reverse tcp:8791`) dials into,
 * answers one request, prints the JSON to stdout, and exits. The bridge
 * retries every 5s, so a one-shot waits up to --timeout (default 20s) for
 * the hello. `serve` keeps the server up and logs hellos, for manual poking.
 *
 * The request/response shapes mirror src/devsupport/inspectProtocol.ts by
 * hand (scripts cannot import TS) - keep the two in sync.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WebSocketServer } from 'ws';

const INSPECT_PORT = 8791;
const STATE_KINDS = ['connection', 'stores', 'subscriptions', 'feed-stats', 'route'];

function fail(message) {
  console.error(`[inspect] ${message}`);
  process.exit(1);
}

function runAdb(args, options = {}) {
  const result = spawnSync('adb', args, { encoding: options.binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`adb failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const stderrText = options.binary ? result.stderr?.toString('utf8') : result.stderr;
    fail(`adb ${args.join(' ')} exited ${result.status}: ${stderrText?.trim() ?? ''}`);
  }
  return result;
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function commandScreenshot(args) {
  const outPath = flagValue(args, '--out') ?? join(tmpdir(), 'kangentic-mobile-inspect', `shot-${Date.now()}.png`);
  mkdirSync(dirname(outPath), { recursive: true });
  const result = runAdb(['exec-out', 'screencap', '-p'], { binary: true });
  writeFileSync(outPath, result.stdout);
  console.log(outPath);
}

function commandTap(args) {
  const [x, y] = args;
  if (!/^\d+$/.test(x ?? '') || !/^\d+$/.test(y ?? '')) fail('usage: tap <x> <y>');
  runAdb(['shell', 'input', 'tap', x, y]);
  console.log(`tapped ${x},${y}`);
}

function commandText(args) {
  const text = args[0];
  if (typeof text !== 'string' || text.length === 0) fail('usage: text "<string>"');
  // `adb shell input text` cannot carry spaces; %s is its space escape.
  runAdb(['shell', 'input', 'text', text.replace(/ /g, '%s')]);
  console.log('typed');
}

function commandKey(args) {
  const keycode = args[0];
  if (!keycode) fail('usage: key <ANDROID_KEYCODE>');
  runAdb(['shell', 'input', 'keyevent', keycode]);
  console.log(`sent ${keycode}`);
}

function commandLogcat(args) {
  const lines = flagValue(args, '--lines') ?? '200';
  const tag = flagValue(args, '--tag') ?? 'ReactNativeJS';
  const result = runAdb(['logcat', '-d', '-t', lines, '-s', `${tag}:V`]);
  process.stdout.write(result.stdout);
}

function startServer() {
  return new WebSocketServer({ host: '127.0.0.1', port: INSPECT_PORT });
}

function commandState(args) {
  const kind = args[0];
  if (!STATE_KINDS.includes(kind)) fail(`usage: state <${STATE_KINDS.join('|')}>`);
  const timeoutMs = Number(flagValue(args, '--timeout') ?? '20000');
  const requestId = randomUUID();

  let server;
  try {
    server = startServer();
  } catch (serverError) {
    fail(`could not bind 127.0.0.1:${INSPECT_PORT} (another inspect command running?): ${serverError.message}`);
  }

  const overallTimer = setTimeout(() => {
    console.error(
      `[inspect] timed out after ${timeoutMs}ms waiting for the app. Checklist: dev rig running (it sets ` +
        `EXPO_PUBLIC_KANGENTIC_INSPECT=1 and adb reverse tcp:${INSPECT_PORT})? App foregrounded on a dev build?`,
    );
    server.close();
    process.exit(1);
  }, timeoutMs);

  server.on('error', (serverError) => fail(`inspect server error: ${serverError.message}`));
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === 'hello') {
        socket.send(JSON.stringify({ type: 'request', id: requestId, kind }));
        return;
      }
      if (message.type === 'response' && message.id === requestId) {
        clearTimeout(overallTimer);
        if (message.ok) {
          console.log(JSON.stringify(message.payload, null, 2));
        } else {
          console.error(`[inspect] app answered with an error: ${message.error}`);
        }
        socket.close();
        server.close(() => process.exit(message.ok ? 0 : 1));
      }
    });
  });
}

function commandServe() {
  const server = startServer();
  console.log(`[inspect] serving on 127.0.0.1:${INSPECT_PORT} (Ctrl+C to stop)`);
  server.on('connection', (socket) => {
    console.log('[inspect] app connected');
    socket.on('message', (raw) => console.log(`[inspect] <- ${raw.toString()}`));
    socket.on('close', () => console.log('[inspect] app disconnected'));
  });
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'screenshot':
    commandScreenshot(rest);
    break;
  case 'tap':
    commandTap(rest);
    break;
  case 'text':
    commandText(rest);
    break;
  case 'key':
    commandKey(rest);
    break;
  case 'logcat':
    commandLogcat(rest);
    break;
  case 'state':
    commandState(rest);
    break;
  case 'serve':
    commandServe();
    break;
  default:
    fail('usage: mobileInspect <screenshot|tap|text|key|logcat|state|serve> [...]');
}
