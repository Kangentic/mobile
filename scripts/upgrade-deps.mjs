#!/usr/bin/env node
/**
 * The mechanical half of /upgrade-deps. Reads every npm dependency the app declares, asks the
 * registry and Expo's version service what exists now, and says per group what can move and
 * whether earlier research still answers it.
 *
 * Why a script: on this app the answer to "what can move" is not `npm outdated`. Most of the native
 * stack is mapped by the Expo SDK, and `npx expo install --check` is a REQUIRED gate that fails any
 * mapped package outside its mapping, devDependencies included (`typescript`, `jest` and
 * `@types/jest` are mapped too, so TypeScript 7 would redden it). The mapping also moves on Expo's
 * server with no change in this repo. So a mapped package's target comes from the mapping, a move
 * past it is a hold that needs a recorded reason (`expo.install.exclude` plus a row in
 * docs/developer-guide.md), and a newer SDK is a group of its own. Every one of those decisions is a
 * function of version numbers and is never left to a reading of the output.
 *
 * It runs as often as anyone likes. Nothing here depends on the date: a target is the newest
 * eligible release, and research is reused while the versions match, however old it is.
 *
 * Usage: node scripts/upgrade-deps.mjs inventory [--refresh]
 *        node scripts/upgrade-deps.mjs record-blocker <group> --reason <text> --recheck <text>
 *                                                [--blocked-on <package>=<version>]...
 *        node scripts/upgrade-deps.mjs lockdiff [<package>@<version>]...
 *        node scripts/upgrade-deps.mjs cache-dir
 *   inventory       prints JSON: the groups that can move, the SDK it read, first-party packages,
 *                   stale patches and audit counts. The registry and the Expo API are read on every
 *                   run. Only research is cached.
 *                   --refresh   marks every group for fresh research, ignoring the cache.
 *   record-blocker  marks a group's brief blocked, so the next run does not file it again. A task
 *                   agent runs this from its worktree, which cannot write the root checkout's
 *                   cache unattended with a file tool but can run this.
 *   lockdiff        prints what the working package-lock.json changed against HEAD, the checks
 *                   apply.md asks of every phase, and whether each named package resolved to the
 *                   version given. Exit 1 when one did not, when a package lost its install script
 *                   flag at an unchanged version, or when a patched package no longer matches its
 *                   patch file's version.
 *   cache-dir       prints the folder that holds the research.
 *
 * The cache is one JSON brief per group at <root checkout>/.upgrade-deps/briefs/<group>.json. It is
 * gitignored and sits in the ROOT checkout, so every worktree of a clone reaches the same folder. It
 * has its own folder because `.kangentic/` is the app's (a project delete removes it) and `.claude/`
 * is a protected path that background agents cannot write to unattended. Losing it costs a research
 * pass and nothing else. The brief's shape is in .claude/agents/upgrade-researcher.md.
 *
 * Ported from the desktop repo's copy. The divergences: the Expo SDK mapping (drift, holds, a newer
 * SDK, the `@react-native/*` packages that track react-native), first-party `@kangentic/*` packages
 * left to the features that adopt them, patch-package patches checked against the lockfile, a
 * `native` flag for the release-build gate, no workspaces, and an install script flag treated as
 * lost only at an unchanged version.
 *
 * Exit 0 with a report, including one that lists registry errors. Exit 2 for a usage error.
 */
