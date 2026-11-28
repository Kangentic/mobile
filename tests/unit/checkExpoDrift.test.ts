/**
 * scripts/checkExpoDrift.mjs decides, from one run of `npx expo install --check --json`,
 * whether main is behind Expo's live SDK version list, and what to do with the one
 * public drift issue. The decision that matters most is the one that does NOTHING: an
 * Expo outage must neither close a real drift issue nor open a false one.
 *
 * The drift fixture is RECORDED: the stdout and stderr of the online check on a fresh
 * `npm ci` of origin/main at 79c362b, 2026-11-28, the day Expo moved SDK 58 to
 * expo ~58.1.0. The stderr lines are what npm printed on that machine.
 *
 * Tier: Unit.
 */
import { describe, expect, it } from 'vitest';

import {
  classifyCheck,
  DEGRADED_MARKERS,
  driftIssueBody,
  exitCodeFor,
  mayWriteIssue,
  planIssueAction,
  summaryText,
  tableCell,
} from '../../scripts/checkExpoDrift.mjs';

const RECORDED_DRIFT_STDOUT = `{
  "dependencies": [
    {
      "packageName": "expo",
      "packageType": "dependencies",
      "expectedVersionOrRange": "~58.1.0",
      "actualVersion": "58.0.26"
    },
    {
      "packageName": "expo-dev-client",
      "packageType": "dependencies",
      "expectedVersionOrRange": "~58.0.22",
      "actualVersion": "58.0.21"
    },
    {
      "packageName": "expo-notifications",
      "packageType": "dependencies",
      "expectedVersionOrRange": "~58.1.10",
      "actualVersion": "58.1.9"
    },
    {
      "packageName": "expo-router",
      "packageType": "dependencies",
      "expectedVersionOrRange": "~58.0.33",
      "actualVersion": "58.0.32"
    },
    {
      "packageName": "expo-splash-screen",
      "packageType": "dependencies",
      "expectedVersionOrRange": "~58.0.15",
      "actualVersion": "58.0.14"
    },
    {
      "packageName": "jest-expo",
      "packageType": "devDependencies",
      "expectedVersionOrRange": "~58.0.16",
      "actualVersion": "58.0.15"
    }
  ],
  "upToDate": false
}
`;
const RECORDED_STDERR = 'npm notice run @kangentic/mobile@0.1.0 npx\nnpm notice run expo install --check --json\n';
// The CLI's json-mode answer when nothing is behind (install/checkPackages.js).
const CURRENT_STDOUT = '{"dependencies":[],"upToDate":true}\n';
const RUN_URL = 'https://github.com/Kangentic/mobile/actions/runs/1';

