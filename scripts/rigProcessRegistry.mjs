/**
 * The dev rig's process registry: the ONLY source of kill targets.
 *
 * The rig used to find its leftovers by scanning every node.exe on the machine
 * and matching command lines against 'dev\.mjs|stubDesktopPeer|expo(-cli)?.*start'.
 * That kills by resemblance, and the resemblance is far wider than it looks:
 * `expo(-cli)?.*start` matches '--expose-gc ... start', and even
 * '--expose-internals ... --restart' (the "start" inside "--restart"). It took
 * out a developer's running Kangentic desktop and every agent session under it,
 * twice, and no amount of tightening the pattern makes guess-by-name sound.
 *
 * So the rig records what it spawns instead: one file per child, written
 * synchronously at spawn time (the orphan case exists BECAUSE runs get
 * interrupted, so a record written after an await does not survive the case it
 * is for), and stop reads only those files.
 *
 * A persisted pid is a loaded gun on its own - Windows recycles pids, and a
 * record can be hours old - so every record carries the identity the OS
 * reported for that pid just after spawn, and nothing is killed unless the
 * identity still matches. Mismatch, missing, or unreadable prunes the record
 * and kills nothing. Never killing a stranger is worth occasionally failing to
 * reap our own.
 *
 * The decision step is pure and lives here so tests can drive every branch
 * without spawning anything or importing the rig.
 */

const RECORD_PREFIX = 'devrig-';
const RECORD_SUFFIX = '.json';
/** Declared here because parseRecordFileName has to exclude it - see below. */
const EMULATOR_PREFIX = 'devrig-emulator-';

/** A record filename encodes label and pid so stop needs no index file. */
export function recordFileName(label, pid) {
  return `${RECORD_PREFIX}${label}-${pid}${RECORD_SUFFIX}`;
}

/**
 * One file per child rather than one shared JSON array: two rigs running at
 * once cannot lose each other's entries to a read-modify-write race, and a
 * half-written file costs one record instead of the whole registry.
 */
export function parseRecordFileName(fileName) {
  if (!fileName.startsWith(RECORD_PREFIX) || !fileName.endsWith(RECORD_SUFFIX)) return null;
  // Both registries share one directory, and an emulator record's name parses
  // cleanly as a process record: `devrig-emulator-emulator-5554.json` reads as
  // label "emulator-emulator", pid 5554. Left unguarded the process stop - which
  // runs first - treats it as a stale record and DELETES it, so the emulator
  // stop that follows finds nothing and the tracking silently evaporates.
  if (fileName.startsWith(EMULATOR_PREFIX)) return null;
  const middle = fileName.slice(RECORD_PREFIX.length, -RECORD_SUFFIX.length);
  const separator = middle.lastIndexOf('-');
  if (separator <= 0) return null;
  const label = middle.slice(0, separator);
  const pid = Number(middle.slice(separator + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { label, pid };
}

/**
 * Decide what to do with one registry record.
 *
 * `liveIdentity` is what the OS reports for that pid RIGHT NOW: null when no
 * such process exists, otherwise { creationDate, commandLine } with either
 * field possibly empty when it could not be read.
 *
 * Returns 'kill' only when the running process is provably the one we started.
 * Everything else is 'prune': drop the stale record, touch no process.
 */
export function decideRecordAction(record, liveIdentity) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0) {
    return { action: 'prune', reason: 'unreadable record' };
  }
  if (liveIdentity === null || liveIdentity === undefined) {
    return { action: 'prune', reason: 'already exited' };
  }

  const recorded = record.identity;
  if (!recorded) {
    // No identity was captured at spawn time. On Windows that is a capture
    // failure and the pid is unverifiable, so it is not a kill target. On
    // POSIX pids are not recycled aggressively and no identity is expected,
    // so liveness is the check.
    return record.platform === 'win32'
      ? { action: 'prune', reason: 'identity was never captured, so this pid cannot be verified' }
      : { action: 'kill', reason: 'running (liveness only)' };
  }

  // Creation date is the strongest signal: it is assigned by the OS and cannot
  // be reproduced by a recycled pid.
  if (recorded.creationDate && liveIdentity.creationDate) {
    return recorded.creationDate === liveIdentity.creationDate
      ? { action: 'kill', reason: 'identity matches' }
      : { action: 'prune', reason: 'pid was recycled by another process' };
  }

  // Fall back to the command line the OS reported (not the string we passed:
  // a shell child's real line is `cmd.exe /d /s /c "..."`).
  if (recorded.commandLine && liveIdentity.commandLine) {
    return recorded.commandLine === liveIdentity.commandLine
      ? { action: 'kill', reason: 'command line matches' }
      : { action: 'prune', reason: 'pid was recycled by another process' };
  }

  return { action: 'prune', reason: 'identity could not be compared' };
}

// ---------------------------------------------------------------------------
// Emulators
// ---------------------------------------------------------------------------

/**
 * An emulator is tracked by SERIAL, not pid.
 *
 * `emulator.exe` is a launcher: it hands off to a qemu child and the pid the
 * rig spawned is not reliably the process that owns the window, so the pid
 * identity check the rest of this file relies on cannot be applied. The serial
 * can, and it has a graceful, targeted shutdown that needs no pid at all:
 * `adb -s <serial> emu kill` speaks to that one instance's console.
 *
 * The ownership question still has to be answered, because a serial is a SLOT
 * (emulator-5554 is simply the first one) and the next emulator to boot inherits
 * it. So the record carries the AVD name, and stop re-reads the live AVD name
 * off the console before killing anything. An emulator the rig ADOPTED - one
 * already running when the rig started - is never recorded, so it is never a
 * target.
 */