import { exec, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import semver from 'semver';
import { isEntrypoint } from './lib/is-entrypoint.mjs';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_URL = 'https://registry.npmjs.org';
const EXPO_API_URL = 'https://api.expo.dev/v2';
const REGISTRY_CONCURRENCY = 8;
const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/** The research cache's folder in the root checkout. Must stay gitignored: briefs are not for the public repo. */
export const CACHE_FOLDER = '.upgrade-deps';

/** The group that moves every mapped package to what the installed SDK's mapping now expects. */
export const DRIFT_GROUP = 'expo-sdk';

/** The group that moves the app to a newer Expo SDK. */
export function nextSdkGroup(major) {
  return `expo-sdk-${major}`;
}

/**
 * Published from the desktop repo and adopted by the feature that needs them: a protocol minor is
 * new wire behaviour this app has to consume, and a branding release redraws what a person sees.
 * The inventory names them and never researches them.
 */
const FIRST_PARTY = /^@kangentic\//;

/**
 * Packages released in lockstep with another package and not mapped by the SDK, so nothing else
 * keeps them matched. Each moves in whatever group moves the package it tracks, to that package's
 * target. `@react-native/jest-preset` peers only on react, so no peer check would catch it
 * drifting off react-native's version.
 */
const TRACKS = { '@react-native/jest-preset': 'react-native' };

/**
 * Packages that release together or must match exactly, and that the SDK does not map. Tooling
 * that merely peers on another package stays apart: the peer check below reports the conflict when
 * two collide. That is also how `react-native-reanimated` (mapped) and `react-native-worklets`
 * (held) stay coupled: reanimated peers on `react-native-worklets: 0.13.x`.
 *
 * `agree` says what members' targets must share: `version` for a set published under one number.
 * A group without it may hold different numbers, as the @xterm addons do.
 */
const LOCKSTEP_GROUPS = [
  { group: 'xterm', pattern: /^@xterm\// },
  { group: 'typescript-eslint', pattern: /^@typescript-eslint\//, agree: 'version' },
];

/** The group a package moves with when the SDK does not decide it. A `@types/x` package moves with `x`. */
export function groupOf(packageName) {
  for (const { group, pattern } of LOCKSTEP_GROUPS) {
    if (pattern.test(packageName)) return group;
  }
  const typesMatch = /^@types\/(.+)$/.exec(packageName);
  const baseName = typesMatch ? typesMatch[1] : packageName;
  return baseName.replace(/^@/, '').replace(/\//g, '-');
}

/**
 * The highest release worth moving to. Nothing at or below `installed` ever qualifies, which is the
 * guard for a package whose `latest` sits behind a prerelease we run. A stable install never
 * crosses its ceiling or takes a prerelease. The ceiling is `latest`, or a stable dist-tag on the
 * installed major when that is higher (Expo packages carry `sdk-<N>` tags). A tag for another major
 * is ignored, so an old line's tag never pulls us across a major. A prerelease install takes
 * another prerelease only of the same major.minor.patch, so once the stable release ships it moves
 * there and not on to the next line's beta. Renovate's `ignoreUnstable` draws the same line.
 *
 * @returns {string | null} the version to move to, or null when nothing qualifies
 */
export function chooseTarget({ installed, distTags, versions }) {
  const installedBase = semver.prerelease(installed) ? semver.coerce(installed).version : null;
  const installedMajor = semver.major(installed);
  const ceiling = Object.entries(distTags)
    .filter(([tag, version]) => semver.valid(version) && !semver.prerelease(version)
      && (tag === 'latest' || semver.major(version) === installedMajor))
    .map(([, version]) => version)
    .sort(semver.rcompare)[0];

  const candidates = Object.keys(versions)
    .filter((version) => {
      if (!semver.valid(version) || !semver.gt(version, installed)) return false;
      if (versions[version].deprecated) return false;
      if (semver.prerelease(version)) return semver.coerce(version).version === installedBase;
      return ceiling === undefined || semver.lte(version, ceiling);
    })
    .sort(semver.rcompare);

  return candidates[0] ?? null;
}

/**
 * The newest release an SDK mapping range accepts, which is what `npx expo install <package>`
 * resolves to. Prereleases are left out unless the range names one, as npm does.
 *
 * @returns {string | null}
 */
export function newestInRange({ versions }, range) {
  if (!range || !semver.validRange(range)) return null;
  const candidates = Object.keys(versions)
    .filter((version) => semver.valid(version) && !versions[version].deprecated);
  return semver.maxSatisfying(candidates, range);
}

/**
 * One SDK's mapping, combined the way `expo install --check` combines it (read from
 * @expo/cli's getCombinedKnownVersionsAsync): the native-modules list, overridden by the versions
 * endpoint's `relatedPackages` plus react, react-dom, react-native and expo itself. The override
 * is what lets Expo move an expected version server-side.
 *
 * @param {Array<{ npmPackage: string, versionRange: string }>} nativeModules
 * @param {{ relatedPackages?: Record<string, string>, facebookReactVersion?: string,
 *   facebookReactNativeVersion?: string, expoVersion?: string } | undefined} sdkVersion
 * @returns {Record<string, string>}
 */
export function combineMapping(nativeModules, sdkVersion) {
  const mapping = Object.fromEntries(nativeModules.map(({ npmPackage, versionRange }) => [npmPackage, versionRange]));
  if (!sdkVersion) return mapping;
  Object.assign(mapping, sdkVersion.relatedPackages ?? {});
  if (sdkVersion.facebookReactVersion) {
    mapping.react = sdkVersion.facebookReactVersion;
    mapping['react-dom'] = sdkVersion.facebookReactVersion;
  }
  if (sdkVersion.expoVersion) mapping.expo = sdkVersion.expoVersion;
  if (sdkVersion.facebookReactNativeVersion) mapping['react-native'] = sdkVersion.facebookReactNativeVersion;
  return mapping;
}

/**
 * A newer SDK's mapping, or null until Expo serves BOTH halves of it. With the native-modules list
 * alone, `react`, `react-native` and `typescript` would drop out of the SDK's group, and a
 * react-native major would read as a hold to vet instead of part of the SDK.
 *
 * @param {Array<{ npmPackage: string, versionRange: string }>} nativeModules
 * @param {Parameters<typeof combineMapping>[1]} sdkVersion
 * @param {string} newestExpo the newer SDK's `expo` release
 * @returns {Record<string, string> | null}
 */
export function nextSdkMapping(nativeModules, sdkVersion, newestExpo) {
  if (nativeModules.length === 0 || !sdkVersion) return null;
  const mapping = combineMapping(nativeModules, sdkVersion);
  mapping.expo ??= `~${newestExpo}`;
  return mapping;
}

/**
 * patch-package's file names, read back into the package each one patches and the version it was
 * cut against: `expo-task-manager+58.0.14.patch`, `@scope+name+1.0.0.patch`, and a nested
 * `parent++child+1.0.0.patch`, which patches `child`.
 *
 * @returns {Record<string, { file: string, version: string }>}
 */
export function patchedPackages(fileNames) {
  const patched = {};
  for (const fileName of fileNames) {
    const match = /^(.+)\+([^+]+)\.patch$/.exec(fileName);
    if (!match) continue;
    const chain = match[1].split('++');
    patched[chain[chain.length - 1].replace('+', '/')] = { file: `patches/${fileName}`, version: match[2] };
  }
  return patched;
}

/**
 * Patches whose version no longer matches what the lockfile resolves. patch-package warns on a
 * version mismatch and still applies a hunk that fits, so a stale name is a warning today, and a
 * silent drop the day the hunk stops applying. CI's node_modules cache key hashes `patches/**`, so
 * the rename belongs in the same commit as the lockfile.
 */
export function stalePatches(patches, lockPackages) {
  return Object.entries(patches).flatMap(([name, { file, version }]) => {
    const resolved = lockPackages[`node_modules/${name}`]?.version ?? null;
    return resolved === version ? [] : [{ name, file, patchedVersion: version, resolved }];
  });
}

/**
 * What changed between two versions that the 2026 npm attacks changed. A compromised axios release
 * differed from the last good one only by a new dependency and a publish with no provenance, and
 * Phantom Gyp ran code through a `binding.gyp` with no install script at all. Each one is a reason
 * to look, not a verdict: a native module adding a platform package is ordinary.
 *
 * @returns {string[]} one line per signal
 */
export function supplyChainSignals(from, to) {
  if (!from || !to) return [];
  const signals = [];
  const added = Object.keys(to.dependencies ?? {}).filter((name) => !(name in (from.dependencies ?? {})));
  if (added.length > 0) signals.push(`new dependencies (${added.length}): ${added.slice(0, 5).join(', ')}`);
  const scripts = (to.installScripts ?? []).filter((script) => !(from.installScripts ?? []).includes(script));
  if (scripts.length > 0) signals.push(`new install scripts: ${scripts.join(', ')}`);
  if (to.gypfile && !from.gypfile) signals.push('a binding.gyp build appeared');
  if (from.attested && !to.attested) signals.push('provenance dropped');
  if (from.publisher && to.publisher && from.publisher !== to.publisher) {
    signals.push(`publisher changed: ${from.publisher} to ${to.publisher}`);
  }
  return signals;
}

/** Whether a group's targets share what its `agree` asks for. Only moving members are compared. */
export function targetsAgree(group, members) {
  const agree = LOCKSTEP_GROUPS.find((entry) => entry.group === group)?.agree;
  if (!agree) return true;
  return new Set(members.map(({ target }) => target)).size === 1;
}

/** `major` also covers a `^0.x` minor and a `0.0.x` patch, which semver treats as breaking. */
export function changeKind(installed, target) {
  const installedParts = semver.parse(installed);
  const targetParts = semver.parse(target);
  if (installedParts.major !== targetParts.major) return 'major';
  if (installedParts.major === 0 && installedParts.minor !== targetParts.minor) return 'major';
  if (installedParts.major === 0 && installedParts.minor === 0 && installedParts.patch !== targetParts.patch) {
    return 'major';
  }
  const difference = semver.diff(installed, target);
  if (difference === 'prerelease') return 'prerelease';
  return difference !== null && difference.includes('minor') ? 'minor' : 'patch';
}

/**
 * Every registry dependency the manifests declare, one record per package name. A non-registry
 * spec has nothing to upgrade. A name declared in two places reports the lowest installed version,
 * so the older copy is what the move is measured from.
 *
 * @param {Array<{ location: string, manifest: Record<string, unknown> }>} manifests `location` is
 *   the manifest's folder relative to the root, empty for the root
 * @param {Record<string, { version?: string, link?: boolean }>} lockPackages `package-lock.json`'s
 *   `packages` map
 */
export function collectDeclared(manifests, lockPackages) {
  const declared = new Map();
  for (const { location, manifest } of manifests) {
    for (const block of DEPENDENCY_BLOCKS) {
      for (const [name, spec] of Object.entries(manifest[block] ?? {})) {
        const lockEntry = lockPackages[location ? `${location}/node_modules/${name}` : `node_modules/${name}`]
          ?? lockPackages[`node_modules/${name}`];
        if (!lockEntry || lockEntry.link || !lockEntry.version || !semver.validRange(spec)) continue;
        const record = declared.get(name) ?? {
          name, installed: lockEntry.version, pinned: false, runtime: false, locations: [],
        };
        if (semver.lt(lockEntry.version, record.installed)) record.installed = lockEntry.version;
        record.pinned = record.pinned || semver.valid(spec) !== null;
        record.runtime = record.runtime || (location === '' && block === 'dependencies');
        record.locations.push(location || '.');
        declared.set(name, record);
      }
    }
  }
  return [...declared.values()];
}

/** Each conflict's `requirement` leaves out the peer's version, so one the tree has stays one when the peer moves. */
function peerConflicts(plan, peersOf) {
  const conflicts = [];
  for (const [name, version] of Object.entries(plan)) {
    for (const [peer, range] of Object.entries(peersOf(name, version))) {
      if (plan[peer] === undefined || !semver.validRange(range)) continue;
      if (!semver.satisfies(plan[peer], range, { includePrerelease: true })) {
        conflicts.push({ requirement: `${name}@${version} needs ${peer} ${range}`, planned: plan[peer] });
      }
    }
  }
  return conflicts;
}

/**
 * The peer conflicts moving ONE group would add. Each group is checked alone against what is
 * installed, so a blocked major reports against its own group and not against a neighbor's patch,
 * and a conflict the tree already has is not news.
 *
 * @param {Record<string, string>} installed package name to installed version
 * @param {Record<string, string>} groupTargets package name to target version
 * @param {(name: string, version: string) => Record<string, string>} peersOf
 */
export function newPeerConflicts(installed, groupTargets, peersOf) {
  const baseline = new Set(peerConflicts(installed, peersOf).map(({ requirement }) => requirement));
  return peerConflicts({ ...installed, ...groupTargets }, peersOf)
    .filter(({ requirement }) => !baseline.has(requirement))
    .map(({ requirement, planned }) => `${requirement}, planned ${planned}`);
}

function sameVersions(left, right) {
  const leftNames = Object.keys(left);
  return leftNames.length === Object.keys(right).length
    && leftNames.every((name) => left[name] === right[name]);
}

function isBrief(candidate) {
  return typeof candidate === 'object' && candidate !== null
    && candidate.draft !== true
    && typeof candidate.targets === 'object' && candidate.targets !== null
    && typeof candidate.evaluatedAt === 'string' && !Number.isNaN(Date.parse(candidate.evaluatedAt))
    && (candidate.verdict === 'ready' || candidate.verdict === 'blocked');
}

/**
 * What earlier research is worth for a group, given what the registry says today. Research for a
 * version never expires: the release notes for a published version do not change, so only a version
 * moving, or `--refresh`, sends a group back to an agent. A second run costs one inventory.
 *
 *   research  no usable brief: full research.
 *   delta     a brief exists for other versions: read it and cover only the new releases.
 *   recheck   blocked, and what it was waiting on has moved: test the blocker alone.
 *   reuse     same versions: no research.
 *   blocked   same versions, same blocker: no research, reported as blocked.
 *   filed     a board task already carries this brief: confirm it is open.
 */
export function researchState({ brief, targets, watchedVersions, refresh }) {
  if (!isBrief(brief) || refresh) return 'research';
  if (!sameVersions(brief.targets, targets)) return 'delta';
  if (brief.task) return 'filed';
  if (brief.verdict !== 'blocked') return 'reuse';
  const watched = Object.entries(brief.blocker?.blockedOn ?? {});
  return watched.every(([name, version]) => watchedVersions[name] === version) ? 'blocked' : 'recheck';
}

/**
 * What a blocker compares against: the newest release on the line it recorded. Reading `latest` alone
 * misses a fix on a prerelease line, so a recorded beta stays on its beta line.
 */
export function watchedVersion(recorded, { distTags, versions }) {
  if (!semver.valid(recorded)) return distTags.latest;
  return chooseTarget({ installed: recorded, distTags, versions }) ?? recorded;
}

/** A brief marked blocked by a task agent that could not land the group. */
export function withBlocker(brief, { reason, recheck, blockedOn }, now) {
  return {
    ...brief,
    verdict: 'blocked',
    task: null,
    evaluatedAt: new Date(now).toISOString(),
    blocker: { reason, recheck, blockedOn },
  };
}

const KIND_ORDER = ['unhold', 'prerelease', 'patch', 'minor', 'major', 'deprecated'];

function widestKind(members) {
  return members.reduce((widest, member) => (
    KIND_ORDER.indexOf(member.kind) > KIND_ORDER.indexOf(widest) ? member.kind : widest
  ), 'unhold');
}

/**
 * @typedef {object} SdkMapping
 * @property {number | null} installedMajor
 * @property {Record<string, string>} mapping the installed SDK's combined mapping
 * @property {string[]} exclude `expo.install.exclude`
 * @property {{ major: number, mapping: Record<string, string> } | null} next a newer SDK
 *
 * @typedef {object} VersionFacts
 * @property {unknown} [deprecated]
 * @property {Record<string, string>} [peerDependencies]
 * @property {Record<string, string>} [dependencies]
 * @property {string[]} [installScripts]
 * @property {boolean} [gypfile]
 * @property {boolean} [attested]
 * @property {string} [publisher]
 *
 * @typedef {object} Packument
 * @property {Record<string, string>} distTags
 * @property {Record<string, VersionFacts>} versions
 * @property {Record<string, string>} times
 *
 * @typedef {object} DeclaredPackage
 * @property {string} name
 * @property {string} installed
 * @property {boolean} pinned
 * @property {boolean} runtime
 * @property {string[]} locations
 * @property {boolean} [native]
 *
 * @typedef {DeclaredPackage & {
 *   target: string, kind: string, published: string | null, advisory: string | null,
 *   inheritedAdvisory: string | null, deprecated: string | null, signals: string[],
 *   patch: string | null, sdkRange?: string, held?: boolean, holdCanEnd?: boolean,
 *   beyondMapping?: boolean, tracks?: string,
 * }} InventoryMember
 *
 * @typedef {object} InventoryGroup
 * @property {string} group
 * @property {'drift' | 'beyond-mapping' | 'held' | 'next-sdk' | null} sdkRole
 * @property {string} kind
 * @property {boolean} runtime
 * @property {boolean} native
 * @property {boolean} pinned
 * @property {boolean} patched
 * @property {boolean} advisory
 * @property {boolean} signals
 * @property {boolean} targetsDisagree
 * @property {string} research
 * @property {boolean} hasBrief
 * @property {string[]} peerConflicts
 * @property {object | null} blocker
 * @property {object | null} task
 * @property {InventoryMember[]} members
 *
 * @typedef {object} Inventory
 * @property {string} generatedAt
 * @property {{ installed: number | null, next: number | null }} sdk
 * @property {InventoryGroup[]} groups
 * @property {number} currentCount
 * @property {Array<{ name: string, installed: string, newest: string | null }>} firstParty
 */

/**
 * No SDK at all: every package is judged by the registry alone.
 *
 * @type {SdkMapping}
 */
const NO_SDK = { installedMajor: null, mapping: {}, exclude: [], next: null };

/**
 * The report. `declared` comes from collectDeclared (with a `native` flag added per record),
 * `packuments` maps a name to the registry's { distTags, versions, times }, and `briefs` maps a
 * group to its parsed brief. `advisories` maps a name to the severity of an advisory against that
 * package itself. `inheritedAdvisories` is the same for one that reaches a direct dependency from
 * below it, which moving that package may or may not clear. `patches` comes from patchedPackages.
 *
 * `sdk` is `{ installedMajor, mapping, exclude, next }`: the installed SDK's combined mapping, the
 * `expo.install.exclude` list, and `{ major, mapping }` for a newer SDK when `expo`'s npm `latest`
 * has one. Each declared package lands in exactly one of these, by what the SDK says about it:
 *
 *   drift           mapped and not held: moves to the newest release its mapping range accepts.
 *                   All of them share the `expo-sdk` group, which `npx expo install` moves at once.
 *   beyond-mapping  mapped and not held, with a release past the mapping that a newer SDK does not
 *                   cover. Moving to it means a hold, so it is its own group for research to vet.
 *   held            in `expo.install.exclude`: judged by the registry like an unmapped package, with
 *                   `holdCanEnd` when the mapping has caught up and the exclude entry can come out.
 *                   With nothing newer and the hold able to end, it is still listed, as `unhold`.
 *   (none)          not mapped: the registry alone decides, as on the desktop.
 *
 * A package can be in `expo-sdk` and a beyond-mapping group at once (drift now, then a hold). A
 * newer SDK adds one more group, every declared package its mapping moves, held ones included,
 * because an SDK upgrade is where a hold is vetted again. The drift group stays beside it, so the
 * required gate can go green even if the SDK phase is dropped.
 *
 * `packuments` may also hold packages nothing declares, read because a brief's blocker waits on
 * them. Those only supply the blocker check.
 *
 * A package whose installed or latest version is deprecated with nothing to move to is reported as
 * a group of kind `deprecated`, targeted at what is installed so its brief still caches.
 *
 * @param {{
 *   declared: DeclaredPackage[], packuments: Record<string, Packument>,
 *   advisories: Record<string, string>, inheritedAdvisories?: Record<string, string>,
 *   briefs: Record<string, object>, now: number, refresh: boolean, sdk?: SdkMapping,
 *   patches?: Record<string, { file: string, version: string }>,
 * }} options
 * @returns {Inventory}
 */
export function buildInventory({
  declared, packuments, advisories, inheritedAdvisories = {}, briefs, now, refresh,
  sdk = NO_SDK, patches = {},
}) {
  const installedVersions = Object.fromEntries(declared.map(({ name, installed }) => [name, installed]));
  const peersOf = (name, version) => packuments[name]?.versions[version]?.peerDependencies ?? {};
  const watchedVersions = (brief) => Object.fromEntries(
    Object.entries(brief?.blocker?.blockedOn ?? {}).flatMap(([name, recorded]) => (
      packuments[name] ? [[name, watchedVersion(recorded, packuments[name])]] : []
    )),
  );
  const movable = new Map();
  const firstParty = [];
  const trackingRecords = [];
  let currentCount = 0;

  function member(record, target, kind, extra = {}) {
    const packument = packuments[record.name];
    const deprecated = packument.versions[record.installed]?.deprecated
      ?? packument.versions[packument.distTags.latest]?.deprecated
      ?? null;
    return {
      ...record,
      target,
      kind,
      published: packument.times[target] ?? null,
      advisory: advisories[record.name] ?? null,
      inheritedAdvisory: inheritedAdvisories[record.name] ?? null,
      deprecated: deprecated ? String(deprecated).slice(0, 200) : null,
      signals: supplyChainSignals(packument.versions[record.installed], packument.versions[target]),
      patch: patches[record.name]?.file ?? null,
      ...extra,
    };
  }

  function addMember(group, sdkRole, entry) {
    const existing = movable.get(group) ?? { sdkRole, members: [] };
    existing.members.push(entry);
    movable.set(group, existing);
  }

  const kindTo = (record, target) => changeKind(record.installed, target);

  for (const record of declared) {
    const packument = packuments[record.name];
    if (!packument) continue;
    const newest = chooseTarget({
      installed: record.installed,
      distTags: packument.distTags,
      versions: packument.versions,
    });
    if (FIRST_PARTY.test(record.name)) {
      firstParty.push({ name: record.name, installed: record.installed, newest });
      continue;
    }
    if (TRACKS[record.name]) {
      trackingRecords.push(record);
      continue;
    }
    const range = sdk.mapping[record.name] ?? null;
    const held = sdk.exclude.includes(record.name);
    const reach = range ? newestInRange(packument, range) : null;
    let moves = false;

    if (range && !held) {
      if (reach && semver.gt(reach, record.installed)) {
        addMember(DRIFT_GROUP, 'drift', member(record, reach, kindTo(record, reach), { sdkRange: range }));
        moves = true;
      }
      const nextRange = sdk.next?.mapping[record.name];
      const coveredByNextSdk = newest !== null && nextRange !== undefined && semver.satisfies(newest, nextRange);
      if (newest && semver.gt(newest, reach ?? record.installed) && !coveredByNextSdk) {
        addMember(groupOf(record.name), 'beyond-mapping', member(record, newest, kindTo(record, newest), {
          sdkRange: range, beyondMapping: true,
        }));
        moves = true;
      }
    } else if (range && held) {
      const holdCanEnd = reach !== null && semver.gte(reach, record.installed);
      const target = newest ?? (holdCanEnd ? reach : null);
      if (target) {
        const kind = semver.gt(target, record.installed) ? kindTo(record, target) : 'unhold';
        addMember(groupOf(record.name), 'held', member(record, target, kind, { sdkRange: range, held: true, holdCanEnd }));
        moves = true;
      }
    } else if (newest) {
      addMember(groupOf(record.name), null, member(record, newest, kindTo(record, newest)));
      moves = true;
    }

    if (!moves) {
      const deprecated = packument.versions[record.installed]?.deprecated
        ?? packument.versions[packument.distTags.latest]?.deprecated;
      if (deprecated) {
        addMember(groupOf(record.name), null, member(record, record.installed, 'deprecated'));
      } else {
        currentCount += 1;
      }
    }
  }

  if (sdk.next) {
    const group = nextSdkGroup(sdk.next.major);
    for (const record of declared) {
      const packument = packuments[record.name];
      const nextRange = sdk.next.mapping[record.name];
      if (!packument || !nextRange || FIRST_PARTY.test(record.name) || TRACKS[record.name]) continue;
      const target = newestInRange(packument, nextRange);
      if (!target || !semver.gt(target, record.installed)) continue;
      const held = sdk.exclude.includes(record.name);
      addMember(group, 'next-sdk', member(record, target, kindTo(record, target), {
        sdkRange: nextRange, ...(held ? { held: true } : {}),
      }));
    }
  }

  for (const record of trackingRecords) {
    const trackedName = TRACKS[record.name];
    const packument = packuments[record.name];
    const versionFor = (trackedVersion) => {
      if (packument.versions[trackedVersion]) return trackedVersion;
      return newestInRange(packument, `~${semver.major(trackedVersion)}.${semver.minor(trackedVersion)}.0`);
    };
    let tracked = false;
    for (const [group, { sdkRole, members }] of movable) {
      const trackedMember = members.find(({ name }) => name === trackedName);
      if (!trackedMember) continue;
      const target = versionFor(trackedMember.target);
      if (target && semver.gt(target, record.installed)) {
        addMember(group, sdkRole, member(record, target, kindTo(record, target), { tracks: trackedName }));
        tracked = true;
      }
    }
    const trackedInstalled = installedVersions[trackedName];
    const catchUp = !tracked && trackedInstalled ? versionFor(trackedInstalled) : null;
    if (catchUp && semver.gt(catchUp, record.installed)) {
      addMember(groupOf(record.name), null, member(record, catchUp, kindTo(record, catchUp), { tracks: trackedName }));
    } else if (!tracked) {
      currentCount += 1;
    }
  }

  const groups = [...movable.entries()].map(([group, { sdkRole, members }]) => {
    const targets = Object.fromEntries(members.map(({ name, target }) => [name, target]));
    const brief = briefs[group];
    return {
      group,
      sdkRole,
      kind: widestKind(members),
      runtime: members.some(({ runtime }) => runtime),
      native: members.some(({ native }) => native === true),
      pinned: members.some(({ pinned }) => pinned),
      patched: members.some(({ patch }) => patch !== null),
      advisory: members.some(({ advisory }) => advisory !== null),
      signals: members.some(({ signals }) => signals.length > 0),
      targetsDisagree: !targetsAgree(group, members),
      research: researchState({ brief, targets, watchedVersions: watchedVersions(brief), refresh }),
      hasBrief: brief !== undefined,
      peerConflicts: newPeerConflicts(installedVersions, targets, peersOf),
      blocker: brief?.blocker ?? null,
      task: brief?.task ?? null,
      members,
    };
  });

  return {
    generatedAt: new Date(now).toISOString(),
    sdk: { installed: sdk.installedMajor, next: sdk.next?.major ?? null },
    groups: groups.sort((left, right) => left.group.localeCompare(right.group)),
    currentCount,
    firstParty,
  };
}

/**
 * What moved between two lockfiles' `packages` maps. Nobody reads a dozen lockfile diffs, so this
 * reports the things `apply.md` asks of each one: an unplanned package and a lost install script
 * flag. A flag lost at an UNCHANGED version is the `npm update` bug that strips it with no other
 * sign; a flag a new version dropped can be a real change, so it is reported and left to a reader.
 */
export function diffLockfile(before, after) {
  const shortName = (key) => key.replace(/^node_modules\//, '');
  const changed = [];
  const added = [];
  const installScriptFlips = [];
  for (const [key, entry] of Object.entries(after)) {
    if (key === '') continue;
    const previous = before[key];
    if (!previous) {
      added.push({ name: shortName(key), version: entry.version, hasInstallScript: Boolean(entry.hasInstallScript) });
      continue;
    }
    if (previous.version !== entry.version) {
      changed.push({ name: shortName(key), from: previous.version, to: entry.version });
    }
    if (Boolean(previous.hasInstallScript) !== Boolean(entry.hasInstallScript)) {
      installScriptFlips.push({
        name: shortName(key),
        had: Boolean(previous.hasInstallScript),
        versionChanged: previous.version !== entry.version,
      });
    }
  }
  const removed = Object.entries(before)
    .filter(([key]) => key !== '' && !after[key])
    .map(([key, entry]) => ({ name: shortName(key), version: entry.version }));
  return { changed, added, removed, installScriptFlips };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function readPackument(name) {
  const document = await fetchJson(`${REGISTRY_URL}/${name.replace('/', '%2F')}`);
  const versions = {};
  for (const [version, manifest] of Object.entries(document.versions ?? {})) {
    versions[version] = {
      deprecated: manifest.deprecated,
      peerDependencies: manifest.peerDependencies,
      dependencies: manifest.dependencies,
      installScripts: INSTALL_SCRIPTS.filter((script) => manifest.scripts?.[script]),
      gypfile: manifest.gypfile === true,
      attested: Boolean(manifest.dist?.attestations),
      publisher: manifest._npmUser?.name,
    };
  }
  return { distTags: document['dist-tags'] ?? {}, versions, times: document.time ?? {} };
}

async function readPackuments(names) {
  const packuments = {};
  const errors = [];
  const queue = [...names];
  async function work() {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      try {
        packuments[name] = await readPackument(name);
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: REGISTRY_CONCURRENCY }, work));
  return { packuments, errors };
}

/**
 * The installed SDK's mapping and, when `expo`'s npm `latest` is a newer major, that SDK's. The
 * newer SDK is read off npm rather than the versions endpoint's keys, which can list one still in
 * beta. The installed SDK's native-modules list falls back to the copy inside `node_modules/expo`,
 * as the Expo CLI does offline; a newer SDK has no such copy, so an unreachable mapping leaves it
 * out and says so in `nextUnavailable`.
 *
 * `incomplete` names what could not be read for the INSTALLED SDK. Without the versions endpoint,
 * `react`, `react-native`, `typescript`, `jest` and `@types/*` look unmapped, and the registry would
 * plan them past the required gate, so the skill stops on it.
 */
async function readSdk(declared, packuments, exclude) {
  const errors = [];
  const incomplete = [];
  const expoRecord = declared.find(({ name }) => name === 'expo');
  if (!expoRecord || !packuments.expo) {
    return { sdk: { ...NO_SDK, exclude }, errors, incomplete: ['expo is not installed or the registry did not answer for it'], nextUnavailable: null };
  }
  const installedMajor = semver.major(expoRecord.installed);
  let sdkVersions = {};
  try {
    sdkVersions = (await fetchJson(`${EXPO_API_URL}/versions/latest`)).data?.sdkVersions ?? {};
  } catch (error) {
    errors.push(`expo versions: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!sdkVersions[`${installedMajor}.0.0`]) incomplete.push(`no versions entry for SDK ${installedMajor}`);
  async function nativeModulesFor(major, bundledFallback) {
    try {
      return (await fetchJson(`${EXPO_API_URL}/sdks/${major}.0.0/native-modules`)).data ?? [];
    } catch (error) {
      errors.push(`expo sdk ${major} native modules: ${error instanceof Error ? error.message : String(error)}`);
      if (!bundledFallback) return [];
      const bundled = readJson(path.join(REPOSITORY_ROOT, 'node_modules', 'expo', 'bundledNativeModules.json'));
      return Object.entries(bundled).map(([npmPackage, versionRange]) => ({ npmPackage, versionRange }));
    }
  }
  const newestExpo = chooseTarget({
    installed: expoRecord.installed,
    distTags: packuments.expo.distTags,
    versions: packuments.expo.versions,
  });
  const nextMajor = newestExpo !== null && semver.major(newestExpo) > installedMajor ? semver.major(newestExpo) : null;
  const [nativeModules, nextNativeModules] = await Promise.all([
    nativeModulesFor(installedMajor, true),
    nextMajor === null ? [] : nativeModulesFor(nextMajor, false),
  ]);
  if (nativeModules.length === 0) incomplete.push(`no native-modules list for SDK ${installedMajor}`);
  const mapping = combineMapping(nativeModules, sdkVersions[`${installedMajor}.0.0`]);
  // The SDK package itself must never fall through to the registry, which would plan it a major.
  mapping.expo ??= `~${expoRecord.installed}`;
  const nextMapping = nextMajor === null
    ? null
    : nextSdkMapping(nextNativeModules, sdkVersions[`${nextMajor}.0.0`], newestExpo);
  const next = nextMapping ? { major: nextMajor, mapping: nextMapping } : null;
  return {
    sdk: { installedMajor, mapping, exclude, next },
    errors,
    incomplete,
    nextUnavailable: nextMajor !== null && next === null ? nextMajor : null,
  };
}

/**
 * Splits `npm audit` for the report. A `via` entry that is an object is an advisory against the
 * package itself. A string names the dependency it reached this package through, and `isDirect`
 * is true for that package all the same, so `isDirect` alone would blame a package for an issue
 * deep below it.
 *
 * @param {{ vulnerabilities?: Record<string, { name: string, severity: string, isDirect: boolean, via: unknown[] }> }} report
 */
export function splitAudit(report) {
  const advisories = {};
  const inheritedAdvisories = {};
  let transitiveCount = 0;
  for (const { name, severity, isDirect, via } of Object.values(report.vulnerabilities ?? {})) {
    if (!isDirect) transitiveCount += 1;
    else if (via.some((entry) => typeof entry === 'object')) advisories[name] = severity;
    else inheritedAdvisories[name] = severity;
  }
  return { advisories, inheritedAdvisories, transitiveCount };
}

/** npm audit exits 1 when it finds anything, so its report is read from either outcome. */
async function readAudit() {
  let output;
  try {
    ({ stdout: output } = await execAsync('npm audit --json', {
      cwd: REPOSITORY_ROOT,
      maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
    }));
  } catch (error) {
    output = error.stdout;
  }
  try {
    return splitAudit(JSON.parse(output));
  } catch {
    return { advisories: {}, inheritedAdvisories: {}, transitiveCount: null };
  }
}

async function cacheDirectory() {
  const { stdout } = await execFileAsync(
    'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPOSITORY_ROOT },
  );
  return path.join(path.dirname(stdout.trim()), CACHE_FOLDER);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readBriefs(briefsDirectory) {
  const briefs = {};
  if (!fs.existsSync(briefsDirectory)) return briefs;
  for (const fileName of fs.readdirSync(briefsDirectory)) {
    if (!fileName.endsWith('.json')) continue;
    try {
      briefs[fileName.slice(0, -'.json'.length)] = readJson(path.join(briefsDirectory, fileName));
    } catch {
      // An unreadable brief is the same as no brief: the group gets researched again.
    }
  }
  return briefs;
}

function readPatches() {
  const patchesDirectory = path.join(REPOSITORY_ROOT, 'patches');
  return fs.existsSync(patchesDirectory) ? patchedPackages(fs.readdirSync(patchesDirectory)) : {};
}

/**
 * Whether an installed package carries native code, so a phase that moves it needs a release build
 * launched: the AGP 9 R8 crash killed a release build at launch with every other check green.
 */
function isNativePackage(name) {
  const packageDirectory = path.join(REPOSITORY_ROOT, 'node_modules', name);
  return ['android', 'ios', 'expo-module.config.json'].some((entry) => fs.existsSync(path.join(packageDirectory, entry)));
}

async function runInventory(args) {
  const manifest = readJson(path.join(REPOSITORY_ROOT, 'package.json'));
  const lockfile = readJson(path.join(REPOSITORY_ROOT, 'package-lock.json'));
  const declared = collectDeclared([{ location: '', manifest }], lockfile.packages)
    .map((record) => ({ ...record, native: isNativePackage(record.name) }));
  const patches = readPatches();
  const cacheDir = await cacheDirectory();
  const briefs = readBriefs(path.join(cacheDir, 'briefs'));
  const watchedNames = Object.values(briefs).flatMap((brief) => Object.keys(brief?.blocker?.blockedOn ?? {}));
  const [{ packuments, errors }, { advisories, inheritedAdvisories, transitiveCount }] = await Promise.all([
    readPackuments([...new Set([...declared.map(({ name }) => name), ...watchedNames])]),
    readAudit(),
  ]);
  const { sdk, errors: sdkErrors, incomplete, nextUnavailable } = await readSdk(
    declared, packuments, manifest.expo?.install?.exclude ?? [],
  );
  const inventory = buildInventory({
    declared,
    packuments,
    advisories,
    inheritedAdvisories,
    briefs,
    now: Date.now(),
    refresh: args.includes('--refresh'),
    sdk,
    patches,
  });
  // Absent means no: a null, false or empty field is dropped, so the report stays small in a transcript.
  const dropEmpty = (key, value) => (
    value === null || value === false || (Array.isArray(value) && value.length === 0) ? undefined : value
  );
  console.log(JSON.stringify({
    cacheDir,
    ...inventory,
    sdk: { ...inventory.sdk, incomplete, nextUnavailable },
    stalePatches: stalePatches(patches, lockfile.packages),
    transitiveAdvisories: transitiveCount,
    errors: [...errors, ...sdkErrors],
  }, dropEmpty));
}

function readTextOption(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function runRecordBlocker([group, ...args]) {
  const reason = readTextOption(args, '--reason');
  const recheck = readTextOption(args, '--recheck');
  if (!group || !reason || !recheck) {
    console.error('usage: node scripts/upgrade-deps.mjs record-blocker <group> --reason <text> --recheck <text>');
    process.exit(2);
  }
  const blockedOn = {};
  args.forEach((argument, index) => {
    if (argument !== '--blocked-on') return;
    const pair = args[index + 1] ?? '';
    const separator = pair.lastIndexOf('=');
    if (separator > 0) blockedOn[pair.slice(0, separator)] = pair.slice(separator + 1);
  });
  const briefPath = path.join(await cacheDirectory(), 'briefs', `${group}.json`);
  if (!fs.existsSync(briefPath)) {
    console.error(`No brief for ${group} at ${briefPath}. Put the blocker in your report instead.`);
    process.exit(2);
  }
  const blocked = withBlocker(readJson(briefPath), { reason, recheck, blockedOn }, Date.now());
  fs.writeFileSync(briefPath, `${JSON.stringify(blocked, null, 2)}\n`);
  console.log(`Recorded ${group} as blocked.`);
}

async function runLockdiff(expected) {
  const { stdout } = await execFileAsync('git', ['show', 'HEAD:package-lock.json'], {
    cwd: REPOSITORY_ROOT,
    maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
  });
  const before = JSON.parse(stdout).packages;
  const after = readJson(path.join(REPOSITORY_ROOT, 'package-lock.json')).packages;
  const diff = diffLockfile(before, after);
  const print = (label, lines) => {
    console.log(`${label} (${lines.length})`);
    for (const line of lines) console.log(`  ${line}`);
  };
  print('changed', diff.changed.map(({ name, from, to }) => `${name} ${from} -> ${to}`));
  print('added', diff.added.map(({ name, version, hasInstallScript }) => (
    `${name}@${version}${hasInstallScript ? ' HAS INSTALL SCRIPT' : ''}`
  )));
  print('removed', diff.removed.map(({ name, version }) => `${name}@${version}`));
  print('install script flag changed', diff.installScriptFlips.map(({ name, had, versionChanged }) => (
    `${name}: ${had ? 'lost it' : 'gained it'}${versionChanged ? ' with a new version' : ' AT AN UNCHANGED VERSION'}`
  )));
  const stale = stalePatches(readPatches(), after);
  print('patches that no longer match the lockfile', stale.map(({ file, resolved }) => (
    `${file}: lockfile resolves ${resolved ?? 'nothing'}`
  )));
  const mismatches = expected.filter((pair) => {
    const separator = pair.lastIndexOf('@');
    const resolved = after[`node_modules/${pair.slice(0, separator)}`]?.version;
    const wanted = pair.slice(separator + 1);
    console.log(`${resolved === wanted ? 'OK ' : 'BAD'} ${pair.slice(0, separator)}: wanted ${wanted}, resolved ${resolved}`);
    return resolved !== wanted;
  });
  const strippedFlag = diff.installScriptFlips.some(({ had, versionChanged }) => had && !versionChanged);
  if (mismatches.length > 0 || strippedFlag || stale.length > 0) process.exitCode = 1;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'inventory') {
    await runInventory(args);
  } else if (command === 'record-blocker') {
    await runRecordBlocker(args);
  } else if (command === 'lockdiff') {
    await runLockdiff(args);
  } else if (command === 'cache-dir') {
    console.log(await cacheDirectory());
  } else {
    console.error('usage: node scripts/upgrade-deps.mjs inventory|record-blocker|lockdiff|cache-dir');
    process.exit(2);
  }
}

if (isEntrypoint(import.meta.url)) {
  await main();
}
