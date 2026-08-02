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
 *   node scripts/mobileInspect.mjs state <connection|stores|subscriptions|feed-stats|route|pairing|terminal>
 *   node scripts/mobileInspect.mjs term <state|eval|font|refit|scroll|dragunits|swipe> [...]
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
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WebSocketServer } from 'ws';

const INSPECT_PORT = 8791;
const STATE_KINDS = [
  'connection',
  'stores',
  'subscriptions',
  'feed-stats',
  'route',
  'pairing',
  'terminal',
  'terminal-eval',
];

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

/**
 * Every adb call is bounded and self-healing.
 *
 * A wedged adb server does not error - it BLOCKS, and spawnSync without a
 * timeout blocks with it, which is how a stuck server turned into ten-minute
 * stalls. The server wedges most often after a large binary transfer over USB
 * (see commandScreenshot): adb's own docs describe a stalled bulk transfer
 * merging into the next packet header, which closes the connection with
 * "received too many bytes while waiting for payload".
 *
 * So: bound the call, and on a timeout restart the server once (the documented
 * host:kill recovery) before giving up. Reverse tunnels do NOT survive a server
 * restart, so they are re-applied too.
 */
const ADB_TIMEOUT_MS = 20_000;

function spawnAdb(args, options = {}) {
  return spawnSync('adb', args, {
    encoding: options.binary ? 'buffer' : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? ADB_TIMEOUT_MS,
  });
}

/**
 * Restart a wedged server and restore the reverses the rig depends on.
 *
 * `adb kill-server` is the polite route, but a server wedged mid-transfer
 * cannot answer that either - it is itself an adb client. When the polite
 * route times out, the process has to be terminated directly; adb is a daemon
 * that any later command restarts on demand, so this is recoverable, not
 * destructive.
 */
function recoverAdbServer() {
  console.error('[inspect] adb stopped responding; restarting the server');
  const killed = spawnSync('adb', ['kill-server'], { encoding: 'utf8', timeout: 5000 });
  if (killed.error || killed.status !== 0) {
    console.error('[inspect] kill-server did not answer either; terminating adb.exe');
    spawnSync(process.platform === 'win32' ? 'taskkill' : 'pkill', process.platform === 'win32' ? ['/F', '/IM', 'adb.exe'] : ['-f', 'adb'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  }
  const started = spawnSync('adb', ['start-server'], { encoding: 'utf8', timeout: ADB_TIMEOUT_MS });
  if (started.error) {
    console.error('[inspect] adb server would not restart; check the USB cable or use the rig --wifi flag');
    return;
  }
  // Reverse tunnels never survive a server restart.
  for (const port of ['8080', '8081', '8791']) {
    spawnSync('adb', ['reverse', `tcp:${port}`, `tcp:${port}`], { encoding: 'utf8', timeout: ADB_TIMEOUT_MS });
  }
}

function runAdb(args, options = {}) {
  let result = spawnAdb(args, options);
  // ETIMEDOUT (or a killed process with no status) means the server hung
  // rather than answered. Recover once, then retry the same command.
  if (result.error?.code === 'ETIMEDOUT' || (result.signal !== null && result.status === null)) {
    recoverAdbServer();
    result = spawnAdb(args, options);
  }
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

/**
 * Capture on the DEVICE, then pull.
 *
 * `exec-out screencap -p` streams the whole PNG back as one bulk USB transfer,
 * which is the pattern adb's own zero-length-packet doc names as the stall
 * trigger: when a payload lands on an exact multiple of the endpoint's max
 * packet size and no short packet follows, the transfer stalls and merges into
 * the next header, closing the connection and often leaving the server wedged.
 * Screenshots were by far our largest and most frequent such transfer.
 *
 * `adb pull` moves the same bytes over the sync protocol, which frames and
 * chunks them itself, so it does not hit that path.
 */
function commandScreenshot(args) {
  const outPath = flagValue(args, '--out') ?? join(tmpdir(), 'kangentic-mobile-inspect', `shot-${Date.now()}.png`);
  mkdirSync(dirname(outPath), { recursive: true });
  const devicePath = `/sdcard/kangentic-inspect-shot.png`;
  runAdb(['shell', 'screencap', '-p', devicePath]);
  runAdb(['pull', devicePath, outPath]);
  runAdb(['shell', 'rm', '-f', devicePath]);
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

/**
 * One request/response round trip with the app, resolved as a value.
 *
 * The server binds a fixed port, so two of these cannot overlap - callers that
 * need several (the terminal commands, which probe for staleness before acting)
 * must await each in turn.
 */
function requestState(kind, argument, timeoutMs) {
  return new Promise((resolve, reject) => {
    let server;
    try {
      server = startServer();
    } catch (serverError) {
      reject(
        new Error(`could not bind 127.0.0.1:${INSPECT_PORT} (another inspect command running?): ${serverError.message}`),
      );
      return;
    }
    const requestId = randomUUID();
    const overallTimer = setTimeout(() => {
      server.close();
      reject(
        new Error(
          `timed out after ${timeoutMs}ms waiting for the app. Checklist: dev rig running (it sets ` +
            `EXPO_PUBLIC_KANGENTIC_INSPECT=1 and adb reverse tcp:${INSPECT_PORT})? App foregrounded on a dev build?`,
        ),
      );
    }, timeoutMs);
    server.on('error', (serverError) => {
      clearTimeout(overallTimer);
      reject(new Error(`inspect server error: ${serverError.message}`));
    });
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (message.type === 'hello') {
          const request = { type: 'request', id: requestId, kind };
          if (argument !== undefined) request.argument = argument;
          socket.send(JSON.stringify(request));
          return;
        }
        if (message.type === 'response' && message.id === requestId) {
          clearTimeout(overallTimer);
          socket.close();
          server.close(() => {
            if (message.ok) resolve(message.payload);
            else reject(new Error(`app answered with an error: ${message.error}`));
          });
        }
      });
    });
  });
}