describe('classifyCheck', () => {
  it('reads the recorded drift as drift, with every package', () => {
    const result = classifyCheck({ stdout: RECORDED_DRIFT_STDOUT, stderr: RECORDED_STDERR, exitCode: 1 });
    expect(result.status).toBe('drift');
    expect(result.status === 'drift' ? result.dependencies.map((dependency) => dependency.packageName) : []).toEqual([
      'expo',
      'expo-dev-client',
      'expo-notifications',
      'expo-router',
      'expo-splash-screen',
      'jest-expo',
    ]);
  });

  it('reads an up-to-date answer with exit 0 as current', () => {
    expect(classifyCheck({ stdout: CURRENT_STDOUT, stderr: RECORDED_STDERR, exitCode: 0 })).toEqual({ status: 'current' });
  });

  it('tolerates a line printed ahead of the JSON', () => {
    const result = classifyCheck({ stdout: `npm notice something\n${CURRENT_STDOUT}`, stderr: '', exitCode: 0 });
    expect(result).toEqual({ status: 'current' });
  });

  it('calls a run that fell back to the local list degraded, even when it reads green', () => {
    // getVersionedNativeModulesAsync falls back to expo/bundledNativeModules.json with
    // only a warning when Expo cannot be reached, so its "up to date" proves nothing.
    const fallbackWarning = 'Unable to reach well-known versions endpoint. Using local dependency map expo/bundledNativeModules.json for version validation';
    for (const stdout of [CURRENT_STDOUT, RECORDED_DRIFT_STDOUT]) {
      expect(classifyCheck({ stdout, stderr: fallbackWarning, exitCode: 0 }).status).toBe('degraded');
    }
    expect(classifyCheck({ stdout: CURRENT_STDOUT, stderr: 'Dependency validation is unreliable in offline-mode', exitCode: 0 }).status).toBe(
      'degraded'
    );
    expect(DEGRADED_MARKERS.length).toBeGreaterThan(0);
  });

  it('calls a run with no JSON an error, never current', () => {
    const crash = classifyCheck({ stdout: '', stderr: 'CommandError: fetch failed', exitCode: 1 });
    expect(crash.status).toBe('error');
    expect(classifyCheck({ stdout: '{ not json', stderr: '', exitCode: 1 }).status).toBe('error');
    expect(classifyCheck({ stdout: '{"something":"else"}', stderr: '', exitCode: 0 }).status).toBe('error');
  });

  it('calls an inconsistent answer an error', () => {
    // up to date but exiting 1, or "not up to date" with nothing listed
    expect(classifyCheck({ stdout: CURRENT_STDOUT, stderr: '', exitCode: 1 }).status).toBe('error');
    expect(classifyCheck({ stdout: '{"dependencies":[],"upToDate":false}', stderr: '', exitCode: 1 }).status).toBe('error');
  });

  it('calls upToDate with listed dependencies an error, whatever the exit code', () => {
    const stdout =
      '{"dependencies":[{"packageName":"expo","expectedVersionOrRange":"~58.1.0","actualVersion":"58.0.26"}],"upToDate":true}';
    for (const exitCode of [0, 1]) {
      expect(classifyCheck({ stdout, stderr: '', exitCode }).status).toBe('error');
    }
  });

  it('rejects a dependency entry with no versions', () => {
    const stdout = '{"dependencies":[{"packageName":"expo"}],"upToDate":false}';
    expect(classifyCheck({ stdout, stderr: '', exitCode: 1 }).status).toBe('error');
  });
});

describe('driftIssueBody', () => {
  const recorded = classifyCheck({ stdout: RECORDED_DRIFT_STDOUT, stderr: '', exitCode: 1 });
  const dependencies = recorded.status === 'drift' ? recorded.dependencies : [];
  const body = driftIssueBody({ dependencies, runUrl: RUN_URL });

  it('holds one table row per package, with names and versions', () => {
    expect(body).toContain('| Package | main has | Expo expects |');
    expect(body).toContain('| `expo` | `58.0.26` | `~58.1.0` |');
    expect(body).toContain('| `jest-expo` | `58.0.15` | `~58.0.16` |');
    expect(body.split('\n').filter((line) => line.startsWith('| `'))).toHaveLength(6);
  });

  it('links the run and names the fix command, in a fresh worktree off origin/main', () => {
    expect(body).toContain(`[this run](${RUN_URL})`);
    expect(body).toContain('node scripts/fixExpoDrift.mjs');
    expect(body).toContain('git worktree add --detach <a folder outside the main checkout> origin/main');
    expect(body).toContain('npm ci');
  });

  it('sorts the rows by package name whatever order the CLI listed them in', () => {
    const reversedBody = driftIssueBody({ dependencies: [...dependencies].reverse(), runUrl: RUN_URL });
    const packageNames = reversedBody
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => line.split('`')[1]);
    expect(packageNames).toEqual([...dependencies.map((dependency) => dependency.packageName)].sort());
    expect(packageNames[0]).toBe('expo');
    expect(packageNames[5]).toBe('jest-expo');
  });

  it('says the scheduled check found it, with no link, when there is no run URL', () => {
    const bodyWithoutRun = driftIssueBody({ dependencies, runUrl: '' });
    expect(bodyWithoutRun).toContain('Found by the scheduled check');
    expect(bodyWithoutRun).not.toContain('[this run]');
  });

  it('carries nothing a run could leak: no package type, no stderr, no paths', () => {
    // The issue is public. packageType is not a name or a version, so it stays out.
    expect(body).not.toContain('devDependencies');
    expect(body).not.toContain('npm notice');
    expect(body).not.toMatch(/[A-Z]:\\|\/Users\/|\/home\//);
  });
});

