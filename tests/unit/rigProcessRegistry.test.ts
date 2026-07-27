import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { decideRecordAction, parseRecordFileName, recordFileName } from '../../scripts/rigProcessRegistry.mjs';

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
    // Every taskkill/process.kill target in the rig must be a recorded child
    // (record.pid), this run's own child (child.pid), or adb.exe by image
    // name. A pid from any other source is the bug this test exists for.
    const killTargets = [...devRig.matchAll(/taskkill',\s*\[([^\]]*)\]/g)].map((match) => match[1]);
    expect(killTargets.length).toBeGreaterThan(0);
    for (const target of killTargets) {
      expect(target).toMatch(/String\((record|child)\.pid\)|'\/IM',\s*'adb\.exe'/);
    }
  });
});
