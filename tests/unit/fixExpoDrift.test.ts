/**
 * scripts/fixExpoDrift.mjs renames each patch-package patch whose package Expo's
 * realignment moved, so the filename names the version now installed. A wrong name
 * is silent: patch-package only warns while the hunk still fits, and drops the patch
 * the day it stops fitting. The expo-task-manager patch guards a headless-push crash
 * (see the patches/ note in CLAUDE.md), so a dropped one ships that crash.
 *
 * The renames reuse upgrade-deps.mjs's patch-name parser and stale-patch finder,
 * which tests/unit/upgrade-deps.test.ts covers; these tests cover the rename built
 * on them.
 *
 * Tier: Unit.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { installedVersionMismatches, patchRenames, planPatchRenames } from '../../scripts/fixExpoDrift.mjs';

type LockPackages = Record<string, { version?: string }>;

/** A node_modules that holds exactly what the lockfile says, as a fresh `npm ci` does. */
function installedAsLocked(lockPackages: LockPackages): (packageName: string) => string | null {
  return (packageName) => lockPackages[`node_modules/${packageName}`]?.version ?? null;
}

/** planPatchRenames against a node_modules that matches the lockfile. */
function planAgainstLockfile(patchFileNames: string[], lockPackages: LockPackages) {
  return planPatchRenames(patchFileNames, lockPackages, installedAsLocked(lockPackages));
}

describe('planPatchRenames', () => {
  it('renames a moved patch to the version the lockfile now installs', () => {
    const plan = planAgainstLockfile(['expo-task-manager+58.0.14.patch'], {
      'node_modules/expo-task-manager': { version: '58.0.15' },
    });
    expect(plan).toEqual({
      renames: [
        {
          name: 'expo-task-manager',
          from: 'patches/expo-task-manager+58.0.14.patch',
          to: 'patches/expo-task-manager+58.0.15.patch',
        },
      ],
      problems: [],
    });
  });

  it('keeps the scoped form of the name', () => {
    const plan = planAgainstLockfile(['@scope+name+1.0.0.patch'], { 'node_modules/@scope/name': { version: '1.0.1' } });
    expect(plan.renames).toEqual([
      { name: '@scope/name', from: 'patches/@scope+name+1.0.0.patch', to: 'patches/@scope+name+1.0.1.patch' },
    ]);
  });

  it('refuses a nested patch rather than renaming it to a hoisted copy of the child', () => {
    // The nested child is still 1.0.0 (node_modules/parent/node_modules/child); the
    // top-level entry is another copy. Renaming to 2.0.0 would name a version the
    // patch was never applied to, and patch-package would only warn.
    const lockPackages = {
      'node_modules/child': { version: '2.0.0' },
      'node_modules/parent/node_modules/child': { version: '1.0.0' },
    };
    const plan = planAgainstLockfile(['parent++child+1.0.0.patch'], lockPackages);
    expect(plan.renames).toEqual([]);
    expect(plan.problems).toEqual([expect.stringContaining('patches/parent++child+1.0.0.patch patches a nested package')]);
  });

  it('renames nothing when the patched package did not move', () => {
    expect(
      planAgainstLockfile(['expo-task-manager+58.0.14.patch'], { 'node_modules/expo-task-manager': { version: '58.0.14' } })
    ).toEqual({ renames: [], problems: [] });
  });

  it('reports a patch whose package the lockfile no longer installs, rather than renaming it', () => {
    const plan = planAgainstLockfile(['expo-task-manager+58.0.14.patch'], {});
    expect(plan.renames).toEqual([]);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toContain('expo-task-manager');
  });

  it('ignores files that are not patches', () => {
    expect(planAgainstLockfile(['README.md'], {})).toEqual({ renames: [], problems: [] });
  });

  it('renames nothing when node_modules disagrees with the lockfile, even though a patch is stale', () => {
    // The patch is stale against the lockfile (58.0.14 vs 58.0.15), but node_modules
    // still holds 58.0.14, so a rename would name a version nothing installed.
    const lockPackages = { 'node_modules/expo-task-manager': { version: '58.0.15' } };
    const plan = planPatchRenames(['expo-task-manager+58.0.14.patch'], lockPackages, () => '58.0.14');
    expect(plan.renames).toEqual([]);
    expect(plan.problems).toEqual([
      'expo-task-manager: the lockfile has 58.0.15, node_modules has 58.0.14.',
      expect.stringContaining('Run `npm ci`'),
    ]);
  });

  it('renames nothing at all when one patch is renameable but another has a problem', () => {
    // No half-renamed patches directory: the second patch's package left the lockfile.
    const plan = planAgainstLockfile(['expo-task-manager+58.0.14.patch', 'gone-package+1.0.0.patch'], {
      'node_modules/expo-task-manager': { version: '58.0.15' },
    });
    expect(plan.renames).toEqual([]);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toContain('gone-package');
  });
});

describe('fixExpoDrift.mjs and checkExpoDrift.mjs run their commands online', () => {
  const repositoryRoot = new URL('../../', import.meta.url);

  for (const scriptName of ['fixExpoDrift.mjs', 'checkExpoDrift.mjs']) {
    it(`${scriptName} imports onlineEnvironment and spawns with it`, () => {
      const source = readFileSync(new URL(`scripts/${scriptName}`, repositoryRoot), 'utf8');
      expect(source).toContain("import { onlineEnvironment } from './lib/onlineEnvironment.mjs';");
      expect(source).toContain('env: onlineEnvironment(process.env)');
    });
  }
});

describe('patchRenames', () => {
  it('refuses a file whose name does not end in the version it was parsed from', () => {
    // Defensive: stalePatches() output is built from the filename, so this only fires
    // if a caller hands it something else. A rename then could not be trusted.
    const result = patchRenames([
      { name: 'expo-task-manager', file: 'patches/expo-task-manager.patch', patchedVersion: '58.0.14', resolved: '58.0.15' },
    ]);
    expect(result.renames).toEqual([]);
    expect(result.problems[0]).toContain('cannot be renamed safely');
  });
});

describe('installedVersionMismatches', () => {
  const lockPackages = { 'node_modules/expo-task-manager': { version: '58.0.15' } };

  it('passes when node_modules holds the lockfile version', () => {
    expect(installedVersionMismatches(['expo-task-manager'], lockPackages, () => '58.0.15')).toEqual([]);
  });

  it('names a package whose installed version is not the lockfile one', () => {
    expect(installedVersionMismatches(['expo-task-manager'], lockPackages, () => '58.0.14')).toEqual([
      { name: 'expo-task-manager', locked: '58.0.15', installed: '58.0.14' },
    ]);
    expect(installedVersionMismatches(['expo-task-manager'], lockPackages, () => null)).toEqual([
      { name: 'expo-task-manager', locked: '58.0.15', installed: null },
    ]);
  });
});
