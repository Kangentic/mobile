/**
 * /upgrade-deps decides from version numbers what may move, so a wrong answer here files a task that
 * reddens a required gate, downgrades a fix, or spends a research pass nobody needed. On this app the
 * worst wrong answer is a mapped package planned past the Expo SDK mapping: `npx expo install --check`
 * fails on it, devDependencies included, so TypeScript 7 or a react patch would turn every PR red.
 *
 * Ported from the desktop repo's test; the Expo SDK, patch and first-party cases are this repo's own.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildInventory,
  CACHE_FOLDER,
  changeKind,
  chooseTarget,
  collectDeclared,
  combineMapping,
  diffLockfile,
  DRIFT_GROUP,
  groupOf,
  newestInRange,
  newPeerConflicts,
  nextSdkGroup,
  nextSdkMapping,
  patchedPackages,
  researchState,
  splitAudit,
  stalePatches,
  supplyChainSignals,
  targetsAgree,
  watchedVersion,
  withBlocker,
} from '../../scripts/upgrade-deps.mjs';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const OLD = '2026-09-01T00:00:00.000Z';

interface VersionFacts {
  deprecated?: string;
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  attested?: boolean;
}

function versionsOf(...versions: string[]): Record<string, VersionFacts> {
  return Object.fromEntries(versions.map((version) => [version, {}]));
}

function timesOf(...versions: string[]): Record<string, string> {
  return Object.fromEntries(versions.map((version) => [version, OLD]));
}

function choose(installed: string, latest: string, versions: string[]) {
  return chooseTarget({ installed, distTags: { latest }, versions: versionsOf(...versions) });
}

function packument(latest: string, versions: string[], times?: Record<string, string>) {
  return {
    distTags: { latest },
    versions: versionsOf(...versions),
    times: times ?? timesOf(...versions),
  };
}

const record = (name: string, installed: string) => ({
  name, installed, pinned: false, runtime: false, locations: ['.'],
});

const base = {
  advisories: {},
  briefs: {},
  now: NOW,
  refresh: false,
};

describe('the research cache', () => {
  it('is gitignored, so briefs never reach the public repo', () => {
    const gitignore = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8');
    expect(gitignore.split(/\r?\n/)).toContain(`${CACHE_FOLDER}/`);
  });
});

describe('chooseTarget', () => {
  it('never moves a prerelease pin down to a lower latest', () => {
    expect(choose('1.2.0-beta.15', '1.1.0', ['1.0.0', '1.1.0', '1.2.0-beta.15'])).toBeNull();
  });

  it('follows a prerelease pin along its own channel', () => {
    const versions = ['1.1.0', '1.2.0-alpha.99', '1.2.0-beta.15', '1.2.0-beta.20'];
    expect(choose('1.2.0-beta.15', '1.1.0', versions)).toBe('1.2.0-beta.20');
  });

  it('leaves a beta line for the stable release, not the next line\'s beta', () => {
    const versions = ['1.2.0-beta.15', '1.2.0', '1.3.0-beta.1'];
    expect(choose('1.2.0-beta.15', '1.2.0', versions)).toBe('1.2.0');
  });

  it('keeps a stable install off prereleases and past latest', () => {
    expect(choose('6.0.0', '6.0.1', ['6.0.0', '6.0.1', '6.1.0-beta.1', '7.0.0'])).toBe('6.0.1');
  });

  it('follows a stable dist-tag on our own major, as Expo\'s sdk tags are', () => {
    const target = chooseTarget({
      installed: '58.0.31',
      distTags: { latest: '58.0.31', 'sdk-58': '58.0.32' },
      versions: versionsOf('58.0.31', '58.0.32'),
    });
    expect(target).toBe('58.0.32');
  });

  it('ignores a dist-tag for another major, so an old SDK line never pulls us across', () => {
    const target = chooseTarget({
      installed: '58.0.0',
      distTags: { latest: '58.1.0', 'sdk-59': '59.0.0' },
      versions: versionsOf('58.0.0', '58.1.0', '59.0.0'),
    });
    expect(target).toBe('58.1.0');
  });

  it('skips a deprecated release', () => {
    const target = chooseTarget({
      installed: '1.0.0',
      distTags: { latest: '1.2.0' },
      versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': { deprecated: 'broken build' } },
    });
    expect(target).toBe('1.1.0');
  });
});

describe('newestInRange', () => {
  const router = { versions: versionsOf('58.0.30', '58.0.31', '58.0.33', '58.1.0', '59.0.0', '58.0.34-canary.1') };

  it('takes the newest release a tilde mapping accepts, which is what expo install resolves', () => {
    expect(newestInRange(router, '~58.0.31')).toBe('58.0.33');
  });

  it('never takes a canary the range does not name', () => {
    expect(newestInRange({ versions: versionsOf('58.0.31', '58.0.32-canary.1') }, '~58.0.31')).toBe('58.0.31');
  });

  it('skips a deprecated release and answers null with no range', () => {
    expect(newestInRange({ versions: { '58.0.31': {}, '58.0.32': { deprecated: 'bad' } } }, '~58.0.31')).toBe('58.0.31');
    expect(newestInRange(router, null)).toBeNull();
  });
});

describe('combineMapping', () => {
  it('lets the versions endpoint override the native-modules list, as expo install --check does', () => {
    const mapping = combineMapping(
      [
        { npmPackage: 'expo-router', versionRange: '~58.0.30' },
        { npmPackage: 'react-native-reanimated', versionRange: '4.7.1' },
      ],
      {
        relatedPackages: { typescript: '~6.0.3', jest: '~30.5.2', 'expo-router': '~58.0.31' },
        facebookReactVersion: '19.3.0',
        facebookReactNativeVersion: '0.88.1',
        expoVersion: '~58.0.24',
      },
    );
    expect(mapping).toEqual({
      'expo-router': '~58.0.31',
      'react-native-reanimated': '4.7.1',
      typescript: '~6.0.3',
      jest: '~30.5.2',
      react: '19.3.0',
      'react-dom': '19.3.0',
      'react-native': '0.88.1',
      expo: '~58.0.24',
    });
  });

  it('keeps the native-modules list alone when the versions endpoint has nothing', () => {
    expect(combineMapping([{ npmPackage: 'expo-camera', versionRange: '~58.0.14' }], undefined))
      .toEqual({ 'expo-camera': '~58.0.14' });
  });
});

describe('nextSdkMapping', () => {
  const nativeModules = [{ npmPackage: 'expo-router', versionRange: '~59.0.1' }];

  it('waits for the versions entry, without which react-native would read as a hold', () => {
    expect(nextSdkMapping(nativeModules, undefined, '59.0.2')).toBeNull();
    expect(nextSdkMapping([], { facebookReactNativeVersion: '0.89.0' }, '59.0.2')).toBeNull();
  });

  it('maps react-native and expo once both halves are served', () => {
    expect(nextSdkMapping(nativeModules, { facebookReactNativeVersion: '0.89.0' }, '59.0.2')).toEqual({
      'expo-router': '~59.0.1',
      'react-native': '0.89.0',
      expo: '~59.0.2',
    });
  });
});

describe('patchedPackages and stalePatches', () => {
  it('reads plain, scoped and nested patch names', () => {
    expect(patchedPackages([
      'expo-task-manager+58.0.14.patch',
      '@scope+name+1.2.3.patch',
      'parent++child+0.4.0.patch',
      'README.md',
    ])).toEqual({
      'expo-task-manager': { file: 'patches/expo-task-manager+58.0.14.patch', version: '58.0.14' },
      '@scope/name': { file: 'patches/@scope+name+1.2.3.patch', version: '1.2.3' },
      child: { file: 'patches/parent++child+0.4.0.patch', version: '0.4.0' },
    });
  });

  it('names a patch the lockfile has moved past, which patch-package only warns about', () => {
    const patches = patchedPackages(['expo-task-manager+58.0.14.patch']);
    expect(stalePatches(patches, { 'node_modules/expo-task-manager': { version: '58.0.14' } })).toEqual([]);
    expect(stalePatches(patches, { 'node_modules/expo-task-manager': { version: '58.0.15' } })).toEqual([{
      name: 'expo-task-manager',
      file: 'patches/expo-task-manager+58.0.14.patch',
      patchedVersion: '58.0.14',
      resolved: '58.0.15',
    }]);
  });
});

describe('changeKind', () => {
  it.each([
    ['9.39.5', '10.14.0', 'major'],
    ['0.13.1', '0.14.0', 'major'],
    ['0.0.3', '0.0.4', 'major'],
    ['1.2.0-beta.15', '1.2.0-beta.20', 'prerelease'],
    ['1.69.0', '1.72.0', 'minor'],
    ['58.0.31', '58.0.33', 'patch'],
    ['0.88.1', '0.88.2', 'patch'],
  ])('%s to %s is %s', (installed, target, expected) => {
    expect(changeKind(installed, target)).toBe(expected);
  });
});

describe('groupOf', () => {
  it.each([
    ['@xterm/addon-webgl', 'xterm'],
    ['@xterm/headless', 'xterm'],
    ['@typescript-eslint/parser', 'typescript-eslint'],
    ['@types/ws', 'ws'],
    ['@types/react', 'react'],
    ['@shopify/flash-list', 'shopify-flash-list'],
  ])('%s moves with %s', (packageName, expected) => {
    expect(groupOf(packageName)).toBe(expected);
  });

  it('keeps TypeScript apart from typescript-eslint, so a blocked major does not hold a patch', () => {
    expect(groupOf('typescript')).not.toBe(groupOf('@typescript-eslint/parser'));
  });

  it('names the SDK groups apart from any package group', () => {
    expect(DRIFT_GROUP).toBe('expo-sdk');
    expect(nextSdkGroup(59)).toBe('expo-sdk-59');
  });
});

describe('supplyChainSignals', () => {
  const clean = {
    dependencies: { 'follow-redirects': '^1.0.0' },
    installScripts: [],
    gypfile: false,
    attested: true,
    publisher: 'release-bot',
  };

  it('says nothing when a release changes none of them', () => {
    expect(supplyChainSignals(clean, { ...clean })).toEqual([]);
  });

  it('names the shape of the axios compromise: a new dependency and lost provenance', () => {
    const compromised = {
      ...clean,
      dependencies: { ...clean.dependencies, 'plain-crypto-js': '^4.2.1' },
      attested: false,
      publisher: 'stolen-account',
    };
    expect(supplyChainSignals(clean, compromised)).toEqual([
      'new dependencies (1): plain-crypto-js',
      'provenance dropped',
      'publisher changed: release-bot to stolen-account',
    ]);
  });

  it('catches install-time code with and without an install script', () => {
    expect(supplyChainSignals(clean, { ...clean, installScripts: ['postinstall'] }))
      .toEqual(['new install scripts: postinstall']);
    expect(supplyChainSignals(clean, { ...clean, gypfile: true })).toEqual(['a binding.gyp build appeared']);
  });

  it('caps a long list, so a package with 20 platform builds stays one line', () => {
    const dependencies = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`platform-${index}`, '1.0.0']));
    const [signal] = supplyChainSignals({ ...clean, dependencies: {} }, { ...clean, dependencies });
    expect(signal.startsWith('new dependencies (20): ')).toBe(true);
    expect(signal.split(', ')).toHaveLength(5);
  });

  it('has nothing to compare when a version is missing', () => {
    expect(supplyChainSignals(undefined, clean)).toEqual([]);
  });
});

describe('targetsAgree', () => {
  const targets = (...versions: string[]) => versions.map((target) => ({ target }));

  it('asks typescript-eslint\'s packages, published under one number, to match exactly', () => {
    expect(targetsAgree('typescript-eslint', targets('8.72.2', '8.72.2'))).toBe(true);
    expect(targetsAgree('typescript-eslint', targets('8.72.2', '8.73.0'))).toBe(false);
  });

  it('leaves alone a group whose members number themselves', () => {
    expect(targetsAgree('xterm', targets('6.0.1', '0.20.0'))).toBe(true);
  });
});

describe('collectDeclared', () => {
  const lockPackages = {
    'node_modules/react-native': { version: '0.88.1' },
    'node_modules/zustand': { version: '5.0.16' },
    'node_modules/vitest': { version: '5.1.0' },
  };

  it('marks exact pins and runtime dependencies', () => {
    const declared = collectDeclared([{
      location: '',
      manifest: {
        dependencies: { 'react-native': '0.88.1', zustand: '^5.0.16' },
        devDependencies: { vitest: '^5.1.0' },
      },
    }], lockPackages);
    expect(declared.find(({ name }) => name === 'react-native')).toMatchObject({ pinned: true, runtime: true });
    expect(declared.find(({ name }) => name === 'zustand')).toMatchObject({ pinned: false, runtime: true });
    expect(declared.find(({ name }) => name === 'vitest')).toMatchObject({ pinned: false, runtime: false });
  });

  it('skips a spec that is not a registry range', () => {
    const declared = collectDeclared([{
      location: '',
      manifest: { dependencies: { zustand: 'github:pmndrs/zustand' } },
    }], lockPackages);
    expect(declared).toEqual([]);
  });
});

describe('newPeerConflicts', () => {
  const peers: Record<string, Record<string, string>> = {
    '@typescript-eslint/parser@8.72.1': { typescript: '>=4.8.4 <6.1.0' },
    'lib@1.0.0': { react: '^18.0.0' },
  };
  const peersOf = (name: string, version: string) => peers[`${name}@${version}`] ?? {};

  it('reports a major its dependents cannot accept', () => {
    const conflicts = newPeerConflicts(
      { typescript: '6.0.3', '@typescript-eslint/parser': '8.72.1' },
      { typescript: '7.0.2' },
      peersOf,
    );
    expect(conflicts).toEqual(['@typescript-eslint/parser@8.72.1 needs typescript >=4.8.4 <6.1.0, planned 7.0.2']);
  });

  it('stays quiet about a conflict the tree already has', () => {
    expect(newPeerConflicts({ lib: '1.0.0', react: '19.3.0' }, { react: '19.3.1' }, peersOf)).toEqual([]);
  });
});

describe('splitAudit', () => {
  it('separates an advisory against a package from one that reached it from below', () => {
    expect(splitAudit({
      vulnerabilities: {
        katex: { name: 'katex', severity: 'high', isDirect: true, via: [{ source: 1 }] },
        '@typescript-eslint/parser': {
          name: '@typescript-eslint/parser', severity: 'moderate', isDirect: true, via: ['minimatch'],
        },
        glob: { name: 'glob', severity: 'low', isDirect: false, via: [{ source: 2 }] },
      },
    })).toEqual({
      advisories: { katex: 'high' },
      inheritedAdvisories: { '@typescript-eslint/parser': 'moderate' },
      transitiveCount: 1,
    });
  });
});

describe('researchState', () => {
  const targets = { typescript: '7.0.2' };
  const brief = { targets, verdict: 'ready', evaluatedAt: OLD };
  const stateBase = { targets, watchedVersions: {}, refresh: false };

  it('researches a group with no usable brief', () => {
    expect(researchState({ ...stateBase, brief: undefined })).toBe('research');
    expect(researchState({ ...stateBase, brief: { targets } })).toBe('research');
  });

  it('reuses research of any age while the versions match, so a repeat run spends nothing', () => {
    expect(researchState({ ...stateBase, brief })).toBe('reuse');
  });

  it('asks only for the new releases when the target moved', () => {
    expect(researchState({ ...stateBase, brief, targets: { typescript: '7.0.3' } })).toBe('delta');
  });

  it('leaves a known blocker alone until what it waits on moves', () => {
    const blocked = {
      ...brief,
      verdict: 'blocked',
      blocker: { reason: 'peer range', blockedOn: { '@typescript-eslint/parser': '8.72.1' } },
    };
    expect(researchState({ ...stateBase, brief: blocked, watchedVersions: { '@typescript-eslint/parser': '8.72.1' } })).toBe('blocked');
    expect(researchState({ ...stateBase, brief: blocked, watchedVersions: { '@typescript-eslint/parser': '9.0.0' } })).toBe('recheck');
  });

  it('keeps a blocker with nothing to watch until a new version moves the target', () => {
    const blocked = { ...brief, verdict: 'blocked', blocker: { reason: 'upstream bug' } };
    expect(researchState({ ...stateBase, brief: blocked })).toBe('blocked');
    expect(researchState({ ...stateBase, brief: blocked, targets: { typescript: '7.0.3' } })).toBe('delta');
  });

  it('treats a filed brief as handled, and --refresh as no brief at all', () => {
    expect(researchState({ ...stateBase, brief: { ...brief, task: { displayId: 12 } } })).toBe('filed');
    expect(researchState({ ...stateBase, brief, refresh: true })).toBe('research');
  });

  it('never reuses a draft a stopped agent left', () => {
    expect(researchState({ ...stateBase, brief: { ...brief, draft: true } })).toBe('research');
  });

  it('leaves a brief a task agent blocked alone on the next run', () => {
    const blocked = withBlocker(
      { ...brief, task: { displayId: 12 } },
      { reason: 'peer range', recheck: 'range opens', blockedOn: { 'eslint-plugin-react': '7.37.5' } },
      NOW,
    );
    expect(blocked.task).toBeNull();
    expect(researchState({ ...stateBase, brief: blocked, watchedVersions: { 'eslint-plugin-react': '7.37.5' } })).toBe('blocked');
  });
});

describe('watchedVersion', () => {
  const addon = {
    distTags: { latest: '0.19.0' },
    versions: versionsOf('0.19.0', '0.20.0-beta.329', '0.20.0-beta.336'),
  };

  it('follows a recorded beta along its own line, where latest would never move', () => {
    expect(watchedVersion('0.20.0-beta.329', addon)).toBe('0.20.0-beta.336');
  });

  it('never moves a recorded stable version onto a beta', () => {
    expect(watchedVersion('0.19.0', addon)).toBe('0.19.0');
  });
});

describe('diffLockfile', () => {
  const before = {
    '': { name: '@kangentic/mobile', version: '0.1.0', hasInstallScript: true },
    'node_modules/react-native-enriched-markdown': { version: '1.1.1', hasInstallScript: true },
    'node_modules/ws': { version: '8.22.1' },
    'node_modules/gone': { version: '1.0.0' },
  };

  it('reports what a phase moved, added and removed, and never the root entry', () => {
    const diff = diffLockfile(before, {
      '': { name: '@kangentic/mobile', version: '0.1.0' },
      'node_modules/react-native-enriched-markdown': { version: '1.1.1', hasInstallScript: true },
      'node_modules/ws': { version: '8.22.2' },
      'node_modules/fresh': { version: '2.0.0', hasInstallScript: true },
    });
    expect(diff.changed).toEqual([{ name: 'ws', from: '8.22.1', to: '8.22.2' }]);
    expect(diff.added).toEqual([{ name: 'fresh', version: '2.0.0', hasInstallScript: true }]);
    expect(diff.removed).toEqual([{ name: 'gone', version: '1.0.0' }]);
    expect(diff.installScriptFlips).toEqual([]);
  });

  it('tells the npm update bug (flag gone, same version) from a release that dropped its script', () => {
    const stripped = diffLockfile(before, { ...before, 'node_modules/react-native-enriched-markdown': { version: '1.1.1' } });
    expect(stripped.installScriptFlips).toEqual([
      { name: 'react-native-enriched-markdown', had: true, versionChanged: false },
    ]);
    const released = diffLockfile(before, { ...before, 'node_modules/react-native-enriched-markdown': { version: '1.2.0' } });
    expect(released.installScriptFlips).toEqual([
      { name: 'react-native-enriched-markdown', had: true, versionChanged: true },
    ]);
  });
});

describe('buildInventory, by the registry alone', () => {
  it('moves a lockstep group as one, and counts a package already current', () => {
    const inventory = buildInventory({
      ...base,
      declared: [
        record('@typescript-eslint/parser', '8.72.1'),
        record('@typescript-eslint/eslint-plugin', '8.72.1'),
        record('ws', '8.22.2'),
      ],
      packuments: {
        '@typescript-eslint/parser': packument('8.72.2', ['8.72.1', '8.72.2']),
        '@typescript-eslint/eslint-plugin': packument('8.72.2', ['8.72.1', '8.72.2']),
        ws: packument('8.22.2', ['8.22.2']),
      },
    });
    expect(inventory.currentCount).toBe(1);
    expect(inventory.groups).toHaveLength(1);
    expect(inventory.groups[0]).toMatchObject({ group: 'typescript-eslint', kind: 'patch', research: 'research' });
    expect(inventory.groups[0].members.map(({ name }) => name))
      .toEqual(['@typescript-eslint/parser', '@typescript-eslint/eslint-plugin']);
  });

  it('flags a set caught mid-publish, so research picks versions that match', () => {
    const inventory = buildInventory({
      ...base,
      declared: [record('@typescript-eslint/parser', '8.72.1'), record('@typescript-eslint/eslint-plugin', '8.72.1')],
      packuments: {
        '@typescript-eslint/parser': packument('8.73.0', ['8.72.1', '8.73.0']),
        '@typescript-eslint/eslint-plugin': packument('8.72.2', ['8.72.1', '8.72.2']),
      },
    });
    expect(inventory.groups[0]).toMatchObject({ group: 'typescript-eslint', targetsDisagree: true });
  });

  it('never lists a beta pin whose latest is older as something to move', () => {
    const inventory = buildInventory({
      ...base,
      declared: [record('beta-lib', '1.2.0-beta.15')],
      packuments: { 'beta-lib': packument('1.1.0', ['1.1.0', '1.2.0-beta.15']) },
    });
    expect(inventory.groups).toEqual([]);
    expect(inventory.currentCount).toBe(1);
  });

  it('targets a release published moments ago, and says when it was published', () => {
    const published = new Date(NOW - 60 * 1000).toISOString();
    const inventory = buildInventory({
      ...base,
      declared: [record('vite', '8.3.6')],
      packuments: { vite: packument('8.3.8', ['8.3.6', '8.3.8'], { '8.3.6': OLD, '8.3.8': published }) },
    });
    expect(inventory.groups[0].members[0]).toMatchObject({ target: '8.3.8', published });
  });

  it('reports a package whose latest is deprecated instead of calling it current, and caches it', () => {
    const declared = [record('@types/uuid', '10.0.0')];
    const packuments = {
      '@types/uuid': {
        distTags: { latest: '11.0.0' },
        versions: { '10.0.0': {}, '11.0.0': { deprecated: 'uuid ships its own types' } },
        times: timesOf('10.0.0', '11.0.0'),
      },
    };
    const fresh = buildInventory({ ...base, declared, packuments });
    expect(fresh.currentCount).toBe(0);
    expect(fresh.groups[0]).toMatchObject({ group: 'uuid', kind: 'deprecated' });
    expect(fresh.groups[0].members[0]).toMatchObject({ target: '10.0.0', deprecated: 'uuid ships its own types' });
    const cached = buildInventory({
      ...base,
      declared,
      packuments,
      briefs: { uuid: { targets: { '@types/uuid': '10.0.0' }, verdict: 'ready', evaluatedAt: OLD } },
    });
    expect(cached.groups[0].research).toBe('reuse');
  });

  it('flags a group whose target changed what the attacks changed', () => {
    const inventory = buildInventory({
      ...base,
      declared: [record('axios', '1.14.0')],
      packuments: {
        axios: {
          distTags: { latest: '1.14.1' },
          versions: {
            '1.14.0': { attested: true },
            '1.14.1': { attested: false, dependencies: { 'plain-crypto-js': '^4.2.1' } },
          },
          times: timesOf('1.14.0', '1.14.1'),
        },
      },
    });
    expect(inventory.groups[0].signals).toBe(true);
    expect(inventory.groups[0].members[0].signals).toHaveLength(2);
  });

  it('settles a blocker on a package nothing declares', () => {
    const inventory = buildInventory({
      ...base,
      briefs: {
        eslint: {
          targets: { eslint: '10.14.0' },
          verdict: 'blocked',
          evaluatedAt: OLD,
          blocker: { reason: 'peer range', blockedOn: { 'eslint-plugin-react': '7.37.5' } },
        },
      },
      declared: [record('eslint', '9.39.5')],
      packuments: {
        eslint: packument('10.14.0', ['9.39.5', '10.14.0']),
        'eslint-plugin-react': packument('7.37.5', ['7.37.5']),
      },
    });
    expect(inventory.groups[0].research).toBe('blocked');
  });

  it('keeps a filed task visible when a new release moves the target', () => {
    const inventory = buildInventory({
      ...base,
      briefs: { vite: { targets: { vite: '8.3.7' }, verdict: 'ready', evaluatedAt: OLD, task: { displayId: 12 } } },
      declared: [record('vite', '8.3.6')],
      packuments: { vite: packument('8.3.8', ['8.3.6', '8.3.7', '8.3.8']) },
    });
    expect(inventory.groups[0]).toMatchObject({ research: 'delta', task: { displayId: 12 } });
  });

  it('marks a group for its own researcher only when the advisory is against the package itself', () => {
    const declared = [record('vite', '8.3.6')];
    const packuments = { vite: packument('8.3.8', ['8.3.6', '8.3.8']) };
    const own = buildInventory({ ...base, advisories: { vite: 'high' }, declared, packuments });
    expect(own.groups[0]).toMatchObject({ group: 'vite', advisory: true });
    const inherited = buildInventory({ ...base, inheritedAdvisories: { vite: 'moderate' }, declared, packuments });
    expect(inherited.groups[0].advisory).toBe(false);
    expect(inherited.groups[0].members[0].inheritedAdvisory).toBe('moderate');
  });

  it('names a first-party package and never researches it', () => {
    const inventory = buildInventory({
      ...base,
      declared: [record('@kangentic/protocol', '0.27.0')],
      packuments: { '@kangentic/protocol': packument('0.28.0', ['0.27.0', '0.28.0']) },
    });
    expect(inventory.groups).toEqual([]);
    expect(inventory.firstParty).toEqual([{ name: '@kangentic/protocol', installed: '0.27.0', newest: '0.28.0' }]);
  });
});

describe('buildInventory, under the Expo SDK mapping', () => {
  const sdk58 = {
    installedMajor: 58,
    mapping: {
      expo: '~58.0.24',
      'expo-router': '~58.0.31',
      'expo-task-manager': '~58.0.14',
      typescript: '~6.0.3',
      react: '19.3.0',
      'react-native': '0.88.1',
      'react-native-reanimated': '4.7.1',
      'react-native-worklets': '0.13.0',
      'react-native-gesture-handler': '~3.3.0',
    },
    exclude: ['react-native-worklets', 'react-native-gesture-handler'],
    next: null,
  };
  const groupNamed = (inventory: ReturnType<typeof buildInventory>, group: string) => (
    inventory.groups.find((candidate) => candidate.group === group)
  );

  it('moves mapped packages only as far as the mapping, all in the one expo-sdk group', () => {
    const inventory = buildInventory({
      ...base,
      sdk: sdk58,
      declared: [record('expo', '58.0.24'), record('expo-router', '58.0.31')],
      packuments: {
        expo: packument('58.0.25', ['58.0.24', '58.0.25']),
        'expo-router': packument('58.0.33', ['58.0.31', '58.0.33', '58.0.34-canary.2']),
      },
    });
    expect(inventory.groups).toHaveLength(1);
    expect(inventory.groups[0]).toMatchObject({ group: DRIFT_GROUP, sdkRole: 'drift', kind: 'patch' });
    expect(inventory.groups[0].members.map(({ name, target, sdkRange }) => ({ name, target, sdkRange }))).toEqual([
      { name: 'expo', target: '58.0.25', sdkRange: '~58.0.24' },
      { name: 'expo-router', target: '58.0.33', sdkRange: '~58.0.31' },
    ]);
  });

  it('never plans a mapped package past the gate: TypeScript 7 is a hold to vet, not drift', () => {
    const inventory = buildInventory({
      ...base,
      sdk: sdk58,
      declared: [record('typescript', '6.0.3')],
      packuments: { typescript: packument('7.0.2', ['6.0.3', '6.0.4', '7.0.2']) },
    });
    expect(groupNamed(inventory, DRIFT_GROUP)?.members).toEqual([
      expect.objectContaining({ name: 'typescript', target: '6.0.4' }),
    ]);
    expect(groupNamed(inventory, 'typescript')).toMatchObject({ sdkRole: 'beyond-mapping', kind: 'major' });
    expect(groupNamed(inventory, 'typescript')?.members[0]).toMatchObject({
      target: '7.0.2', sdkRange: '~6.0.3', beyondMapping: true,
    });
  });

  it('counts a package at the newest its exact mapping allows as current', () => {
    const inventory = buildInventory({
      ...base,
      sdk: sdk58,
      declared: [record('react', '19.3.0')],
      packuments: { react: packument('19.3.0', ['19.2.7', '19.3.0']) },
    });
    expect(inventory.groups).toEqual([]);
    expect(inventory.currentCount).toBe(1);
  });

  it('judges a held package by the registry, never pulls it back to the mapping', () => {
    const inventory = buildInventory({
      ...base,
      sdk: sdk58,
      declared: [record('react-native-gesture-handler', '3.5.0')],
      packuments: { 'react-native-gesture-handler': packument('3.6.0', ['3.3.2', '3.5.0', '3.6.0']) },
    });
    expect(groupNamed(inventory, DRIFT_GROUP)).toBeUndefined();
    expect(inventory.groups[0]).toMatchObject({ group: 'react-native-gesture-handler', sdkRole: 'held', kind: 'minor' });
    expect(inventory.groups[0].members[0]).toMatchObject({ target: '3.6.0', held: true, holdCanEnd: false });
  });

  it('lists a hold the mapping has caught up with, though nothing newer exists', () => {
    const inventory = buildInventory({
      ...base,
      sdk: { ...sdk58, mapping: { ...sdk58.mapping, 'react-native-gesture-handler': '~3.5.0' } },
      declared: [record('react-native-gesture-handler', '3.5.0')],
      packuments: { 'react-native-gesture-handler': packument('3.5.0', ['3.3.2', '3.5.0']) },
    });
    expect(inventory.currentCount).toBe(0);
    expect(inventory.groups[0]).toMatchObject({ sdkRole: 'held', kind: 'unhold' });
    expect(inventory.groups[0].members[0]).toMatchObject({ target: '3.5.0', holdCanEnd: true });
  });

  it('keeps mapped reanimated and held worklets apart, coupled through reanimated\'s peer range', () => {
    const inventory = buildInventory({
      ...base,
      sdk: sdk58,
      declared: [record('react-native-reanimated', '4.7.1'), record('react-native-worklets', '0.13.1')],
      packuments: {
        'react-native-reanimated': {
          distTags: { latest: '4.7.1' },
          versions: { '4.7.1': { peerDependencies: { 'react-native-worklets': '0.13.x' } } },
          times: timesOf('4.7.1'),
        },
        'react-native-worklets': packument('0.14.0', ['0.13.0', '0.13.1', '0.14.0']),
      },
    });
    expect(inventory.currentCount).toBe(1);
    expect(inventory.groups).toHaveLength(1);
    expect(inventory.groups[0]).toMatchObject({ group: 'react-native-worklets', sdkRole: 'held' });
    expect(inventory.groups[0].peerConflicts).toEqual([
      'react-native-reanimated@4.7.1 needs react-native-worklets 0.13.x, planned 0.14.0',
    ]);
  });

  it('moves the react-native-tracking jest preset with react-native, and holds it while react-native holds', () => {
    const preset = packument('0.89.0', ['0.88.1', '0.88.2', '0.89.0']);
    const drifting = buildInventory({
      ...base,
      sdk: { ...sdk58, mapping: { ...sdk58.mapping, 'react-native': '0.88.2' } },
      declared: [record('react-native', '0.88.1'), record('@react-native/jest-preset', '0.88.1')],
      packuments: { 'react-native': packument('0.89.0', ['0.88.1', '0.88.2', '0.89.0']), '@react-native/jest-preset': preset },
    });
    const drift = groupNamed(drifting, DRIFT_GROUP);
    expect(drift?.members.find(({ name }) => name === '@react-native/jest-preset'))
      .toMatchObject({ target: '0.88.2', tracks: 'react-native' });
    // react-native 0.89 is a hold to vet here, and the preset follows it there too: wherever the
    // preset moves, react-native moves to the same version in the same group.
    const presetMoves = drifting.groups.flatMap(({ group, members }) => members
      .filter(({ name }) => name === '@react-native/jest-preset')
      .map(({ target }) => ({ group, target })));
    expect(presetMoves.length).toBeGreaterThan(0);
    for (const { group, target } of presetMoves) {
      expect(groupNamed(drifting, group)?.members.find(({ name }) => name === 'react-native')?.target).toBe(target);
    }

    const steady = buildInventory({
      ...base,
      sdk: sdk58,
      declared: [record('react-native', '0.88.1'), record('@react-native/jest-preset', '0.88.1')],
      packuments: { 'react-native': packument('0.88.1', ['0.88.1']), '@react-native/jest-preset': preset },
    });
    expect(steady.groups).toEqual([]);
    expect(steady.currentCount).toBe(2);
  });

  it('flags a patched package, so its phase re-checks and renames the patch', () => {
    const inventory = buildInventory({
      ...base,
      sdk: sdk58,
      patches: patchedPackages(['expo-task-manager+58.0.14.patch']),
      declared: [record('expo-task-manager', '58.0.14')],
      packuments: { 'expo-task-manager': packument('58.0.15', ['58.0.14', '58.0.15']) },
    });
    expect(inventory.groups[0]).toMatchObject({ group: DRIFT_GROUP, patched: true });
    expect(inventory.groups[0].members[0]).toMatchObject({ patch: 'patches/expo-task-manager+58.0.14.patch' });
  });

  it('makes a newer SDK its own group, held packages included, and leaves its versions out of every hold', () => {
    const inventory = buildInventory({
      ...base,
      sdk: {
        ...sdk58,
        next: {
          major: 59,
          mapping: { expo: '~59.0.2', 'expo-router': '~59.0.1', 'react-native-gesture-handler': '~3.7.0' },
        },
      },
      declared: [record('expo', '58.0.24'), record('expo-router', '58.0.31'), record('react-native-gesture-handler', '3.5.0')],
      packuments: {
        expo: packument('59.0.2', ['58.0.24', '59.0.2']),
        'expo-router': packument('59.0.1', ['58.0.31', '59.0.1']),
        'react-native-gesture-handler': packument('3.7.0', ['3.5.0', '3.7.0']),
      },
    });
    const nextGroup = groupNamed(inventory, nextSdkGroup(59));
    expect(nextGroup).toMatchObject({ sdkRole: 'next-sdk', kind: 'major' });
    expect(nextGroup?.members.map(({ name, target, held }) => ({ name, target, held }))).toEqual([
      { name: 'expo', target: '59.0.2', held: undefined },
      { name: 'expo-router', target: '59.0.1', held: undefined },
      { name: 'react-native-gesture-handler', target: '3.7.0', held: true },
    ]);
    expect(groupNamed(inventory, 'expo')).toBeUndefined();
    expect(groupNamed(inventory, 'expo-router')).toBeUndefined();
  });
});
