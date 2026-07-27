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
