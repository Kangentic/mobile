#!/usr/bin/env node
/**
 * Checks main against Expo's LIVE SDK version list, for .github/workflows/expo-drift.yml.
 *
 * The required `Native config (prebuild)` check runs `npx expo install --check` with
 * EXPO_OFFLINE, so it compares the lockfile only with the installed SDK's own
 * expo/bundledNativeModules.json and cannot go red because Expo moved its list on its
 * server. This is the other half: it runs the same check ONLINE, once a day, and
 * keeps ONE open issue (label `expo-drift`) while main is behind the live list.
 *
 * It runs `npx expo install --check --json` (stdout is `{ dependencies, upToDate }`,
 * read from @expo/cli's install/checkPackages.js) and classifies the result:
 *
 *   current    up to date. Closes any open drift issue with a comment.
 *   drift      behind. Creates the issue, or rewrites the open one's body, and the
 *              job fails so the scheduled-run failure notification goes out.
 *   degraded   the CLI could not reach Expo and fell back to the local list. It says
 *              so on stderr and nothing else, so a green result then proves nothing.
 *   error      anything else, such as no JSON at all.
 *
 * `degraded` and `error` fail the job and leave the issue alone, so an Expo outage
 * can neither close a real drift issue nor open a false one.
 *
 * THE ISSUE IS PUBLIC. Its body holds package names and versions, the run link and
 * the fix command, and nothing else.
 *
 * Usage: node scripts/checkExpoDrift.mjs
 * Environment:
 *   WRITE_ISSUE          `true` to create, update or close the issue. The workflow sets
 *                        it only on the default branch, so a dispatch elsewhere reports
 *                        to the job summary alone.
 *   GH_TOKEN, GH_REPO    for `gh`, when WRITE_ISSUE is true.
 *   RUN_URL              this run's link, for the issue.
 *   GITHUB_STEP_SUMMARY  the job summary, when set.
 * Exit 0 when main is current, 1 otherwise.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { isEntrypoint } from './lib/is-entrypoint.mjs';
import { onlineEnvironment } from './lib/onlineEnvironment.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DRIFT_LABEL = 'expo-drift';
export const DRIFT_ISSUE_TITLE = "main is behind Expo's live SDK version list";
export const CHECK_COMMAND = 'npx expo install --check --json';

/**
 * What the CLI prints to stderr when it did NOT compare against the live list.
 * The first is getVersionedNativeModulesAsync's fallback when the native-modules
 * endpoint cannot be reached; the second is getRemoteVersionsForSdkAsync under
 * EXPO_OFFLINE, which this script removes but a runner could still set.
 */
export const DEGRADED_MARKERS = ['Unable to reach well-known versions endpoint', 'offline-mode'];

/**
 * @typedef {{ packageName: string, packageType?: string, expectedVersionOrRange: string, actualVersion: string }} DriftedDependency
 * @typedef {{ status: 'current' }
 *   | { status: 'drift', dependencies: DriftedDependency[] }
 *   | { status: 'degraded' | 'error', reason: string }} CheckResult
 */

/** @param {unknown} value */
function isDriftedDependency(value) {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof candidate.packageName === 'string' &&
    typeof candidate.expectedVersionOrRange === 'string' &&
    typeof candidate.actualVersion === 'string'
  );
}

/**
 * @param {{ stdout: string, stderr: string, exitCode: number }} output
 * @returns {CheckResult}
 */
export function classifyCheck({ stdout, stderr, exitCode }) {
  const marker = DEGRADED_MARKERS.find((candidate) => stderr.includes(candidate));
  if (marker !== undefined) {
    return { status: 'degraded', reason: `the CLI did not read Expo's live list (stderr: "${marker}")` };
  }

  const jsonStart = stdout.indexOf('{');
  const jsonEnd = stdout.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd < jsonStart) {
    return { status: 'error', reason: `no JSON on stdout (exit code ${exitCode})` };
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
  } catch {
    return { status: 'error', reason: `stdout is not valid JSON (exit code ${exitCode})` };
  }
  const report = /** @type {{ upToDate?: unknown, dependencies?: unknown }} */ (parsed ?? {});
  if (typeof report.upToDate !== 'boolean' || !Array.isArray(report.dependencies)) {
    return { status: 'error', reason: 'the JSON has no `upToDate` and `dependencies`' };
  }
  if (!report.dependencies.every(isDriftedDependency)) {
    return { status: 'error', reason: 'a dependency in the JSON has no name or versions' };
  }
  const dependencies = /** @type {DriftedDependency[]} */ (report.dependencies);

  if (!report.upToDate && dependencies.length > 0) return { status: 'drift', dependencies };
  if (report.upToDate && dependencies.length === 0 && exitCode === 0) return { status: 'current' };
  return {
    status: 'error',
    reason: `upToDate is ${report.upToDate} with ${dependencies.length} dependencies and exit code ${exitCode}`,
  };
}

