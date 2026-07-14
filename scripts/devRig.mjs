#!/usr/bin/env node
/**
 * Local dev rig: one command that wires up everything a preview needs -
 * emulator, adb reverse, a local kangentic-relay, optionally the stub
 * desktop peer, and Metro - in one of four modes:
 *
 *   node scripts/devRig.mjs mock     Fake in-app desktop peer; no relay, no
 *                                    desktop, no pairing. UI/UX iteration.
 *   node scripts/devRig.mjs live     (default) Connect to your real running
 *                                    Kangentic desktop dev instance through a
 *                                    local relay. Dogfooding.
 *   node scripts/devRig.mjs pair     Reset the app to unpaired (pm clear) and
 *                                    exercise the pairing ceremony. Add --stub
 *                                    to pair against the stub peer instead of
 *                                    the live desktop.
 *   node scripts/devRig.mjs stub     Relay + scripts/stubDesktopPeer.mjs, the
 *                                    Maestro E2E rig. Reuses the saved phone
 *                                    key for a no-re-pair session when it can.
 *   node scripts/devRig.mjs doctor   Preflight checks only.
 *
 * Flags: --avd <name>, --relay-repo <path>, --clear, --no-metro,
 *        --stub (pair mode), --fresh (stub mode: ignore the saved phone key).
 *
 * Local state lives in the gitignored .devrig.local.json at the repo root:
 *   { "relayRepoPath": "...", "stubPhoneKey": "<64 hex>", "avdName": "..." }
 * Relay repo resolution: --relay-repo > KANGENTIC_RELAY_REPO env >
 * .devrig.local.json > ../kangentic-relay (sibling checkout).
 *
 * The rig adopts healthy already-running pieces (relay via /healthz, Metro
 * via port 8081, emulator via adb devices) and only tears down children it
 * spawned itself. Ctrl-C stops relay/stub/Metro; the emulator stays up.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(repoRoot, '.devrig.local.json');
const APP_PACKAGE = 'com.kangentic.mobile';
const RELAY_PORT = 8080;
const METRO_PORT = 8081;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
// Until every local relay checkout carries the widened default, always start
// the relay with the session slot length allowed (32-hex session slot plus
// the 64-hex pairing slot). Harmless once the relay default matches.
const RELAY_SLOT_PATTERN = '^([0-9a-f]{32}|[0-9a-f]{64})$';
const DEFAULT_AVD = 'kangentic_pixel';
const MODES = ['mock', 'live', 'pair', 'stub', 'doctor'];

const spawnedChildren = [];

function log(message) {
  console.log(`[rig] ${message}`);
}

function warn(message) {
  console.log(`[rig] WARNING: ${message}`);
}

function fail(message) {
  console.error(`[rig] ERROR: ${message}`);
  teardown();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Local state

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch (parseError) {
    warn(`ignoring unreadable ${STATE_FILE}: ${parseError.message}`);
    return {};
  }
}

function saveState(patch) {
  const next = { ...loadState(), ...patch };
  writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Arguments

function parseRigArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      avd: { type: 'string' },
      'relay-repo': { type: 'string' },
      clear: { type: 'boolean', default: false },
      'no-metro': { type: 'boolean', default: false },
      stub: { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },
    },
  });
  const mode = positionals[0] ?? 'live';
  if (!MODES.includes(mode)) fail(`unknown mode "${mode}" (expected ${MODES.join(' | ')})`);
  return { mode, flags: values };
}

function resolveRelayRepo(flags, state) {
  return (
    flags['relay-repo'] ??
    process.env.KANGENTIC_RELAY_REPO ??
    state.relayRepoPath ??
    resolve(repoRoot, '..', 'kangentic-relay')
  );
}

// ---------------------------------------------------------------------------
// Small process helpers

// All run() callers invoke real executables (adb, emulator, netstat,
// tasklist, taskkill), so no shell is needed; npm/npx (.cmd shims on
// Windows) go through spawnPrefixed, which uses a shell command string.
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function commandExists(command, args) {
  return run(command, args).status === 0;
}

/**
 * Spawn a long-lived child whose stdout/stderr are echoed with a prefix.
 * Runs through a shell as a single command string so npm/npx (.cmd shims on
 * Windows) resolve; every argument the rig passes is a constant or hex key.
 */