async function commandState(args) {
  const kind = args[0];
  if (!STATE_KINDS.includes(kind)) fail(`usage: state <${STATE_KINDS.join('|')}>`);
  const timeoutMs = Number(flagValue(args, '--timeout') ?? '20000');
  const argument = kind === 'terminal-eval' ? args[1] : undefined;
  const payload = await requestState(kind, argument, timeoutMs);
  console.log(JSON.stringify(payload, null, 2));
}

/**
 * The terminal harness: read the WebView's real geometry, and reproduce the
 * user's gestures without the user.
 *
 *   term state                  the full probe, prefixed with a freshness verdict
 *   term eval "<expression>"    anything, evaluated inside the page
 *   term font <px>              exactly what a pinch does
 *   term refit                  exactly what the reset button does
 *   term scroll <units>         a raw history burst, skipping the gesture layer
 *   term dragunits <px>         what a drag of that many pixels WOULD compute
 *   term swipe <dy> [ms]        a real one-finger drag via adb (real MotionEvents)
 *
 * Every command except `state` refuses to run against a STALE page unless
 * --force. xterm.html is a Metro asset cached by content hash and skipped by
 * Fast Refresh, so the device happily keeps serving the previous build; acting
 * on that and believing the result is how three fixes were "confirmed broken"
 * while already working.
 */
const TERMINAL_ACTIONS = ['state', 'eval', 'font', 'refit', 'scroll', 'dragunits', 'swipe'];

function reportFreshness(probe) {
  if (probe.buildIdMatches) {
    console.error(`[inspect] terminal asset fresh (build ${probe.loadedBuildId})`);
    return true;
  }
  console.error(
    `[inspect] STALE TERMINAL ASSET: the page is running build ${probe.loadedBuildId} but the bundle expects ` +
      `${probe.expectedBuildId}. Anything you measure now describes the OLD page. Fix: fully reload the app ` +
      `(node scripts/mobileInspect.mjs relaunch), and if that does not clear it, reinstall - Metro caches ` +
      `xterm.html by content hash and Fast Refresh never touches it.`,
  );
  return false;
}

async function terminalEval(expression, timeoutMs) {
  const value = await requestState('terminal-eval', expression, timeoutMs);
  console.log(JSON.stringify(value, null, 2));
}