/**
 * @param {DriftedDependency[]} dependencies
 * @returns {DriftedDependency[]} a copy, sorted by package name
 */
function sortedByPackageName(dependencies) {
  return [...dependencies].sort((first, second) => first.packageName.localeCompare(second.packageName));
}

/**
 * A value as a table cell: a code span, with the pipe a version range can hold
 * (`^1 || ^2`) escaped and any backtick dropped so the span cannot be closed early.
 *
 * @param {string} value
 */
export function tableCell(value) {
  return `\`${value.replaceAll('`', '').replaceAll('|', '\\|')}\``;
}

/**
 * The issue body: the table, the run link and the fix command, nothing else.
 *
 * @param {{ dependencies: DriftedDependency[], runUrl: string }} input
 */
export function driftIssueBody({ dependencies, runUrl }) {
  const rows = sortedByPackageName(dependencies).map(
    ({ packageName, actualVersion, expectedVersionOrRange }) =>
      `| ${tableCell(packageName)} | ${tableCell(actualVersion)} | ${tableCell(expectedVersionOrRange)} |`
  );
  return [
    "`npx expo install --check`, against Expo's live SDK version list, finds main behind it:",
    '',
    '| Package | main has | Expo expects |',
    '|---|---|---|',
    ...rows,
    '',
    `Found by ${runUrl === '' ? 'the scheduled check' : `[this run](${runUrl})`}. The daily check rewrites this body while the drift lasts and closes the issue once main is current.`,
    '',
    'The fix, in a fresh worktree off `origin/main` with its own `npm ci` (never a task worktree, never over a `node_modules` junction):',
    '',
    '```',
    'git fetch origin',
    'git worktree add --detach <a folder outside the main checkout> origin/main',
    'cd <that folder>',
    'npm ci',
    'node scripts/fixExpoDrift.mjs',
    '```',
    '',
    'Then commit the result as its own `chore(deps)` commit, on its own branch, and open a pull request.',
    '',
  ].join('\n');
}

/**
 * @typedef {{ kind: 'create' }
 *   | { kind: 'update', issueNumber: number }
 *   | { kind: 'close', issueNumbers: number[] }
 *   | { kind: 'none' }} IssueAction
 */

/**
 * What to do with the drift issue. Only `drift` and `current` touch it: an outage
 * or a broken run must not close a real drift issue or open a false one.
 *
 * @param {CheckResult['status']} status
 * @param {number[]} openIssueNumbers the open issues carrying the label
 * @returns {IssueAction}
 */
export function planIssueAction(status, openIssueNumbers) {
  const sorted = [...openIssueNumbers].sort((first, second) => first - second);
  if (status === 'drift') {
    return sorted.length === 0 ? { kind: 'create' } : { kind: 'update', issueNumber: sorted[0] };
  }
  if (status === 'current' && sorted.length > 0) return { kind: 'close', issueNumbers: sorted };
  return { kind: 'none' };
}

/**
 * The job's exit code. The failed scheduled run is the only notification drift sends,
 * so only `current` passes: drift, a degraded run and an error all fail.
 *
 * @param {CheckResult['status']} status
 * @returns {0 | 1}
 */
export function exitCodeFor(status) {
  return status === 'current' ? 0 : 1;
}

/**
 * Whether this run may touch the drift issue: only on a definite answer, because an
 * outage must neither close a real issue nor open a false one (and reconcileIssue
 * writes the label before it decides anything), and only where the workflow set
 * WRITE_ISSUE to the string `true`, which it does on main alone.
 *
 * @param {CheckResult['status']} status
 * @param {string | undefined} writeIssueSetting the WRITE_ISSUE environment variable
 */
export function mayWriteIssue(status, writeIssueSetting) {
  return (status === 'drift' || status === 'current') && writeIssueSetting === 'true';
}

/**
 * @param {CheckResult} result
 * @returns {string}
 */