function spawnPrefixed(label, command, args, options = {}) {
  const child = spawn([command, ...args].join(' '), {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const forward = (stream) => {
    createInterface({ input: stream }).on('line', (line) => {
      console.log(`[${label}] ${line}`);
      options.onLine?.(line);
    });
  };
  forward(child.stdout);
  forward(child.stderr);
  child.on('exit', (code) => {
    log(`${label} exited (${code ?? 'signal'})`);
  });
  spawnedChildren.push({ label, child });
  return child;
}

function teardown() {
  for (const { label, child } of spawnedChildren.splice(0)) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    log(`stopping ${label} (pid ${child.pid})`);
    if (process.platform === 'win32') {
      // kill() alone misses npm > tsx > node process trees on Windows.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
    } else {
      child.kill('SIGTERM');
    }
  }
}

process.on('SIGINT', () => {
  log('shutting down (emulator stays up)...');
  teardown();
  process.exit(0);
});

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

// ---------------------------------------------------------------------------
// Port probes

async function probeHealthz() {
  try {
    const response = await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? 'relay' : 'other';
  } catch (fetchError) {
    // Only a refused connection proves the port is free; anything else
    // (timeout, reset, protocol error) means something non-relay is there.
    return fetchError.cause?.code === 'ECONNREFUSED' ? 'free' : 'other';
  }
}

/** True when the relay accepts a 32-hex session slot at upgrade time. */
function probeSessionSlot() {
  return new Promise((resolveProbe) => {
    const randomSlot = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const socket = new WebSocket(`${RELAY_URL}/?slot=${randomSlot}`);
    const finish = (accepted) => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolveProbe(accepted);
    };
    socket.onopen = () => finish(true);
    socket.onerror = () => finish(false);
    setTimeout(() => finish(false), 3000);
  });
}