describe('tableCell', () => {
  it('escapes a range pipe and drops a backtick, so a cell cannot break the table or its code span', () => {
    expect(tableCell('^1 || ^2')).toBe('`^1 \\|\\| ^2`');
    expect(tableCell('a`b')).toBe('`ab`');
  });
});

describe('planIssueAction', () => {
  it('creates the issue on drift when none is open', () => {
    expect(planIssueAction('drift', [])).toEqual({ kind: 'create' });
  });

  it('rewrites the oldest open issue on drift rather than opening a second', () => {
    expect(planIssueAction('drift', [212, 180])).toEqual({ kind: 'update', issueNumber: 180 });
  });

  it('closes every open drift issue once main is current', () => {
    expect(planIssueAction('current', [212, 180])).toEqual({ kind: 'close', issueNumbers: [180, 212] });
  });

  it('does nothing when main is current and no issue is open', () => {
    expect(planIssueAction('current', [])).toEqual({ kind: 'none' });
  });

  it('never touches the issue on a degraded or failed run', () => {
    for (const status of ['degraded', 'error'] as const) {
      expect(planIssueAction(status, [])).toEqual({ kind: 'none' });
      expect(planIssueAction(status, [180])).toEqual({ kind: 'none' });
    }
  });
});

describe('summaryText', () => {
  it('states an outcome for every status', () => {
    expect(summaryText({ status: 'current' })).toContain('current');
    expect(summaryText({ status: 'error', reason: 'no JSON on stdout (exit code 1)' })).toContain('not checked');
    const recorded = classifyCheck({ stdout: RECORDED_DRIFT_STDOUT, stderr: '', exitCode: 1 });
    expect(summaryText(recorded)).toContain('behind on 6 package(s)');
  });

  it('lists each drifted package on its own line, sorted by name', () => {
    const recorded = classifyCheck({ stdout: RECORDED_DRIFT_STDOUT, stderr: '', exitCode: 1 });
    const dependencies = recorded.status === 'drift' ? recorded.dependencies : [];
    const text = summaryText({ status: 'drift', dependencies: [...dependencies].reverse() });
    expect(text).toContain('- `expo` `58.0.26`, expects `~58.1.0`');
    const packageNames = text
      .split('\n')
      .filter((line) => line.startsWith('- `'))
      .map((line) => line.split('`')[1]);
    expect(packageNames).toEqual(dependencies.map((dependency) => dependency.packageName));
  });

  it('says a degraded run was not checked, and why', () => {
    const text = summaryText({ status: 'degraded', reason: 'the CLI fell back to the local list' });
    expect(text).toContain('not checked');
    expect(text).toContain('the CLI fell back to the local list');
  });
});

describe('exitCodeFor', () => {
  it('passes only for current, so the failed scheduled run is the drift notification', () => {
    expect(exitCodeFor('current')).toBe(0);
    for (const status of ['drift', 'degraded', 'error'] as const) {
      expect(exitCodeFor(status)).toBe(1);
    }
  });
});

describe('mayWriteIssue', () => {
  it('writes only on a definite answer, and only where WRITE_ISSUE is exactly the string true', () => {
    expect(mayWriteIssue('drift', 'true')).toBe(true);
    expect(mayWriteIssue('current', 'true')).toBe(true);
    expect(mayWriteIssue('degraded', 'true')).toBe(false);
    expect(mayWriteIssue('error', 'true')).toBe(false);
    expect(mayWriteIssue('drift', undefined)).toBe(false);
    expect(mayWriteIssue('drift', 'false')).toBe(false);
    expect(mayWriteIssue('drift', '1')).toBe(false);
    expect(mayWriteIssue('current', 'TRUE')).toBe(false);
  });
});
