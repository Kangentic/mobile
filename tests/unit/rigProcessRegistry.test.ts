import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  adbServerClientPids,
  adbServerPort,
  decideAdbServerRestart,
  decideEmulatorAction,
  decideRecordAction,
  emulatorRecordFileName,
  parseEmulatorRecordFileName,
  parseRecordFileName,
  recordFileName,
} from '../../scripts/rigProcessRegistry.mjs';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

interface RecordIdentity {
  creationDate: string;
  commandLine: string;
}

interface RigRecord {
  label: string;
  pid: number;
  platform: string;
  identity: RecordIdentity | null;
}

const WINDOWS_RECORD: RigRecord = {
  label: 'metro',
  pid: 4242,
  platform: 'win32',
  identity: { creationDate: '/Date(1753500000000)/', commandLine: 'cmd.exe /d /s /c "npx expo start --android"' },
};

describe('decideRecordAction', () => {
  it('kills a recorded pid whose OS creation date still matches', () => {
    expect(decideRecordAction(WINDOWS_RECORD, { ...WINDOWS_RECORD.identity })).toEqual({
      action: 'kill',
      reason: 'identity matches',
    });
  });

  it('refuses to kill a pid the OS says was created at a different time', () => {
    // The whole point of the registry: pids get recycled, and the recycled
    // owner is a stranger's process.
    const recycled = { creationDate: '/Date(1753599999999)/', commandLine: 'node some-other-app.js' };
    expect(decideRecordAction(WINDOWS_RECORD, recycled)).toEqual({
      action: 'prune',
      reason: 'pid was recycled by another process',
    });
  });

  it('prunes silently when the process is already gone', () => {
    expect(decideRecordAction(WINDOWS_RECORD, null)).toEqual({ action: 'prune', reason: 'already exited' });
  });

  it('refuses to kill a Windows record whose identity was never captured', () => {
    const unverifiable: RigRecord = { ...WINDOWS_RECORD, identity: null };
    expect(decideRecordAction(unverifiable, { creationDate: '/Date(1753500000000)/', commandLine: 'anything' })).toEqual({
      action: 'prune',
      reason: 'identity was never captured, so this pid cannot be verified',
    });
  });

  it('falls back to the command line when no creation date is available', () => {
    const noDate: RigRecord = { ...WINDOWS_RECORD, identity: { creationDate: '', commandLine: 'cmd.exe /d /s /c "node scripts/stubDesktopPeer.mjs"' } };
    expect(decideRecordAction(noDate, { creationDate: '', commandLine: 'cmd.exe /d /s /c "node scripts/stubDesktopPeer.mjs"' }).action).toBe('kill');
    expect(decideRecordAction(noDate, { creationDate: '', commandLine: 'node totally-unrelated.js' }).action).toBe('prune');
  });

  it('prunes an unreadable or malformed record instead of guessing', () => {
    expect(decideRecordAction(null, { creationDate: 'x', commandLine: 'y' }).action).toBe('prune');
    expect(decideRecordAction({ pid: 0 }, { creationDate: 'x', commandLine: 'y' }).action).toBe('prune');
    expect(decideRecordAction({ pid: -1 }, { creationDate: 'x', commandLine: 'y' }).action).toBe('prune');
    expect(decideRecordAction({ pid: 1.5 }, { creationDate: 'x', commandLine: 'y' }).action).toBe('prune');
  });

  it('allows a liveness-only kill off Windows, where no identity is expected', () => {
    const posix: RigRecord = { label: 'metro', pid: 4242, platform: 'linux', identity: null };
    expect(decideRecordAction(posix, { creationDate: '', commandLine: '' }).action).toBe('kill');
    expect(decideRecordAction(posix, null).action).toBe('prune');
  });
});