function findPortListenerPid(port) {
  const netstat = run('netstat', ['-ano']);
  if (netstat.status !== 0) return null;
  for (const line of netstat.stdout.split('\n')) {
    if (!line.includes('LISTENING')) continue;
    if (!line.includes(`:${port} `) && !line.includes(`:${port}\r`)) continue;
    const columns = line.trim().split(/\s+/);
    const pid = Number(columns[columns.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function processNameForPid(pid) {
  const result = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  if (result.status !== 0) return null;
  const match = result.stdout.match(/^"([^"]+)"/m);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Emulator + adb

function attachedEmulator() {
  const result = run('adb', ['devices']);
  if (result.status !== 0) return null;
  const line = result.stdout.split('\n').find((deviceLine) => deviceLine.startsWith('emulator-') && deviceLine.includes('\tdevice'));
  return line ? line.split('\t')[0] : null;
}

function avdConfigPath(avdName) {
  const avdHome = process.env.ANDROID_AVD_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.android', 'avd');
  return join(avdHome, `${avdName}.avd`, 'config.ini');
}

async function ensureEmulator(avdName) {
  if (attachedEmulator()) {
    log('emulator already attached');
    return;
  }
  const listed = run('emulator', ['-list-avds']);
  if (listed.status !== 0) fail('the `emulator` command is not on PATH (add %ANDROID_HOME%\\emulator to PATH)');
  if (!listed.stdout.split('\n').map((name) => name.trim()).includes(avdName)) {
    fail(`AVD "${avdName}" not found. Available: ${listed.stdout.trim().split('\n').join(', ') || '(none)'}`);
  }
  log(`booting emulator ${avdName}...`);
  const emulatorChild = spawn('emulator', ['-avd', avdName], {
    detached: true,
    stdio: 'ignore',
  });
  emulatorChild.unref();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const boot = run('adb', ['shell', 'getprop', 'sys.boot_completed']);
    if (boot.stdout?.trim() === '1') {
      log('emulator booted');
      return;
    }
    await sleep(2000);
  }
  fail('emulator did not finish booting within 3 minutes');
}

function ensureAdbReverse() {
  // Wiped on every emulator reboot, so re-apply unconditionally.
  const result = run('adb', ['reverse', `tcp:${RELAY_PORT}`, `tcp:${RELAY_PORT}`]);
  if (result.status !== 0) fail(`adb reverse failed: ${result.stderr?.trim() || result.stdout?.trim()}`);
  log(`adb reverse tcp:${RELAY_PORT} in place`);
}

function devClientInstalled() {
  const result = run('adb', ['shell', 'pm', 'list', 'packages']);
  return result.status === 0 && result.stdout.includes(APP_PACKAGE);
}

// ---------------------------------------------------------------------------
// Relay

async function ensureRelay(relayRepo) {
  const state = await probeHealthz();
  if (state === 'relay') {
    log(`adopting the relay already running on port ${RELAY_PORT}`);
    const acceptsSessionSlot = await probeSessionSlot();
    if (!acceptsSessionSlot) {
      warn('the running relay REJECTS the 32-hex session slot: pairing will work, but every');
      warn('ongoing session will fail with HTTP 400 at upgrade. Restart it with:');
      warn(`  $env:SLOT_ID_PATTERN='${RELAY_SLOT_PATTERN}'; npm run dev   (PowerShell, in the relay repo)`);
      warn('or pull the relay fix that widens the default pattern.');
    }
    return;
  }
  if (state === 'other') {
    const pid = findPortListenerPid(RELAY_PORT);
    const name = pid ? processNameForPid(pid) : null;
    fail(`port ${RELAY_PORT} is taken by something that is not the relay (${name ?? 'unknown'} pid ${pid ?? '?'}). Not killing it; free the port and re-run.`);
  }
  if (!existsSync(join(relayRepo, 'package.json'))) {
    fail(`relay repo not found at ${relayRepo}. Clone kangentic-relay as a sibling, or point at it with --relay-repo / KANGENTIC_RELAY_REPO / relayRepoPath in .devrig.local.json`);
  }
  if (!existsSync(join(relayRepo, 'node_modules'))) {
    fail(`relay repo at ${relayRepo} has no node_modules - run npm install there first`);
  }
  log(`starting the relay from ${relayRepo}...`);
  spawnPrefixed('relay', 'npm', ['run', 'dev'], {
    cwd: relayRepo,
    env: { SLOT_ID_PATTERN: RELAY_SLOT_PATTERN },
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await probeHealthz()) === 'relay') {
      log('relay is healthy');
      return;
    }
    await sleep(500);
  }
  fail('relay did not become healthy within 30s');
}

// ---------------------------------------------------------------------------
// Metro

function freeStaleMetro() {
  const pid = findPortListenerPid(METRO_PORT);
  if (pid === null) return;
  const name = processNameForPid(pid);
  if (name !== 'node.exe') {
    fail(`port ${METRO_PORT} is held by ${name ?? 'an unidentified process'} (pid ${pid}), which is not a stray Metro. Not killing it; free the port and re-run (or pass --no-metro).`);
  }
  log(`killing stale Metro/node on port ${METRO_PORT} (pid ${pid})`);
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
}

function startMetro(flags, extraEnv = {}) {
  if (flags['no-metro']) {
    log('--no-metro: skipping Metro; run `npx expo start --android` yourself');
    return;
  }
  freeStaleMetro();
  const args = ['expo', 'start', '--android'];
  if (flags.clear) args.push('--clear');
  const metro = spawnPrefixed('metro', 'npx', args, { env: extraEnv });
  // Keep Metro's interactive keys (r = reload, j = devtools) working.
  process.stdin.pipe(metro.stdin);
}

// ---------------------------------------------------------------------------
// Stub peer

function startStub(state, flags) {
  const args = ['scripts/stubDesktopPeer.mjs', '--relay', RELAY_URL];
  const phoneKey = flags.fresh ? null : state.stubPhoneKey;
  if (phoneKey) {
    log('stub: session-only mode with the saved phone key (use --fresh to force a re-pair)');
    args.push('--phone-key', phoneKey);
  } else {
    log('stub: pairing mode - paste the printed URI into the app, SAS auto-confirms here');
    args.push('--yes');
  }
  let established = false;
  spawnPrefixed('stub', 'node', args, {
    onLine: (line) => {
      if (line.includes('[session] established')) established = true;
      const keyMatch = line.match(/Phone static key: ([0-9a-f]{64})/);
      if (keyMatch) {
        saveState({ stubPhoneKey: keyMatch[1] });
        log(`saved the phone static key to ${STATE_FILE}`);
      }
    },
  });
  if (phoneKey) {
    setTimeout(() => {
      if (!established) {
        warn('no [session] established after 20s - the saved pairing may be stale');
        warn('(app re-paired, or the stub identity in the OS temp dir was reset).');
        warn('Re-pair fresh with: npm run dev:pair -- --stub');
      }
    }, 20_000).unref();
  }
}

// ---------------------------------------------------------------------------
// Doctor

async function doctor({ relayRepo, avdName, needsRelay }) {
  const checks = [];
  const add = (ok, label, hint) => checks.push({ ok, label, hint });

  add(commandExists('adb', ['version']), 'adb on PATH', 'install Android platform-tools and add them to PATH');
  const emulatorOk = commandExists('emulator', ['-list-avds']);
  add(emulatorOk, 'emulator on PATH', 'add %ANDROID_HOME%\\emulator to PATH');
  if (emulatorOk) {
    const avds = run('emulator', ['-list-avds']).stdout ?? '';
    add(avds.split('\n').map((name) => name.trim()).includes(avdName), `AVD "${avdName}" exists`, 'create it in Android Studio, or pass --avd <name>');
  }

  const configPath = avdConfigPath(avdName);
  if (existsSync(configPath)) {
    const keyboardEnabled = /hw\.keyboard\s*=\s*yes/.test(readFileSync(configPath, 'utf8'));
    add(keyboardEnabled, 'AVD hardware keyboard enabled (hw.keyboard=yes)', `set hw.keyboard=yes in ${configPath} (emulator stopped) or typing from the host keyboard will not reach the app`);
  }

  add(existsSync(join(relayRepo, 'package.json')), `relay repo at ${relayRepo}`, 'clone kangentic-relay as a sibling or set KANGENTIC_RELAY_REPO');
  if (existsSync(join(relayRepo, 'package.json'))) {
    add(existsSync(join(relayRepo, 'node_modules')), 'relay repo installed', `run npm install in ${relayRepo}`);
  }

  const relayState = await probeHealthz();
  if (relayState === 'relay') {
    add(true, `relay running on port ${RELAY_PORT}`);
    add(await probeSessionSlot(), 'relay accepts the 32-hex session slot', `restart it with SLOT_ID_PATTERN='${RELAY_SLOT_PATTERN}'`);
  } else if (relayState === 'free') {
    add(true, `port ${RELAY_PORT} free (rig will start the relay${needsRelay ? '' : ' when a connected mode needs it'})`);
  } else {
    add(false, `port ${RELAY_PORT} held by a non-relay process`, 'free the port');
  }

  const metroPid = findPortListenerPid(METRO_PORT);
  if (metroPid === null) {
    add(true, `port ${METRO_PORT} free for Metro`);
  } else {
    const name = processNameForPid(metroPid);
    add(name === 'node.exe', `port ${METRO_PORT} held by ${name ?? 'unknown'} (pid ${metroPid})`, name === 'node.exe' ? undefined : 'not a stray Metro; free it manually');
  }

  if (attachedEmulator()) {
    add(devClientInstalled(), `dev client (${APP_PACKAGE}) installed`, 'run npx expo run:android once to build and install it');
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(nodeMajor >= 22, `Node >= 22 (running ${process.versions.node})`, 'the rig uses the built-in fetch and WebSocket');

  let failures = 0;
  for (const { ok, label, hint } of checks) {
    console.log(`  ${ok ? 'ok  ' : 'WARN'}  ${label}${!ok && hint ? `\n        -> ${hint}` : ''}`);
    if (!ok) failures += 1;
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Modes

function printLiveChecklist() {
  console.log(`
[rig] Live mode: this rig never launches the desktop app. One-time desktop setup
[rig] (in your running Kangentic dev instance):
[rig]   1. Settings > Mobile Devices > enable the mobile bridge
[rig]   2. Relay URL: ${RELAY_URL}
[rig]   3. Pair a device, copy the pairing link, paste it into the app, confirm the SAS
[rig]   4. Grant the write verbs you want to exercise (messages, prompts, terminal, tasks)
`);
}

async function main() {
  const { mode, flags } = parseRigArgs(process.argv.slice(2));
  const state = loadState();
  const relayRepo = resolveRelayRepo(flags, state);
  const avdName = flags.avd ?? state.avdName ?? DEFAULT_AVD;
  const needsRelay = mode === 'live' || mode === 'pair' || mode === 'stub';

  if (mode === 'doctor') {
    const failures = await doctor({ relayRepo, avdName, needsRelay: false });
    log(failures === 0 ? 'all checks passed' : `${failures} check(s) need attention`);
    process.exit(failures === 0 ? 0 : 1);
  }

  log(`mode: ${mode}`);
  if (!commandExists('adb', ['version'])) fail('adb is not on PATH');
  await ensureEmulator(avdName);

  if (needsRelay) {
    await ensureRelay(relayRepo);
    ensureAdbReverse();
  }

  if (mode === 'pair') {
    if (devClientInstalled()) {
      log(`resetting ${APP_PACKAGE} to unpaired (pm clear)...`);
      run('adb', ['shell', 'pm', 'clear', APP_PACKAGE]);
    } else {
      warn(`${APP_PACKAGE} is not installed; run npx expo run:android once first`);
    }
    if (flags.stub) {
      startStub({ ...state, stubPhoneKey: null }, { ...flags, fresh: true });
    } else {
      printLiveChecklist();
    }
  }

  if (mode === 'live') printLiveChecklist();
  if (mode === 'stub') startStub(state, flags);

  if (mode === 'mock') {
    log('mock mode: in-app fake desktop, no relay or pairing involved');
    log('(switching mock on/off later needs a Metro restart with --clear: the flag is inlined at bundle time)');
    startMetro(flags, { EXPO_PUBLIC_KANGENTIC_MOCK: '1' });
  } else {
    startMetro(flags);
  }

  if (flags['no-metro'] && spawnedChildren.length === 0) {
    log('nothing left to supervise; exiting');
    process.exit(0);
  }
}

main().catch((mainError) => fail(mainError.stack ?? String(mainError)));