/**
 * A real one-finger vertical drag. adb produces genuine MotionEvents, so this
 * exercises the same touchstart/touchmove/touchend path a finger does, unlike
 * anything synthesized inside the page.
 *
 * The duration matters: a fast swipe delivers too few interpolated move samples
 * for the drag handler to fire more than once, which reads as "scrolling does
 * not work" when it merely had nothing to consume. Default 800ms.
 */
function terminalSwipe(deltaY, durationMs) {
  const sizeOutput = runAdb(['shell', 'wm', 'size']).stdout;
  const sizeMatch = sizeOutput.match(/(\d+)x(\d+)\s*$/m);
  if (!sizeMatch) fail(`could not parse screen size from: ${sizeOutput.trim()}`);
  const [, widthText, heightText] = sizeMatch;
  const width = Number(widthText);
  const height = Number(heightText);
  // Left of centre and clear of both the segmented switcher at the top and the
  // refit button at the bottom right.
  const x = Math.round(width * 0.4);
  const startY = Math.round(height * (deltaY > 0 ? 0.35 : 0.7));
  const endY = Math.max(1, Math.min(height - 1, startY + deltaY));
  runAdb(['shell', 'input', 'swipe', String(x), String(startY), String(x), String(endY), String(durationMs)]);
  console.log(`swiped x=${x} y=${startY} -> ${endY} over ${durationMs}ms`);
}

async function commandTerm(args) {
  const action = args[0];
  if (!TERMINAL_ACTIONS.includes(action)) fail(`usage: term <${TERMINAL_ACTIONS.join('|')}> [...]`);
  const timeoutMs = Number(flagValue(args, '--timeout') ?? '20000');
  const force = args.includes('--force');

  const probe = await requestState('terminal', undefined, timeoutMs);
  const fresh = reportFreshness(probe);

  if (action === 'state') {
    console.log(JSON.stringify(probe, null, 2));
    process.exitCode = fresh ? 0 : 1;
    return;
  }
  if (!fresh && !force) {
    console.error('[inspect] refusing to act on a stale page; pass --force if you really mean to');
    process.exitCode = 1;
    return;
  }

  if (action === 'eval') {
    const expression = args[1];
    if (!expression) fail('usage: term eval "<expression>"');
    await terminalEval(expression, timeoutMs);
    return;
  }
  if (action === 'font') {
    const fontSizePx = Number(args[1]);
    if (!Number.isFinite(fontSizePx)) fail('usage: term font <px>');
    await terminalEval(`window.__kangenticTerminal.setFontSize(${fontSizePx})`, timeoutMs);
    return;
  }
  if (action === 'refit') {
    await terminalEval('window.__kangenticTerminal.refit()', timeoutMs);
    return;
  }
  if (action === 'scroll') {
    const units = Number(args[1]);
    if (!Number.isFinite(units)) fail('usage: term scroll <units> (negative scrolls toward history)');
    await terminalEval(`window.__kangenticTerminal.scroll(${units})`, timeoutMs);
    return;
  }
  if (action === 'dragunits') {
    const deltaPx = Number(args[1]);
    if (!Number.isFinite(deltaPx)) fail('usage: term dragunits <px>');
    await terminalEval(`window.__kangenticTerminal.dragUnits(${deltaPx})`, timeoutMs);
    return;
  }
  const deltaY = Number(args[1]);
  if (!Number.isFinite(deltaY)) fail('usage: term swipe <dy> [durationMs] (positive dy drags DOWN, toward history)');
  terminalSwipe(Math.round(deltaY), Number(args[2] ?? '800'));
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
// The async commands reject with a plain Error; route those through fail() so a
// timeout reads as one diagnostic line rather than an unhandled-rejection dump.
try {
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
      await commandState(rest);
      break;
    case 'term':
      await commandTerm(rest);
      break;
    case 'serve':
      commandServe();
      break;
    case 'relaunch':
      commandRelaunch();
      break;
    default:
      fail('usage: mobileInspect <screenshot|tap|text|key|logcat|state|term|serve|relaunch> [...]');
  }
} catch (commandError) {
  fail(commandError.message);
}
