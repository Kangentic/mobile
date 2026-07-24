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
 *   node scripts/mobileInspect.mjs relaunch
 *
 * Every command accepts --serial <adb serial> (or the ANDROID_SERIAL env
 * var, which adb honors natively) to pick the device when more than one is
 * attached; with several ready devices and no selection the command fails
 * early instead of letting adb error mid-run.
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

/** Strip --serial <value> from args, exporting it as ANDROID_SERIAL. */
function extractSerialFlag(args) {
  const index = args.indexOf('--serial');
  if (index === -1) return args;
  const serial = args[index + 1];
  if (!serial) fail('--serial needs a value');
  process.env.ANDROID_SERIAL = serial;
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

/** Fail early when several ready devices are attached and none was chosen. */
function ensureSingleAdbTarget() {
  if (process.env.ANDROID_SERIAL) return;
  const listed = spawnSync('adb', ['devices'], { encoding: 'utf8' });
  if (listed.status !== 0) return; // let the actual command surface adb errors
  const ready = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('\t'))
    .map((line) => line.split('\t').map((column) => column.trim()))
    .filter(([, state]) => state === 'device')
    .map(([serial]) => serial);
  if (ready.length > 1) {
    fail(`multiple devices attached (${ready.join(', ')}); pass --serial <serial> or set ANDROID_SERIAL`);
  }
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

const APP_PACKAGE = 'com.kangentic.mobile';

function appIsForegrounded() {
  const result = runAdb(['shell', 'dumpsys', 'window']);
  const focusLine = result.stdout.split('\n').find((line) => line.includes('mCurrentFocus'));
  return focusLine !== undefined && focusLine.includes(APP_PACKAGE);
}

function sleepMs(milliseconds) {
  // Synchronous sleep keeps the command sequential without async plumbing.
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

/**
 * Force-stop + launch + VERIFY the app reached the foreground, retrying the
 * launch when the intent races the process teardown (the classic "app lands
 * on the home screen" failure). One command that always ends with the app
 * actually on screen - the recovery step for a dead Fast Refresh socket, a
 * stale bundle, or any wedged app state.
 */
function commandRelaunch() {
  runAdb(['shell', 'am', 'force-stop', APP_PACKAGE]);
  sleepMs(500);
  for (let attempt = 1; attempt <= 4; attempt++) {
    runAdb(['shell', 'monkey', '-p', APP_PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1']);
    // Poll for the app to take window focus; a lost race leaves the launcher
    // focused and we simply fire the intent again.
    for (let poll = 0; poll < 10; poll++) {
      sleepMs(500);
      if (appIsForegrounded()) {
        console.log(`[inspect] relaunched; ${APP_PACKAGE} is foregrounded (attempt ${attempt})`);
        return;
      }
    }
  }
  fail(`relaunch: ${APP_PACKAGE} never reached the foreground after 4 launch attempts`);
}

const [command, ...rest] = extractSerialFlag(process.argv.slice(2));
ensureSingleAdbTarget();
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
  case 'relaunch':
    commandRelaunch();
    break;
  default:
    fail('usage: mobileInspect <screenshot|tap|text|key|logcat|state|serve|relaunch> [...]');
}