export function emulatorRecordFileName(serial) {
  return `${EMULATOR_PREFIX}${serial}${RECORD_SUFFIX}`;
}

export function parseEmulatorRecordFileName(fileName) {
  if (!fileName.startsWith(EMULATOR_PREFIX) || !fileName.endsWith(RECORD_SUFFIX)) return null;
  const serial = fileName.slice(EMULATOR_PREFIX.length, -RECORD_SUFFIX.length);
  return serial.length > 0 ? { serial } : null;
}

/**
 * Decide what to do with one emulator record.
 *
 * `live` is what adb reports for that serial RIGHT NOW:
 * `{ attached: boolean, avdName: string | null }`, where a null avdName means
 * the console did not answer.
 *
 * Returns 'kill' only when the serial is still attached AND still running the
 * AVD the rig booted. Anything unverifiable prunes, same as for processes:
 * shutting down a stranger's emulator is a smaller harm than killing their
 * editor, but it is the same mistake and the same rule applies.
 */
export function decideEmulatorAction(record, live) {
  if (!record || typeof record.serial !== 'string' || record.serial.length === 0) {
    return { action: 'prune', reason: 'unreadable record' };
  }
  if (!live || live.attached !== true) {
    return { action: 'prune', reason: 'already gone' };
  }
  if (typeof record.avdName !== 'string' || record.avdName.length === 0) {
    return { action: 'prune', reason: 'no AVD name was recorded, so this serial cannot be verified' };
  }
  if (typeof live.avdName !== 'string' || live.avdName.length === 0) {
    return { action: 'prune', reason: 'the emulator console did not report an AVD name, so it cannot be verified' };
  }
  return live.avdName === record.avdName
    ? { action: 'kill', reason: 'serial still runs the AVD the rig booted' }
    : { action: 'prune', reason: `serial now runs a different AVD (${live.avdName})` };
}

// ---------------------------------------------------------------------------
// The adb server
// ---------------------------------------------------------------------------

/** The port every adb client on the machine talks to the one adb server on. */
export const ADB_SERVER_PORT = 5037;

/**
 * The port adb actually uses: ANDROID_ADB_SERVER_PORT moves the server, and a
 * guard watching 5037 while the server sits elsewhere would see no clients and
 * wave through a kill that takes every one of them.
 */
export function adbServerPort(environment = {}) {
  const configured = Number(environment.ANDROID_ADB_SERVER_PORT);
  return Number.isInteger(configured) && configured > 0 ? configured : ADB_SERVER_PORT;
}

/** The port at the end of a netstat address: `127.0.0.1:5037`, `[::1]:5037`. */
function addressPort(address) {
  const match = address.match(/:(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * The pids of the processes connected to the adb server right now, read from
 * `netstat -ano` text (Windows column order: proto, local, foreign, state, pid).
 *
 * The adb server is a machine-wide singleton, and restarting it is a
 * `taskkill /IM adb.exe /F`: every adb process on the machine dies, and every
 * other task's in-flight command (a logcat, an install, a Maestro run) fails
 * with "daemon not running". So before a restart the rig asks who is connected.
 *
 * A client holds an ESTABLISHED connection whose FOREIGN end is port 5037.
 * Loopback lists each connection twice, but the server's own row has 5037 as
 * its LOCAL end and the client's port as its foreign end, so it never matches.
 * A running emulator holds no such connection (measured on Windows: its qemu
 * process had none while the server tracked it), so an emulator never reads as
 * a client.
 *
 * This reads the port to REPORT and to REFUSE, never to choose a kill target:
 * the target stays the named singleton, and these pids are only printed.
 * State names are English, the same assumption findPortListenerPid makes.
 */
export function adbServerClientPids(netstatText, { port = ADB_SERVER_PORT } = {}) {
  const clientPids = new Set();
  for (const line of String(netstatText ?? '').split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== 'TCP' || columns.length < 5) continue;
    if (columns[3] !== 'ESTABLISHED' || addressPort(columns[2]) !== port) continue;
    const pid = Number(columns[4]);
    if (Number.isInteger(pid) && pid > 0) clientPids.add(pid);
  }
  return [...clientPids].sort((first, second) => first - second);
}

/**
 * May the adb server be restarted now?
 *
 * `clientPids` is what adbServerClientPids found, or null when the clients
 * could not be listed at all. Unknown is treated like "someone is connected":
 * the cost of refusing is one re-run with --force, the cost of guessing wrong
 * is every other task's adb command.
 */
export function decideAdbServerRestart(clientPids, { force = false } = {}) {
  if (clientPids === null || clientPids === undefined) {
    return force
      ? { allowed: true, reason: '--force: restarting without knowing who is connected' }
      : { allowed: false, reason: 'could not list the processes connected to the adb server' };
  }
  if (clientPids.length > 0) {
    return force
      ? { allowed: true, reason: `--force: restarting under ${clientPids.length} connected client(s)` }
      : { allowed: false, reason: `${clientPids.length} other process(es) are connected to the adb server` };
  }
  return { allowed: true, reason: 'nothing else is connected to the adb server' };
}