describe('decideEmulatorAction', () => {
  const booted = { serial: 'emulator-5554', avdName: 'kangentic_pixel' };

  it('kills a serial still running the AVD the rig booted', () => {
    const decision = decideEmulatorAction(booted, { attached: true, avdName: 'kangentic_pixel' });
    expect(decision.action).toBe('kill');
  });

  it('leaves a serial now running a DIFFERENT AVD', () => {
    // A serial is a slot, not an identity: emulator-5554 is simply the first
    // one, so the next emulator to boot inherits it. Killing on serial alone
    // would shut down whatever happened to take the slot.
    const decision = decideEmulatorAction(booted, { attached: true, avdName: 'some_other_avd' });
    expect(decision.action).toBe('prune');
    expect(decision.reason).toContain('some_other_avd');
  });

  it('prunes a serial that is no longer attached', () => {
    expect(decideEmulatorAction(booted, { attached: false, avdName: null }).action).toBe('prune');
  });

  it('leaves an emulator whose console will not name its AVD', () => {
    // Unverifiable is not a kill target, matching the process rule. A wedged
    // emulator is exactly when the console stops answering, and that is also
    // exactly when we are least sure whose it is.
    expect(decideEmulatorAction(booted, { attached: true, avdName: null }).action).toBe('prune');
  });

  it('prunes a record that never captured an AVD name', () => {
    expect(decideEmulatorAction({ serial: 'emulator-5554' }, { attached: true, avdName: 'kangentic_pixel' }).action).toBe(
      'prune',
    );
  });

  it('prunes an unreadable record', () => {
    expect(decideEmulatorAction(null, { attached: true, avdName: 'kangentic_pixel' }).action).toBe('prune');
    expect(decideEmulatorAction({ serial: '' }, { attached: true, avdName: 'x' }).action).toBe('prune');
  });

  it('never kills on a missing live reading', () => {
    expect(decideEmulatorAction(booted, null).action).toBe('prune');
    expect(decideEmulatorAction(booted, undefined).action).toBe('prune');
  });
});

describe('emulator record file names', () => {
  it('round-trips a serial', () => {
    const parsed = parseEmulatorRecordFileName(emulatorRecordFileName('emulator-5554'));
    expect(parsed).toEqual({ serial: 'emulator-5554' });
  });

  it('ignores a process record', () => {
    expect(parseEmulatorRecordFileName(recordFileName('metro', 1234))).toBeNull();
  });

  it('is NOT readable as a process record', () => {
    // The two registries share one directory, and this is not hypothetical:
    // `devrig-emulator-emulator-5554.json` parses as label "emulator-emulator",
    // pid 5554. Since the process stop runs first and prunes records it cannot
    // verify, an unguarded parser DELETES the emulator record every run and the
    // tracking silently evaporates - which is exactly the bug the emulator stop
    // was written to fix.
    //
    // Asserting the label is not "emulator" (an earlier version of this test)
    // passes against that bug, because the label came out "emulator-emulator".
    // The property that matters is that it does not parse at all.
    expect(parseRecordFileName(emulatorRecordFileName('emulator-5554'))).toBeNull();
    expect(parseRecordFileName(emulatorRecordFileName('emulator-5556'))).toBeNull();
  });
});

describe('record file names', () => {
  it('round-trips a label and pid', () => {
    expect(parseRecordFileName(recordFileName('metro', 1234))).toEqual({ label: 'metro', pid: 1234 });
    // Sharded stubs carry an index, so the label itself contains digits.
    expect(parseRecordFileName(recordFileName('stub2', 99))).toEqual({ label: 'stub2', pid: 99 });
  });

  it('ignores anything that is not a record', () => {
    expect(parseRecordFileName('notes.txt')).toBeNull();
    expect(parseRecordFileName('devrig-metro.json')).toBeNull();
    expect(parseRecordFileName('devrig-metro-abc.json')).toBeNull();
    expect(parseRecordFileName('devrig--12.json')).toBeNull();
  });
});

/**
 * The incident this whole module exists for: `dev:stop` used to select kill
 * targets by matching Win32_Process command lines, and killed a developer's
 * running Kangentic desktop plus every agent session under it. A static scan
 * is the right enforcement because the failure is a REINTRODUCED pattern, not
 * a wrong value - no runtime test can catch someone adding a second scan.
 */
