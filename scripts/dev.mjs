#!/usr/bin/env node
/**
 * Local dev rig: one command that wires up everything a preview needs -
 * emulator, adb reverse, a local kangentic-relay, optionally the stub
 * desktop peer, and Metro - in one of four modes:
 *
 *   node scripts/dev.mjs mock     Fake in-app desktop peer; no relay, no
 *                                    desktop, no pairing. UI/UX iteration.
 *   node scripts/dev.mjs live     (default) Connect to your real running
 *                                    Kangentic desktop dev instance through a
 *                                    local relay. Dogfooding.
 *   node scripts/dev.mjs pair     Reset the app to unpaired (pm clear) and
 *                                    exercise the pairing ceremony. Add --stub
 *                                    to pair against the stub peer instead of
 *                                    the live desktop.
 *   node scripts/dev.mjs stub     Relay + scripts/stubDesktopPeer.mjs, the
 *                                    Maestro E2E rig. Reuses the saved phone
 *                                    key for a no-re-pair session when it can.
 *   node scripts/dev.mjs doctor   Preflight checks only.
 *   node scripts/dev.mjs stop     Stop every rig process (this run's and any
 *                                    orphaned by an earlier one), leaving the
 *                                    relay and emulator up. Starting any mode
 *                                    does this first, so `stop` is only needed
 *                                    to hand the machine back clean.
 *
 * Flags: --avd <name>, --serial <adb serial>, --relay-repo <path>,
 *        --kangentic-repo <path>, --clear, --no-metro, --no-protocol-link,
 *        --stub (pair mode), --fresh (stub mode: ignore the saved phone key),
 *        --headless (boot the emulator with -no-window; Maestro and
 *        screenshots work identically, there is just no window to watch),
 *        --wifi (physical device: switch it onto wireless adb, which keeps a
 *        long session's bulk transfers off the USB endpoints that wedge the
 *        adb server, and lets the phone be picked up without dropping),
 *        --shard <N> (stub mode: boot N-1 extra read-only emulator
 *        instances, each auto-paired to its own stub via
 *        .maestro/setup/pairing-bootstrap.yaml, then run the batch with
 *        `maestro test --shard-split N .maestro/paired`).
 *
 * Devices: every adb call targets ONE device, chosen once per run via
 * --serial (or the ANDROID_SERIAL env var, which adb honors natively and
 * every child process inherits). With a single ready device attached the
 * choice is automatic (a physical device skips the emulator boot); with
 * several attached the rig fails early and lists the serials.
 *
 * Every run builds the sibling kangentic monorepo's packages/protocol and
 * links its packed output into node_modules (unless --no-protocol-link or the
 * sibling repo is absent), so local dev tracks the @kangentic/protocol source
 * of truth without an npm publish; a change to the protocol source forces a
 * clean Metro cache. See docs/developer-guide.md's "Developing @kangentic/protocol".
 *
 * Local state lives in the gitignored .devrig.local.json at the repo root:
 *   { "relayRepoPath": "...", "kangenticRepoPath": "...", "stubPhoneKey":
 *     "<64 hex>", "avdName": "...", "linkedProtocolHash": "..." }
 * Relay repo resolution: --relay-repo > KANGENTIC_RELAY_REPO env >
 * .devrig.local.json > ../kangentic-relay (sibling of the MAIN checkout; in
 * an agent worktree under .kangentic/worktrees/ the siblings still live next
 * to the main repo, so the fallback resolves through git's common dir). The
 * kangentic repo resolves the same way (--kangentic-repo / KANGENTIC_REPO /
 * state / ../kangentic). A worktree run also inherits the identity keys
 * (dev phone key, stub phone key, repo paths) from the main checkout's state
 * file so it never mints a second dev identity into the desktop roster.
 *
 * The rig adopts healthy already-running pieces (relay via /healthz, Metro
 * via port 8081, emulator via adb devices) and only tears down children it
 * spawned itself. Ctrl-C stops stub/Metro; the RELAY is spawned detached
 * (logs in the OS temp dir) so it outlives the rig and whatever terminal
 * or agent session launched it - the desktop's bridge and the phone both
 * depend on it, and neither should die with a dev-loop restart. The
 * emulator stays up too.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Sibling repos (kangentic, kangentic-relay) and the shared dev identity live
// next to the MAIN checkout. When the rig runs from an agent worktree
// (.kangentic/worktrees/<branch>), repoRoot is the worktree, so '..' would
// point inside .kangentic/worktrees/ - resolve the main checkout through
// git's common dir instead.
function resolveMainRepoRoot() {
  const result = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (result.status !== 0) return repoRoot;
  const commonDir = result.stdout?.trim();
  if (!commonDir) return repoRoot;
  return dirname(resolve(commonDir));
}
const mainRepoRoot = resolveMainRepoRoot();

const STATE_FILE = join(repoRoot, '.devrig.local.json');
const APP_PACKAGE = 'com.kangentic.mobile';
const RELAY_PORT = 8080;
const METRO_PORT = 8081;
// The dev inspect loop (scripts/mobileInspect.mjs state dumps): the app's
// dev-only bridge dials out to 127.0.0.1:8791 via adb reverse.
const INSPECT_PORT = 8791;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
// Until every local relay checkout carries the widened default, always start
// the relay with the session slot length allowed (32-hex session slot plus
// the 64-hex pairing slot). Harmless once the relay default matches.
const RELAY_SLOT_PATTERN = '^([0-9a-f]{32}|[0-9a-f]{64})$';
const DEFAULT_AVD = 'kangentic_pixel';
const MODES = ['mock', 'live', 'pair', 'stub', 'doctor', 'emu', 'adb', 'stop'];

const spawnedChildren = [];
// Set during teardown so child exit handlers (e.g. the stub auto-restart)
// never respawn a process the rig itself is killing.
let shuttingDown = false;

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

// Keys a worktree run inherits from the main checkout's state file: identity
// and machine paths must be shared (a fresh dev phone identity per worktree
// would pollute the desktop roster with duplicate devices). Cache keys
// (linkedProtocolHash, lastQuickPairEnv, inspectEnvEnabled) stay
// per-checkout: they describe this checkout's node_modules and Metro cache.
const SHARED_STATE_KEYS = ['relayRepoPath', 'kangenticRepoPath', 'avdName', 'stubPhoneKey', 'devPhoneKeyPair'];

function readStateFile(statePath) {
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (parseError) {
    warn(`ignoring unreadable ${statePath}: ${parseError.message}`);
    return {};
  }
}

function loadState() {
  const local = readStateFile(STATE_FILE);
  if (mainRepoRoot === repoRoot) return local;
  const shared = readStateFile(join(mainRepoRoot, '.devrig.local.json'));
  const merged = { ...local };
  for (const key of SHARED_STATE_KEYS) {
    if (merged[key] === undefined && shared[key] !== undefined) merged[key] = shared[key];
  }
  return merged;
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
      serial: { type: 'string' },
      'relay-repo': { type: 'string' },
      'kangentic-repo': { type: 'string' },
      clear: { type: 'boolean', default: false },
      'no-metro': { type: 'boolean', default: false },
      'no-protocol-link': { type: 'boolean', default: false },
      stub: { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      shard: { type: 'string' },
      wifi: { type: 'boolean', default: false },
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
    resolve(mainRepoRoot, '..', 'kangentic-relay')
  );
}

function resolveKangenticRepo(flags, state) {
  return (
    flags['kangentic-repo'] ??
    process.env.KANGENTIC_REPO ??
    state.kangenticRepoPath ??
    resolve(mainRepoRoot, '..', 'kangentic')
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

// Blocking shell command (npm/npx need the shell for their .cmd shims on
// Windows). Distinct from spawnPrefixed, which supervises a long-lived child.
function runShell(commandString, options = {}) {
  return spawnSync(commandString, { encoding: 'utf8', shell: true, windowsHide: true, ...options });
}

// ---------------------------------------------------------------------------
// Local @kangentic/protocol linking
//
// The protocol package is the source of truth in the sibling kangentic
// monorepo (packages/protocol). Rather than publish to npm on every change
// (slow), local dev builds that package and links its packed output into this
// app's node_modules, so Metro/tsc track the monorepo checkout. The committed
// package.json stays pinned to the published range - this only touches
// node_modules. See docs/developer-guide.md's "Developing @kangentic/protocol".

/** Content hash of the protocol package's source, so a re-link only happens when it actually changed. */
function hashProtocolSource(protocolDir) {
  const hash = createHash('sha256');
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      hash.update(full);
      hash.update(readFileSync(full));
    }
  };
  walk(join(protocolDir, 'src'));
  hash.update(readFileSync(join(protocolDir, 'package.json')));
  return hash.digest('hex');
}