export function summaryText(result) {
  if (result.status === 'current') return "**Expo's live SDK version list:** main is current.\n";
  if (result.status === 'drift') {
    const lines = sortedByPackageName(result.dependencies).map(
      ({ packageName, actualVersion, expectedVersionOrRange }) =>
        `- ${tableCell(packageName)} ${tableCell(actualVersion)}, expects ${tableCell(expectedVersionOrRange)}`
    );
    return [`**Expo's live SDK version list:** main is behind on ${result.dependencies.length} package(s).`, '', ...lines, ''].join('\n');
  }
  return `**Expo's live SDK version list:** not checked, because ${result.reason}.\n`;
}

/**
 * @param {string[]} commandArguments
 * @returns {string}
 */
function runGh(commandArguments) {
  return execFileSync('gh', commandArguments, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/**
 * @param {CheckResult} result
 * @param {string} runUrl
 */
function reconcileIssue(result, runUrl) {
  // First, and on every run: `gh issue create --label` fails on a label that does
  // not exist, and listing by a missing label must not be what decides whether an
  // issue gets opened. `--force` makes it idempotent.
  runGh([
    'label', 'create', DRIFT_LABEL,
    '--color', 'D93F0B',
    '--description', "main is behind Expo's live SDK version list",
    '--force',
  ]);
  const listed = JSON.parse(
    runGh(['issue', 'list', '--label', DRIFT_LABEL, '--state', 'open', '--json', 'number', '--limit', '20'])
  );
  const openIssueNumbers = /** @type {{ number: number }[]} */ (listed).map((issue) => issue.number);
  const action = planIssueAction(result.status, openIssueNumbers);

  if (action.kind === 'none') {
    process.stdout.write('No drift issue to change.\n');
    return;
  }
  if (action.kind === 'close') {
    const comment = `The daily check finds main current with Expo's live SDK version list${runUrl === '' ? '' : ` ([run](${runUrl}))`}, so this is closed.`;
    for (const issueNumber of action.issueNumbers) {
      runGh(['issue', 'close', String(issueNumber), '--comment', comment]);
      process.stdout.write(`Closed drift issue #${issueNumber}.\n`);
    }
    return;
  }
  if (result.status !== 'drift') return;

  const bodyDirectory = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? tmpdir(), 'expo-drift-'));
  const bodyPath = path.join(bodyDirectory, 'issue-body.md');
  writeFileSync(bodyPath, driftIssueBody({ dependencies: result.dependencies, runUrl }));

  if (action.kind === 'update') {
    runGh(['issue', 'edit', String(action.issueNumber), '--body-file', bodyPath]);
    process.stdout.write(`Updated drift issue #${action.issueNumber}.\n`);
    return;
  }
  const created = runGh(['issue', 'create', '--title', DRIFT_ISSUE_TITLE, '--label', DRIFT_LABEL, '--body-file', bodyPath]);
  process.stdout.write(`Opened drift issue: ${created.trim()}\n`);
}

/** @returns {number} the exit code */
function main() {
  process.stdout.write(`> ${CHECK_COMMAND}\n`);
  const check = spawnSync(CHECK_COMMAND, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: onlineEnvironment(process.env),
    maxBuffer: 16 * 1024 * 1024,
    shell: true,
  });
  const stdout = check.stdout ?? '';
  const stderr = check.stderr ?? '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  const result = classifyCheck({ stdout, stderr, exitCode: check.status ?? 1 });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryText(result));

  if (mayWriteIssue(result.status, process.env.WRITE_ISSUE)) {
    reconcileIssue(result, process.env.RUN_URL ?? '');
  } else if (result.status === 'drift' || result.status === 'current') {
    process.stdout.write('WRITE_ISSUE is not true (a run off the default branch), so the drift issue is left alone.\n');
  }

  if (result.status === 'current') {
    process.stdout.write("main is current with Expo's live SDK version list.\n");
  } else if (result.status === 'drift') {
    process.stdout.write(
      `::error::main is behind Expo's live SDK version list on ${result.dependencies.length} package(s). The fix is node scripts/fixExpoDrift.mjs, in a fresh worktree off origin/main.\n`
    );
  } else {
    process.stdout.write(`::error::Expo's live SDK version list was not checked: ${result.reason}. The drift issue was left alone.\n`);
  }
  return exitCodeFor(result.status);
}

if (isEntrypoint(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`checkExpoDrift: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