describe('scripts/dev.mjs never derives a kill target from a command line', () => {
  const devRig = readFileSync(join(scriptsDir, 'dev.mjs'), 'utf8');

  it('is scanning a file that still contains the kill paths (non-vacuity guard)', () => {
    expect(devRig).toContain('taskkill');
    expect(devRig).toContain('stopRecordedProcesses');
  });

  it('does not query the process table by command line', () => {
    expect(devRig).not.toMatch(/CommandLine\s+-match/i);
    expect(devRig).not.toMatch(/Win32_Process[^\n]*Name\s*=\s*'node\.exe'/i);
  });

  it('kills only pids that came from the registry', () => {
    // Every taskkill target must be a recorded child (record.pid) or this
    // run's own child (child.pid). A pid from any other source is the bug this
    // test exists for.
    //
    // ONE deliberate exemption: `taskkill /IM adb.exe /F` in `adb` mode. adb
    // is a single shared server by design - one process the whole machine
    // talks to - so there is no "ours" to record, and `adb kill-server` hangs
    // against the wedged server that mode exists to recover. It is kill-by-
    // name, and it is allowed because the target is a named singleton service,
    // not a guess about which of many processes might be ours. Because it
    // takes EVERY adb process, it sits behind a guard that refuses while
    // another process is connected to the server (asserted below).
    const killTargets = [...devRig.matchAll(/taskkill',\s*\[([^\]]*)\]/g)].map((match) => match[1]);
    expect(killTargets.length).toBeGreaterThan(0);
    for (const target of killTargets) {
      expect(target).toMatch(/String\((record|child)\.pid\)|'\/IM',\s*'adb\.exe'/);
    }
  });
});

/**
 * `netstat -ano` as Windows prints it (CRLF, padded columns). Loopback lists
 * each connection twice, once from each end, so the server's own side has to
 * be told apart from its clients'.
 */
const NETSTAT_WITH_ADB_CLIENTS = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
  '  TCP    127.0.0.1:5037         0.0.0.0:0              LISTENING       15116',
  // A logcat: the client's end, then the server's end of the same socket.
  '  TCP    127.0.0.1:61001        127.0.0.1:5037         ESTABLISHED     4412',
  '  TCP    127.0.0.1:5037         127.0.0.1:61001        ESTABLISHED     15116',
  // The same client holding a second connection is still one client.
  '  TCP    127.0.0.1:61005        127.0.0.1:5037         ESTABLISHED     4412',
  // Finished short commands linger as pid-0 TIME_WAIT rows.
  '  TCP    127.0.0.1:5037         127.0.0.1:60844        TIME_WAIT       0',
  '  TCP    127.0.0.1:60845        127.0.0.1:5037         TIME_WAIT       0',
  // A client mid-close is not an in-flight command.
  '  TCP    127.0.0.1:61003        127.0.0.1:5037         CLOSE_WAIT      5555',
  // Port 50370 is not port 5037.
  '  TCP    127.0.0.1:61002        127.0.0.1:50370        ESTABLISHED     3333',
  '  TCP    [::1]:61004            [::1]:5037             ESTABLISHED     7777',
  '  UDP    0.0.0.0:5037           *:*                                    9999',
  '',
].join('\r\n');

describe('adbServerClientPids', () => {
  it('finds the processes connected to the adb server, not the server itself', () => {
    expect(adbServerClientPids(NETSTAT_WITH_ADB_CLIENTS)).toEqual([4412, 7777]);
  });

  it('finds nothing when only the server and finished commands are left', () => {
    const idle = [
      '  TCP    127.0.0.1:5037         0.0.0.0:0              LISTENING       15116',
      '  TCP    127.0.0.1:5037         127.0.0.1:60844        TIME_WAIT       0',
    ].join('\r\n');
    expect(adbServerClientPids(idle)).toEqual([]);
  });

  it('tolerates empty or missing output', () => {
    expect(adbServerClientPids('')).toEqual([]);
    expect(adbServerClientPids(undefined)).toEqual([]);
  });

  it('watches the port the server actually moved to', () => {
    const movedServer = [
      '  TCP    127.0.0.1:5038         0.0.0.0:0              LISTENING       15116',
      '  TCP    127.0.0.1:61001        127.0.0.1:5038         ESTABLISHED     4412',
    ].join('\r\n');
    expect(adbServerClientPids(movedServer, { port: 5038 })).toEqual([4412]);
    expect(adbServerClientPids(movedServer)).toEqual([]);
  });
});

describe('adbServerPort', () => {
  it('follows ANDROID_ADB_SERVER_PORT, and falls back to 5037', () => {
    expect(adbServerPort({ ANDROID_ADB_SERVER_PORT: '5038' })).toBe(5038);
    expect(adbServerPort({})).toBe(5037);
    expect(adbServerPort({ ANDROID_ADB_SERVER_PORT: 'not-a-port' })).toBe(5037);
  });
});

describe('decideAdbServerRestart', () => {
  it('restarts when nothing else is connected', () => {
    expect(decideAdbServerRestart([]).allowed).toBe(true);
  });

  it('refuses while another process is connected, and says how many', () => {
    const decision = decideAdbServerRestart([4412, 7777]);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('2 other process(es)');
  });

  it('refuses when the clients cannot be listed', () => {
    expect(decideAdbServerRestart(null).allowed).toBe(false);
  });

  it('restarts anyway under --force, whatever is connected', () => {
    expect(decideAdbServerRestart([4412], { force: true }).allowed).toBe(true);
    expect(decideAdbServerRestart(null, { force: true }).allowed).toBe(true);
    expect(decideAdbServerRestart([], { force: true }).allowed).toBe(true);
  });
});

/**
 * Kangentic's Done reap stops every process that carries the task's tag and
 * works inside the task's project or worktree. The emulator inherits the
 * rig's working directory, and the adb server keeps the working directory of
 * whichever client started it, so both must start from the home folder. A
 * static scan, like the one above, because the failure is a REINTRODUCED
 * spawn without the cwd, and dev.mjs runs main() on import.
 */
describe('the adb server and the emulator never start inside a task worktree', () => {
  const devRig = readFileSync(join(scriptsDir, 'dev.mjs'), 'utf8');

  it('runs every rig adb call from the home folder', () => {
    const runStart = devRig.indexOf('function run(command, args');
    expect(runStart).toBeGreaterThanOrEqual(0);
    const runDefinition = devRig.slice(runStart, devRig.indexOf('\n}\n', runStart));
    expect(runDefinition).toMatch(/cwd: homedir\(\),\s*\.\.\.options/);
    // run() is the only way the rig reaches adb: a direct spawn skips its cwd.
    expect(devRig).toMatch(/run\('adb'/);
    expect(devRig).not.toMatch(/(?:spawnSync|execFileSync|spawn)\(\s*'adb'/);
  });

  it('hands run() no repo-relative path, since run() works from the home folder', () => {
    // A relative argument resolves against the home folder, not this checkout:
    // the stub rig's pairing bootstrap handed Maestro `.maestro/setup/...` and
    // Maestro looked for the flow under the home folder instead.
    const runCalls = [...devRig.matchAll(/\brun\('([^']+)',\s*\[([^\]]*)\]/g)].map((match) => ({
      command: match[1],
      runArguments: match[2],
    }));
    // Non-vacuity: the scan must reach the one call that takes a flow file.
    expect(runCalls.some((runCall) => runCall.command === 'maestro')).toBe(true);
    for (const { runArguments } of runCalls) {
      expect(runArguments).not.toMatch(/['`](?:\.{1,2}\/|\.maestro\/|scripts\/|node_modules\/)/);
    }
  });

  it('boots the emulator from the home folder', () => {
    const emulatorSpawn = devRig.match(/spawn\('emulator', emulatorArgs, \{[^}]*\}/)?.[0];
    expect(emulatorSpawn).toBeDefined();
    expect(emulatorSpawn).toContain('cwd: homedir()');
  });

  it('starts the adb server before any mode reaches adb', () => {
    const mainStart = devRig.indexOf('async function main()');
    const startIndex = devRig.indexOf('startAdbServer();', mainStart);
    expect(startIndex).toBeGreaterThan(mainStart);
    expect(startIndex).toBeLessThan(devRig.indexOf("if (mode === 'stop')", mainStart));
  });

  it('guards the adb-mode restart before its force-kill', () => {
    const adbModeStart = devRig.indexOf("if (mode === 'adb') {");
    const killIndex = devRig.indexOf("spawnSync('taskkill', ['/IM', 'adb.exe', '/F']", adbModeStart);
    expect(adbModeStart).toBeGreaterThanOrEqual(0);
    expect(killIndex).toBeGreaterThan(adbModeStart);
    for (const step of ['decideAdbServerRestart(', "if (flags['dry-run'])", 'if (!decision.allowed)']) {
      const stepIndex = devRig.indexOf(step, adbModeStart);
      expect(stepIndex, step).toBeGreaterThan(adbModeStart);
      expect(stepIndex, step).toBeLessThan(killIndex);
    }
  });

  it.each(['mobileInspect.mjs', 'storeScreenshots.mjs', 'webviewEval.mjs'])('%s runs adb from the home folder', (fileName) => {
    const source = readFileSync(join(scriptsDir, fileName), 'utf8');
    const callSites = [...source.matchAll(/(?:spawnSync|execFileSync|spawn)\(\s*'adb',/g)];
    expect(callSites.length).toBeGreaterThan(0);
    for (const site of callSites) {
      const siteIndex = site.index ?? 0;
      expect(source.slice(siteIndex, source.indexOf(';', siteIndex))).toContain('cwd: homedir()');
    }
  });

  it("mobileInspect's automatic recovery never restarts the server past another client", () => {
    const inspect = readFileSync(join(scriptsDir, 'mobileInspect.mjs'), 'utf8');
    const recoveryStart = inspect.indexOf('function recoverAdbServer()');
    expect(recoveryStart).toBeGreaterThanOrEqual(0);
    const guardIndex = inspect.indexOf('if (!decision.allowed)', recoveryStart);
    const killServerIndex = inspect.indexOf("['kill-server']", recoveryStart);
    expect(guardIndex).toBeGreaterThan(recoveryStart);
    expect(killServerIndex).toBeGreaterThan(guardIndex);
    // An exact process name, never a command-line pattern.
    expect(inspect).not.toMatch(/\['-f',\s*'adb'\]/);
  });
});