/**
 * Build the sibling @kangentic/protocol and link its packed build into this
 * app's node_modules. Best-effort: any failure (or an absent sibling repo)
 * warns and falls back to whatever @kangentic/protocol is already installed,
 * so the rig never dies over the link. Returns true when the link changed, so
 * the caller can force a clean Metro cache (Metro caches resolved deps).
 */
function ensureLocalProtocol(kangenticRepo, flags) {
  if (flags['no-protocol-link']) return false;
  const protocolDir = join(kangenticRepo, 'packages', 'protocol');
  if (!existsSync(join(protocolDir, 'package.json'))) {
    log(`protocol: no packages/protocol under ${kangenticRepo}; using the installed @kangentic/protocol`);
    return false;
  }
  const installedDir = join(repoRoot, 'node_modules', '@kangentic', 'protocol');
  const sourceHash = hashProtocolSource(protocolDir);
  if (loadState().linkedProtocolHash === sourceHash && existsSync(installedDir)) {
    log('protocol: local build already linked (source unchanged)');
    return false;
  }
  log('protocol: building and linking the local @kangentic/protocol...');
  const build = runShell('npm run build --workspace packages/protocol', { cwd: kangenticRepo });
  if (build.status !== 0) {
    warn(`protocol build failed; keeping the installed package.\n${(build.stderr || build.stdout || '').trim()}`);
    return false;
  }
  const packDestination = tmpdir();
  const pack = runShell(`npm pack --workspace packages/protocol --pack-destination "${packDestination}"`, { cwd: kangenticRepo });
  if (pack.status !== 0) {
    warn(`protocol pack failed; keeping the installed package.\n${(pack.stderr || pack.stdout || '').trim()}`);
    return false;
  }
  const tarballName = pack.stdout.trim().split('\n').pop().trim();
  const install = runShell(`npm install "${join(packDestination, tarballName)}" --no-save`, { cwd: repoRoot });
  if (install.status !== 0) {
    warn(`protocol link install failed; keeping the installed package.\n${(install.stderr || install.stdout || '').trim()}`);
    return false;
  }
  saveState({ linkedProtocolHash: sourceHash });
  log('protocol: linked the local build (clearing Metro cache to pick it up)');
  return true;
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

/**
 * Every rig-owned process still running, this one excluded: previous rig
 * invocations, their stub peers, and their Metro bundlers.
 *
 * The rig only ever killed the children IT spawned, so an interrupted run
 * (a killed terminal, an agent session ending, a Ctrl-C that missed) left
 * orphans behind. They do not sit idle: each stub redials the same relay
 * slot and each Metro wants port 8081, so a handful of them fight over one
 * device and the symptoms read as a flaky app - sessions that will not
 * establish, a bundler that answers but serves nothing. Observed at six
 * live processes in one session before anyone noticed.
 */
function findOrphanRigProcesses() {
  if (process.platform !== 'win32') return [];
  const query =
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | " +
    'Where-Object { $_.CommandLine -match \'dev\\.mjs|stubDesktopPeer|expo(-cli)?.*start\' } | ' +
    'Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress';
  const listed = spawnSync('powershell', ['-NoProfile', '-Command', query], { encoding: 'utf8' });
  if (listed.status !== 0 || !listed.stdout?.trim()) return [];
  let rows;
  try {
    rows = JSON.parse(listed.stdout);
  } catch {
    return [];
  }
  const all = Array.isArray(rows) ? rows : [rows];
  return all
    .filter((row) => row && typeof row.ProcessId === 'number' && row.ProcessId !== process.pid)
    .map((row) => ({ pid: row.ProcessId, commandLine: String(row.CommandLine ?? '').trim() }));
}

/** Kill the orphans above, process tree and all. Returns how many were cleared. */
function killOrphanRigProcesses(orphans) {
  for (const orphan of orphans) {
    spawnSync('taskkill', ['/PID', String(orphan.pid), '/T', '/F'], { encoding: 'utf8' });
  }
  return orphans.length;
}

function teardown() {
  shuttingDown = true;
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

/**
 * True when Metro answers its status endpoint. Holding port 8081 is not the
 * same as serving: a wedged bundler leaves the dev client waiting on a bundle
 * that never arrives, and Android reports that as a startup ANR rather than
 * an error anyone can read.
 */
async function probeMetroStatus() {
  try {
    const response = await fetch(`http://127.0.0.1:${METRO_PORT}/status`, { signal: AbortSignal.timeout(4000) });
    return response.ok;
  } catch {
    return false;
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

function listAdbDevices() {
  const result = run('adb', ['devices']);
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('List of devices') && line.includes('\t'))
    .map((line) => {
      const [serial, state] = line.split('\t').map((column) => column.trim());
      return { serial, state, isEmulator: serial.startsWith('emulator-') };
    });
}

/**
 * Move a USB-attached physical device onto wireless adb.
 *
 * The adb server wedges under repeated large bulk transfers over USB: adb's
 * own zero-length-packet doc describes a stalled transfer merging into the
 * next packet header, which closes the connection ("received too many bytes
 * while waiting for payload") and can leave the server unresponsive. Every
 * command then BLOCKS rather than failing, which is how a wedge became a
 * ten-minute stall. Screenshots and scrollback pulls are exactly that traffic.
 *
 * TCP transport does not use those USB endpoints, so the whole class goes
 * away - and the phone can be picked up and carried off without dropping the
 * session. Returns the `host:port` serial to target, or null to stay on USB.
 */
function enableWirelessAdb(usbSerial) {
  const ipResult = run('adb', ['-s', usbSerial, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0']);
  const ipMatch = ipResult.stdout?.match(/inet (\d+\.\d+\.\d+\.\d+)/);
  if (!ipMatch) {
    warn('could not read the device wlan0 address; staying on USB');
    return null;
  }
  const deviceIp = ipMatch[1];
  const tcpip = run('adb', ['-s', usbSerial, 'tcpip', '5555']);
  if (tcpip.status !== 0) {
    warn('adb tcpip failed; staying on USB');
    return null;
  }
  // adbd restarts its listener; connecting immediately races that.
  spawnSync('cmd', ['/c', 'timeout', '/t', '2', '/nobreak'], { stdio: 'ignore' });
  const wirelessSerial = `${deviceIp}:5555`;
  const connected = run('adb', ['connect', wirelessSerial]);
  if (connected.status !== 0 || !/connected/i.test(connected.stdout ?? '')) {
    warn(`adb connect ${wirelessSerial} failed; staying on USB`);
    return null;
  }
  log(`wireless adb: ${wirelessSerial} (USB bulk transfers no longer wedge the server)`);
  return wirelessSerial;
}

function describeDevices(devices) {
  if (devices.length === 0) return '(none)';
  return devices.map((device) => `${device.serial} (${device.state}${device.isEmulator ? ', emulator' : ''})`).join(', ');
}

function attachedEmulator() {
  const device = listAdbDevices().find((candidate) => candidate.isEmulator && candidate.state === 'device');
  return device ? device.serial : null;
}

/**
 * Pick the one adb device every subsequent adb call targets. An explicit
 * serial (--serial / ANDROID_SERIAL) wins; otherwise a single ready device
 * is unambiguous, several ready devices demand an explicit choice, and
 * nothing ready returns null (the caller may boot the emulator).
 */
function selectAdbTarget(requestedSerial) {
  const devices = listAdbDevices();
  const ready = devices.filter((device) => device.state === 'device');
  const unauthorized = devices.filter((device) => device.state === 'unauthorized');
  if (requestedSerial) {
    const match = ready.find((device) => device.serial === requestedSerial);
    if (!match) {
      const authHint = unauthorized.some((device) => device.serial === requestedSerial)
        ? ' - accept the USB debugging prompt on the device'
        : '';
      fail(`device "${requestedSerial}" is not attached and ready. Attached: ${describeDevices(devices)}${authHint}`);
    }
    return match;
  }
  if (ready.length === 1) return ready[0];
  if (ready.length > 1) {
    fail(`multiple devices attached (${describeDevices(ready)}); pick one with --serial <serial> or ANDROID_SERIAL`);
  }
  if (unauthorized.length > 0) {
    warn(`attached but unauthorized: ${describeDevices(unauthorized)} - accept the USB debugging prompt on the device to use it`);
  }
  return null;
}

/**
 * adb honors ANDROID_SERIAL natively and every child this rig spawns
 * (Metro, mobileInspect.mjs, the stub) inherits the env, so setting it once
 * threads the chosen device through every adb call without touching call
 * sites.
 */
function applyAdbTarget(device) {
  process.env.ANDROID_SERIAL = device.serial;
  log(`target device: ${device.serial}${device.isEmulator ? '' : ' (physical)'}`);
}

function avdConfigPath(avdName) {
  const avdHome = process.env.ANDROID_AVD_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.android', 'avd');
  return join(avdHome, `${avdName}.avd`, 'config.ini');
}

/** Boot the AVD cold and wait for it; returns the booted emulator's serial. */
async function bootEmulator(avdName, { headless = false, readOnly = false } = {}) {
  const listed = run('emulator', ['-list-avds']);
  if (listed.status !== 0) fail('the `emulator` command is not on PATH (add %ANDROID_HOME%\\emulator to PATH)');
  if (!listed.stdout.split('\n').map((name) => name.trim()).includes(avdName)) {
    fail(`AVD "${avdName}" not found. Available: ${listed.stdout.trim().split('\n').join(', ') || '(none)'}`);
  }
  // With another emulator already attached (sharding), the boot poll must
  // bind to the NEW instance, never an already-running one.
  const alreadyAttached = new Set(listAdbDevices().map((device) => device.serial));
  log(`booting emulator ${avdName} (host GPU, cold boot${headless ? ', headless' : ''}${readOnly ? ', read-only instance' : ''})...`);
  // Explicit host GPU: an AVD with hw.gpu.enabled=no renders in software
  // and degrades over long sessions (progressive input + window lag).
  // NOTE emulator 36.6.11.0 rejects the old angle_indirect value (silently
  // falls back to auto); the valid accelerated mode is 'host'. The AVD
  // config carries hw.gpu.mode=host for boots that bypass the rig; the
  // flag here overrides whatever the config says. ALWAYS cold boot
  // (-no-snapshot-load): resuming a Quick Boot snapshot taken under a
  // different GPU config wedges the guest with adb reporting offline.
  // -no-window (headless): Maestro drives the device purely over adb/gRPC
  // and screenshots capture the guest framebuffer, so a window is only for
  // human spectating; headless skips host compositing entirely.
  // -read-only: boots an ADDITIONAL instance of the same AVD (sharding);
  // its disk changes are discarded at shutdown, so a sharded instance is
  // re-paired fresh every rig run via the pairing bootstrap flow.
  const emulatorArgs = ['-avd', avdName, '-no-snapshot-load', '-gpu', 'host'];
  if (headless) emulatorArgs.push('-no-window');
  if (readOnly) emulatorArgs.push('-read-only');
  const emulatorChild = spawn('emulator', emulatorArgs, {
    detached: true,
    stdio: 'ignore',
  });
  emulatorChild.unref();
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    // Poll per-serial: a physical device may be attached alongside, so a
    // bare `adb shell` would refuse with "more than one device".
    for (const device of listAdbDevices()) {
      if (!device.isEmulator || device.state !== 'device' || alreadyAttached.has(device.serial)) continue;
      const boot = run('adb', ['-s', device.serial, 'shell', 'getprop', 'sys.boot_completed']);
      if (boot.stdout?.trim() === '1') {
        log(`emulator booted (${device.serial})`);
        return device.serial;
      }
    }
    await sleep(2000);
  }
  fail('emulator did not finish booting within 5 minutes');
}

/**
 * Resolve the device this run targets: an attached ready device when one is
 * unambiguous (physical devices are first-class targets and skip the
 * emulator boot), else boot the AVD. Sets ANDROID_SERIAL for everything
 * downstream.
 */
async function ensureDevice(avdName, requestedSerial, { headless = false, wifi = false } = {}) {
  let target = selectAdbTarget(requestedSerial);
  if (!target) {
    const serial = await bootEmulator(avdName, { headless });
    target = { serial, state: 'device', isEmulator: true };
  }
  // --wifi only makes sense for a physical device already reachable over USB;
  // an emulator's transport is a local socket and never hits the USB stack.
  if (wifi && !target.isEmulator && !target.serial.includes(':')) {
    const wirelessSerial = enableWirelessAdb(target.serial);
    if (wirelessSerial) target = { serial: wirelessSerial, state: 'device', isEmulator: false };
  }
  applyAdbTarget(target);
  return target;
}

function ensureAdbReverse() {
  // Wiped on every emulator reboot, so re-apply unconditionally.
  const result = run('adb', ['reverse', `tcp:${RELAY_PORT}`, `tcp:${RELAY_PORT}`]);
  if (result.status !== 0) fail(`adb reverse failed: ${result.stderr?.trim() || result.stdout?.trim()}`);
  log(`adb reverse tcp:${RELAY_PORT} in place`);
}

/**
 * Restore every reverse tunnel on every ATTACHED device.
 *
 * An adb server restart wipes the reverses for all of them, but the rig's
 * other helpers target one selected device, so recovering with a phone AND an
 * emulator attached silently left the unselected one with no tunnels at all.
 * It does not fail loudly: the app on that device simply cannot reach Metro or
 * the relay, so it hangs on startup until Android ANR-kills it, and the dev
 * client then reports "the development build crashed". Cost an evening once.
 */
function restoreAllAdbReverses() {
  for (const device of listAdbDevices()) {
    if (device.state !== 'device') continue;
    for (const port of [RELAY_PORT, METRO_PORT, INSPECT_PORT]) {
      const result = run('adb', ['-s', device.serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
      if (result.status !== 0) {
        warn(`adb -s ${device.serial} reverse tcp:${port} failed: ${result.stderr?.trim() || result.stdout?.trim()}`);
      }
    }
    log(`reverses restored on ${device.serial}`);
  }
}

/** Host ports currently reverse-tunnelled on one device. */
function listAdbReverses(serial) {
  const result = run('adb', ['-s', serial, 'reverse', '--list']);
  if (result.status !== 0) return [];
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/tcp:(\d+)\s+tcp:(\d+)/);
      return match ? Number(match[1]) : null;
    })
    .filter((port) => port !== null);
}

/** Ports the app needs tunnelled on every device the rig drives. */
const REQUIRED_REVERSE_PORTS = [RELAY_PORT, METRO_PORT, INSPECT_PORT];

/** Serial-scoped reverse for sharded instances (the plain helpers target ANDROID_SERIAL). */
function ensureAdbReverseFor(serial, port) {
  const result = run('adb', ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
  if (result.status !== 0) fail(`adb -s ${serial} reverse tcp:${port} failed: ${result.stderr?.trim() || result.stdout?.trim()}`);
}

/**
 * Open the dev client's deep link so it loads the bundle from Metro over the
 * device's adb reverse, instead of showing the launcher's "start a
 * development server" screen. Needed after `pm clear`, which wipes the saved
 * server URL with the rest of the app's data.
 *
 * The URL is the loopback one deliberately: every device the rig drives has
 * `adb reverse tcp:8081`, so it works on an emulator and a physical device
 * alike, with no LAN address to guess at.
 */
function pointDevClientAtMetro(serial) {
  const deepLink = `kangentic://expo-development-client/?url=${encodeURIComponent(`http://127.0.0.1:${METRO_PORT}`)}`;
  const result = run('adb', ['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', deepLink]);
  if (result.status !== 0) {
    warn(`could not point the dev client at Metro on ${serial}: ${result.stderr?.trim() || result.stdout?.trim()}`);
  }
}

function ensureInspectAdbReverse() {
  // Every mode gets the inspect loop's reverse (mock mode has no relay but
  // still wants state dumps). Non-fatal: the loop is a dev nicety.
  const result = run('adb', ['reverse', `tcp:${INSPECT_PORT}`, `tcp:${INSPECT_PORT}`]);
  if (result.status !== 0) {
    warn(`adb reverse tcp:${INSPECT_PORT} failed (inspect state dumps unavailable): ${result.stderr?.trim() || result.stdout?.trim()}`);
    return;
  }
  log(`adb reverse tcp:${INSPECT_PORT} in place (inspect loop)`);
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
  log(`starting the relay from ${relayRepo} (detached - it outlives this rig)...`);
  // Detached on purpose: the desktop's bridge and the phone both hold
  // sessions through this relay, and a rig or agent-session restart must
  // not sever them. Later rig runs adopt it via /healthz.
  const relayLogPath = join(tmpdir(), 'kangentic-relay-dev.log');
  const relayLogFd = openSync(relayLogPath, 'a');
  const relayChild = spawn('npm run dev', {
    cwd: relayRepo,
    env: { ...process.env, SLOT_ID_PATTERN: RELAY_SLOT_PATTERN },
    shell: true,
    detached: true,
    stdio: ['ignore', relayLogFd, relayLogFd],
    windowsHide: true,
  });
  relayChild.unref();
  log(`relay logs: ${relayLogPath}`);
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
  // Every rig mode enables the dev inspect bridge (dev builds only; the
  // module is stripped from prod bundles). Inlined at bundle time like the
  // mock flag, hence the one-time --clear main() forces when it first flips.
  const metro = spawnPrefixed('metro', 'npx', args, { env: { EXPO_PUBLIC_KANGENTIC_INSPECT: '1', ...extraEnv } });
  // Keep Metro's interactive keys (r = reload, j = devtools) working.
  process.stdin.pipe(metro.stdin);
}

// ---------------------------------------------------------------------------
// Stub peer

function startStub(state, flags, restartCount = 0) {
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
  const stubChild = spawnPrefixed('stub', 'node', args, {
    onLine: (line) => {
      if (line.includes('[session] established')) established = true;
      const keyMatch = line.match(/Phone static key: ([0-9a-f]{64})/);
      if (keyMatch) {
        saveState({ stubPhoneKey: keyMatch[1] });
        log(`saved the phone static key to ${STATE_FILE}`);
      }
    },
  });
  // A dead stub silently strands every paired Maestro flow after it, so a
  // crash restarts it (bounded; a clean exit or rig shutdown does not).
  stubChild.on('exit', (exitCode) => {
    if (shuttingDown || exitCode === 0) return;
    if (restartCount >= 5) {
      warn('stub crashed 5 times; not restarting it again - investigate the [fatal] lines above');
      return;
    }
    warn(`stub crashed (${exitCode ?? 'signal'}); restarting it in 2s...`);
    setTimeout(() => startStub(loadState(), flags, restartCount + 1), 2000);
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
// Sharding: extra emulator instances, each paired to its own stub

/**
 * Boot N-1 additional read-only instances of the AVD and pair each to its
 * own stub peer (own identity file: the pairing and session slots derive
 * from the desktop static key, so instances must not share one). Read-only
 * instances discard disk changes at shutdown, so pairing is re-run fresh
 * each time via .maestro/setup/pairing-bootstrap.yaml. Returns the extra
 * serials; afterwards `maestro test --shard-split N .maestro/paired`
 * distributes flows across all instances.
 */
async function setupShardDevices(shardCount, avdName, flags) {
  const extraSerials = [];
  for (let shardIndex = 1; shardIndex < shardCount; shardIndex++) {
    log(`shard ${shardIndex}: booting an additional read-only emulator instance...`);
    const serial = await bootEmulator(avdName, { headless: flags.headless, readOnly: true });
    ensureAdbReverseFor(serial, RELAY_PORT);
    ensureAdbReverseFor(serial, METRO_PORT);

    const identityFile = join(tmpdir(), `kangentic-stub-desktop-identity-shard${shardIndex}.json`);
    let pairingUri = null;
    let established = false;
    spawnPrefixed(`stub${shardIndex}`, 'node', ['scripts/stubDesktopPeer.mjs', '--relay', RELAY_URL, '--yes', '--identity-file', identityFile], {
      onLine: (line) => {
        const uriMatch = line.match(/kangentic-pair:\/\/[A-Za-z0-9-]+/);
        if (uriMatch) pairingUri = uriMatch[0];
        if (line.includes('[session] established')) established = true;
      },
    });
    const uriDeadline = Date.now() + 30_000;
    while (pairingUri === null && Date.now() < uriDeadline) {
      await sleep(500);
    }
    if (pairingUri === null) fail(`shard ${shardIndex}: the stub printed no pairing URI within 30s`);

    log(`shard ${shardIndex}: clearing the app on ${serial} and running the pairing bootstrap flow...`);
    run('adb', ['-s', serial, 'shell', 'pm', 'clear', APP_PACKAGE]);
    // `pm clear` wipes the dev client's saved Metro URL along with the app's
    // data, so a plain launchApp lands on the dev LAUNCHER ("Start a local
    // development server with npx expo start") and no JS ever loads - the
    // bootstrap flow then waits out its full timeout for a screen that
    // cannot appear. Point the dev client back at Metro first, the same way
    // `expo start --android` does for the primary device.
    pointDevClientAtMetro(serial);
    const bootstrap = runShell(`maestro --device ${serial} test -e PAIRING_URI=${pairingUri} .maestro/setup/pairing-bootstrap.yaml`, {
      cwd: repoRoot,
      timeout: 300_000,
    });
    if (bootstrap.status !== 0) {
      fail(`shard ${shardIndex}: pairing bootstrap failed on ${serial}:\n${(bootstrap.stdout ?? '').slice(-2000)}\n${(bootstrap.stderr ?? '').slice(-2000)}`);
    }
    const establishDeadline = Date.now() + 30_000;
    while (!established && Date.now() < establishDeadline) {
      await sleep(500);
    }
    if (!established) fail(`shard ${shardIndex}: the session did not establish after the pairing bootstrap`);
    log(`shard ${shardIndex}: ${serial} paired and established`);
    extraSerials.push(serial);
  }
  return extraSerials;
}

// ---------------------------------------------------------------------------
// Doctor

async function doctor({ relayRepo, avdName, requestedSerial }) {
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
    const avdConfig = readFileSync(configPath, 'utf8');
    const keyboardEnabled = /hw\.keyboard\s*=\s*yes/.test(avdConfig);
    add(keyboardEnabled, 'AVD hardware keyboard enabled (hw.keyboard=yes)', `set hw.keyboard=yes in ${configPath} (emulator stopped) or typing from the host keyboard will not reach the app`);
    const gpuAccelerated = /hw\.gpu\.enabled\s*=\s*yes/.test(avdConfig) && /hw\.gpu\.mode\s*=\s*host/.test(avdConfig);
    add(gpuAccelerated, 'AVD GPU accelerated (hw.gpu.enabled=yes, hw.gpu.mode=host)', `set both in ${configPath} (emulator stopped) or the emulator renders in software and degrades over long sessions`);
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
    add(true, `port ${RELAY_PORT} free (rig will start the relay when a connected mode needs it)`);
  } else {
    add(false, `port ${RELAY_PORT} held by a non-relay process`, 'free the port');
  }

  const metroPid = findPortListenerPid(METRO_PORT);
  if (metroPid === null) {
    add(true, `port ${METRO_PORT} free for Metro`);
  } else {
    const name = processNameForPid(metroPid);
    add(name === 'node.exe', `port ${METRO_PORT} held by ${name ?? 'unknown'} (pid ${metroPid})`, name === 'node.exe' ? undefined : 'not a stray Metro; free it manually');
    // Holding the port is not the same as serving. A Metro that answers its
    // status endpoint but cannot build still leaves the dev client hanging on
    // startup, which Android turns into an ANR rather than an error.
    add(await probeMetroStatus(), `Metro answering on port ${METRO_PORT}`, 'the port is held but Metro does not respond; restart it (npm run dev:stop, then your rig mode)');
  }

  const devices = listAdbDevices();
  const readyDevices = devices.filter((device) => device.state === 'device');
  for (const device of devices) {
    add(
      device.state === 'device',
      `device ${device.serial}${device.isEmulator ? ' (emulator)' : ''}: ${device.state}`,
      device.state === 'unauthorized' ? 'accept the USB debugging prompt on the device' : `adb reports "${device.state}"`,
    );
  }
  if (readyDevices.length > 1) {
    add(
      Boolean(requestedSerial),
      'multiple devices: an explicit target is chosen',
      `pass --serial <serial> or set ANDROID_SERIAL (attached: ${readyDevices.map((device) => device.serial).join(', ')})`,
    );
  }
  // Reverse tunnels, per device, for EVERY attached device - not just the
  // target. This is the check that matters most and the one that did not
  // exist: an adb server restart wipes every device's tunnels, a device
  // without them cannot reach Metro or the relay, and the app there hangs on
  // startup until Android ANR-kills it. The symptom ("Connecting to your
  // desktop", or the dev client reporting a crash) points nowhere near adb.
  for (const device of readyDevices) {
    const present = listAdbReverses(device.serial);
    const missing = REQUIRED_REVERSE_PORTS.filter((port) => !present.includes(port));
    add(
      missing.length === 0,
      `reverse tunnels on ${device.serial} (${REQUIRED_REVERSE_PORTS.join(', ')})`,
      `missing ${missing.join(', ')} - run: npm run dev:adb (restores every device), or adb -s ${device.serial} reverse tcp:<port> tcp:<port>`,
    );
    process.env.ANDROID_SERIAL = device.serial;
    add(devClientInstalled(), `app (${APP_PACKAGE}) installed on ${device.serial}`, 'run npx expo run:android once, or install an e2e/preview APK');
  }
  const doctorTarget = requestedSerial ?? (readyDevices.length === 1 ? readyDevices[0].serial : null);
  if (doctorTarget) process.env.ANDROID_SERIAL = doctorTarget;

  // One rig at most. Orphans from an interrupted run keep dialing the same
  // relay slot and wanting the same Metro port, which presents as a flaky app
  // rather than as a process problem.
  // npx spawns the real bundler as a child, so a single Metro shows up twice;
  // count the wrapper out or a healthy rig always looks doubled.
  const rigProcesses = findOrphanRigProcesses().filter((process) => !process.commandLine.includes('npx-cli.js'));
  const stubCount = rigProcesses.filter((process) => process.commandLine.includes('stubDesktopPeer')).length;
  const metroCount = rigProcesses.filter((process) => /expo(-cli)?.*start/.test(process.commandLine)).length;
  add(stubCount <= 1, `stub peers running: ${stubCount}`, 'more than one stub dials the same relay slot and they steal the session from each other - run: npm run dev:stop');
  add(metroCount <= 1, `Metro bundlers running: ${metroCount}`, `more than one bundler wants port ${METRO_PORT}; the loser serves nothing - run: npm run dev:stop`);

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

// ---------------------------------------------------------------------------
// Live-mode quick pair: dev-only instant pairing, no in-app ceremony.
//
// The desktop dev instance (bridge enabled) publishes its static public key
// and relay URL to its repo's gitignored .kangentic/mobile-dev-pairing/
// directory; the rig answers with a persistent dev phone PUBLIC key, which
// the desktop adopts into its signed roster with all verbs granted. The
// matching secret key rides into the app via a dev-only env var, so the
// app links instantly. Only public keys cross the repo boundary, and both
// sides compile the path out of production builds. The QR/SAS ceremony
// (dev:pair) remains untouched for testing real pairing.

const DEV_PAIRING_SUBDIR = join('.kangentic', 'mobile-dev-pairing');

async function prepareQuickPair(kangenticRepo) {
  const pairingDir = join(kangenticRepo, DEV_PAIRING_SUBDIR);
  const desktopFile = join(pairingDir, 'desktop.json');

  let desktop = null;
  const deadline = Date.now() + 15_000;
  let waitedNotice = false;
  while (Date.now() < deadline) {
    if (existsSync(desktopFile)) {
      try {
        desktop = JSON.parse(readFileSync(desktopFile, 'utf8'));
        break;
      } catch {
        // Mid-write; retry.
      }
    }
    if (!waitedNotice) {
      log(`quick pair: waiting for the desktop handshake file (${desktopFile})...`);
      waitedNotice = true;
    }
    await sleep(1000);
  }
  if (!desktop || typeof desktop.desktopStaticPublicKey !== 'string' || typeof desktop.relayUrl !== 'string') {
    warn('quick pair unavailable: no desktop handshake file appeared.');
    warn('Is your Kangentic dev instance running with the mobile bridge enabled, on a build that has dev-quick-pair?');
    warn('Falling back to manual pairing.');
    return null;
  }

  const protocol = await import('@kangentic/protocol');
  let keyPair = loadState().devPhoneKeyPair;
  if (!keyPair || typeof keyPair.secretKey !== 'string' || typeof keyPair.publicKey !== 'string') {
    const generated = protocol.generateX25519KeyPair();
    keyPair = { secretKey: protocol.bytesToHex(generated.secretKey), publicKey: protocol.bytesToHex(generated.publicKey) };
    saveState({ devPhoneKeyPair: keyPair });
    log('quick pair: generated a persistent dev phone identity');
  }
  writeFileSync(join(pairingDir, 'phone.json'), `${JSON.stringify({ phonePublicKey: keyPair.publicKey }, null, 2)}\n`);

  return `${desktop.desktopStaticPublicKey},${keyPair.secretKey},${keyPair.publicKey},${desktop.relayUrl}`;
}

async function main() {
  const { mode, flags } = parseRigArgs(process.argv.slice(2));
  const state = loadState();
  const relayRepo = resolveRelayRepo(flags, state);
  const avdName = flags.avd ?? state.avdName ?? DEFAULT_AVD;
  const requestedSerial = flags.serial ?? (process.env.ANDROID_SERIAL || null);
  const needsRelay = mode === 'live' || mode === 'pair' || mode === 'stub';

  if (mode === 'stop') {
    // Back to a known-good machine in one command. Deliberately leaves the
    // relay (spawned detached, shared with the desktop) and the emulator up:
    // both are expensive to restart and neither is what goes wrong.
    const orphans = findOrphanRigProcesses();
    if (orphans.length === 0) {
      log('no rig processes running');
    } else {
      for (const orphan of orphans) log(`stopping pid ${orphan.pid}: ${orphan.commandLine}`);
      log(`stopped ${killOrphanRigProcesses(orphans)} rig process(es)`);
    }
    log('relay and emulator left running (npm run dev:adb recovers a wedged adb server)');
    process.exit(0);
  }

  if (mode === 'doctor') {
    const failures = await doctor({ relayRepo, avdName, requestedSerial });
    log(failures === 0 ? 'all checks passed' : `${failures} check(s) need attention`);
    process.exit(failures === 0 ? 0 : 1);
  }

  if (mode === 'adb') {
    // The adb SERVER wedge: reverses look listed, sockets show established,
    // but no data flows and the phone reconnect-loops while relay and
    // desktop are healthy. The cure is a fresh adb server; the app then
    // needs a relaunch because its retry loops can stall through the
    // outage. (Windows: adb.exe must be force-killed - kill-server hangs
    // against a wedged server.)
    log('restarting the adb server (forwarding wedge recovery)...');
    spawnSync('taskkill', ['/IM', 'adb.exe', '/F'], { encoding: 'utf8' });
    await sleep(1000);
    const started = run('adb', ['start-server']);
    if (started.status !== 0) fail(`adb start-server failed: ${started.stderr?.trim() ?? ''}`);
    // USB devices take a moment to re-handshake with the fresh server.
    const enumerateDeadline = Date.now() + 15_000;
    while (listAdbDevices().every((device) => device.state !== 'device') && Date.now() < enumerateDeadline) {
      await sleep(1000);
    }
    const adbTarget = selectAdbTarget(requestedSerial);
    if (!adbTarget) fail('no ready device after the adb restart; boot the emulator (npm run dev:emu) or plug in and authorize a device');
    applyAdbTarget(adbTarget);
    // EVERY attached device, not just the selected one: the restart wiped
    // them all, and a device left without tunnels fails silently.
    restoreAllAdbReverses();
    const relaunched = spawnSync('node', [join(repoRoot, 'scripts', 'mobileInspect.mjs'), 'relaunch'], { encoding: 'utf8' });
    if (relaunched.status === 0) {
      log('app relaunched and foregrounded');
    } else {
      warn(`app relaunch failed: ${relaunched.stderr?.trim() || relaunched.stdout?.trim()}`);
    }
    process.exit(relaunched.status === 0 ? 0 : 1);
  }

  if (mode === 'emu') {
    // Emulator hygiene in one command: the qemu process degrades over long
    // sessions under sustained WebGL load (progressive lag), and the cure
    // is a fresh process. Kill, reboot, restore the reverses the reboot
    // wiped, and put the app back on screen.
    if (!commandExists('adb', ['version'])) fail('adb is not on PATH');
    if (requestedSerial && !requestedSerial.startsWith('emulator-')) {
      fail(`emu mode manages the emulator; "${requestedSerial}" is a physical device (omit --serial or pass an emulator serial)`);
    }
    log('restarting the emulator (fresh process cures long-session lag)...');
    const runningEmulator = requestedSerial ?? attachedEmulator();
    if (runningEmulator && listAdbDevices().some((device) => device.serial === runningEmulator)) {
      run('adb', ['-s', runningEmulator, 'emu', 'kill']);
      // Wait for the dying instance to actually DETACH before booting the
      // next one, or the boot races the AVD lock and the boot-completed
      // poll can bind to the corpse.
      const detachDeadline = Date.now() + 20_000;
      while (listAdbDevices().some((device) => device.serial === runningEmulator) && Date.now() < detachDeadline) {
        await sleep(1000);
      }
      await sleep(2000);
    }
    const bootedSerial = await bootEmulator(avdName, { headless: flags.headless });
    applyAdbTarget({ serial: bootedSerial, state: 'device', isEmulator: true });
    ensureAdbReverse();
    ensureInspectAdbReverse();
    const relaunch = spawnSync('node', [join(repoRoot, 'scripts', 'mobileInspect.mjs'), 'relaunch'], { encoding: 'utf8' });
    if (relaunch.status === 0) {
      log('app relaunched and foregrounded');
    } else {
      warn(`app relaunch failed: ${relaunch.stderr?.trim() || relaunch.stdout?.trim()}`);
    }
    process.exit(relaunch.status === 0 ? 0 : 1);
  }

  log(`mode: ${mode}`);
  // Clear any previous rig before starting this one. The rig used to adopt a
  // running Metro and otherwise leave everything alone, which quietly allowed
  // two MODES at once: dev:live and dev:stub each want Metro on 8081 and each
  // spawn their own peer, so the second run half-replaced the first and both
  // sets of processes stayed alive fighting over one device. Starting a rig
  // now means exactly one rig.
  const orphans = findOrphanRigProcesses();
  if (orphans.length > 0) {
    for (const orphan of orphans) log(`clearing a previous rig process (pid ${orphan.pid})`);
    killOrphanRigProcesses(orphans);
    // Killing a process mid-adb-transfer can leave the adb server wedged;
    // give it a beat, and let the health check below catch it if so.
    await sleep(1500);
  }
  if (!commandExists('adb', ['version'])) fail('adb is not on PATH');
  await ensureDevice(avdName, requestedSerial, { headless: flags.headless, wifi: flags.wifi });

  const kangenticRepo = resolveKangenticRepo(flags, state);
  // Link the sibling protocol build into node_modules; a change forces a
  // clean Metro cache so the bundler re-resolves the dependency.
  const protocolRelinked = ensureLocalProtocol(kangenticRepo, flags);
  ensureInspectAdbReverse();
  // The inspect env flag is inlined at bundle time; force one clean Metro
  // cache the first time a rig run enables it so existing bundles pick it up.
  const inspectEnvFirstEnabled = loadState().inspectEnvEnabled !== true;
  if (inspectEnvFirstEnabled) saveState({ inspectEnvEnabled: true });
  flags.clear = flags.clear || inspectEnvFirstEnabled;

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

  if (mode === 'stub') startStub(state, flags);

  if (mode === 'live') {
    const quickPairEnv = await prepareQuickPair(kangenticRepo);
    if (quickPairEnv) {
      // The env value is inlined at bundle time, so the first run (or a key
      // or relay change) needs a clean Metro cache to take effect.
      const changed = loadState().lastQuickPairEnv !== quickPairEnv;
      if (changed) saveState({ lastQuickPairEnv: quickPairEnv });
      log('quick pair: the app links to your desktop instantly - no in-app pairing needed');
      startMetro({ ...flags, clear: flags.clear || changed || protocolRelinked }, { EXPO_PUBLIC_KANGENTIC_DEV_PAIRING: quickPairEnv });
    } else {
      printLiveChecklist();
      startMetro({ ...flags, clear: flags.clear || protocolRelinked });
    }
  } else if (mode === 'mock') {
    log('mock mode: in-app fake desktop, no relay or pairing involved');
    log('(switching mock on/off later needs a Metro restart with --clear: the flag is inlined at bundle time)');
    startMetro({ ...flags, clear: flags.clear || protocolRelinked }, { EXPO_PUBLIC_KANGENTIC_MOCK: '1' });
  } else {
    startMetro({ ...flags, clear: flags.clear || protocolRelinked });
  }

  // Sharding (stub mode): boot and pair the extra instances AFTER Metro is
  // up - the pairing bootstrap flow launches the app, which needs a bundle.
  if (mode === 'stub' && flags.shard !== undefined) {
    const shardCount = Number(flags.shard);
    if (!Number.isInteger(shardCount) || shardCount < 2 || shardCount > 4) {
      fail(`--shard expects an integer 2..4, got "${flags.shard}"`);
    }
    const primarySerial = process.env.ANDROID_SERIAL;
    const extraSerials = await setupShardDevices(shardCount, avdName, flags);
    const allSerials = [primarySerial, ...extraSerials].join(',');
    log('shard devices ready. Run the batch with:');
    log(`  maestro --device "${allSerials}" test --shard-split ${shardCount} .maestro/paired`);
  }

  if (flags['no-metro'] && spawnedChildren.length === 0) {
    log('nothing left to supervise; exiting');
    process.exit(0);
  }
}

main().catch((mainError) => fail(mainError.stack ?? String(mainError)));
