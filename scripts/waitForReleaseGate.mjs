#!/usr/bin/env node
/**
 * Waits on one GitHub Actions run until it has a pending deployment gate, or it
 * completes, then prints what it found and exits 0. /release runs it in the
 * background between dispatching a build and approving its store gates, so the
 * session is woken once per gate, when there is something to act on. It exits
 * at the first pending gate, so a run with two gates needs it started twice.
 *
 * READ-ONLY by construction: the only calls are GETs of the run, its jobs, and
 * its pending_deployments, through `gh api` with no -X and no fields. It never
 * approves, rejects, cancels, re-runs or dispatches anything; approving a gate
 * stays a separate, explicit `gh api -X POST` that /release makes itself. Keep
 * it that way: it is what would let an autoMode.allow rule in
 * .claude/settings.json name this script by path. No such rule exists yet, so
 * auto mode judges each run of it like any other command.
 *
 * Usage:
 *   node scripts/waitForReleaseGate.mjs <run id> [interval seconds, at least 10, default 30]
 *
 * Output:
 *   GATE run=<id> environment=<name> environmentId=<id> canApprove=<bool>
 *     one line per pending gate, exit 0
 *   RUN-COMPLETED run=<id> conclusion=<conclusion>
 *     then one `JOB <name>: <status>/<conclusion>` line per job, exit 0
 *   POLL-FAILED run=<id> after <n> failed polls in a row: <last error>
 *     exit 1, when `gh` keeps failing (signed out, a run id that does not exist)
 */
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { isEntrypoint } from './lib/is-entrypoint.mjs';

const REPOSITORY = 'Kangentic/mobile';

export const MINIMUM_INTERVAL_SECONDS = 10;
export const MAXIMUM_CONSECUTIVE_FAILURES = 10;

const USAGE = `Usage: node scripts/waitForReleaseGate.mjs <run id> [interval seconds, at least ${MINIMUM_INTERVAL_SECONDS}]`;

/**
 * What one poll found: the lines to print and whether waiting is over. Pure, so
 * tests/unit/waitForReleaseGate.test.ts can drive it without a network.
 *
 * @param {{ pending: unknown, run: { status?: string, conclusion?: string | null } | null, jobs: Array<{ name?: string, status?: string, conclusion?: string | null }> }} snapshot
 * @param {string} runId
 * @returns {{ done: boolean, lines: string[] }}
 */
export function describePoll(snapshot, runId) {
  const pending = Array.isArray(snapshot.pending) ? snapshot.pending : [];
  if (pending.length > 0) {
    return {
      done: true,
      lines: pending.map(
        (deployment) =>
          `GATE run=${runId} environment=${deployment.environment?.name} ` +
          `environmentId=${deployment.environment?.id} canApprove=${deployment.current_user_can_approve}`
      ),
    };
  }
  if (snapshot.run?.status === 'completed') {
    return {
      done: true,
      lines: [
        `RUN-COMPLETED run=${runId} conclusion=${snapshot.run.conclusion}`,
        ...snapshot.jobs.map((job) => `JOB ${job.name}: ${job.status}/${job.conclusion}`),
      ],
    };
  }
  return { done: false, lines: [] };
}

/**
 * The command line, checked as strictly for the interval as for the run id:
 * timers clamp NaN, zero and negative delays to 1 ms, so `abc` or `0` would turn
 * the wait into back-to-back `gh api` calls against the rate limit.
 *
 * @param {string[]} argv
 * @returns {{ runId: string, intervalMilliseconds: number }}
 */
export function parseArguments(argv) {
  const [runId, intervalArgument = '30'] = argv;
  if (
    !/^\d+$/.test(runId ?? '') ||
    !/^\d+$/.test(intervalArgument) ||
    Number(intervalArgument) < MINIMUM_INTERVAL_SECONDS
  ) {
    throw new Error(USAGE);
  }
  return { runId, intervalMilliseconds: Number(intervalArgument) * 1000 };
}

/**
 * One poll. The pending gates are always read; the run only while none is
 * pending, so a poll during the build is two GETs; the jobs only once the run
 * has completed.
 *
 * @param {string} runId
 * @param {(apiPath: string) => unknown} readJson
 */
export function poll(runId, readJson) {
  const pending = readJson(`repos/${REPOSITORY}/actions/runs/${runId}/pending_deployments`);
  if (Array.isArray(pending) && pending.length > 0) return { pending, run: null, jobs: [] };
  const run = readJson(`repos/${REPOSITORY}/actions/runs/${runId}`);
  // The jobs endpoint returns 30 a page unless asked for more.
  const jobs =
    run.status === 'completed' ? (readJson(`repos/${REPOSITORY}/actions/runs/${runId}/jobs?per_page=100`).jobs ?? []) : [];
  return { pending, run, jobs };
}

/**
 * Polls until describePoll ends the wait. A failed poll is retried, because the
 * gate can be twenty minutes away, but only MAXIMUM_CONSECUTIVE_FAILURES times
 * in a row: a failure that never clears would otherwise keep a background wait
 * alive forever and never wake the session.
 *
 * @param {string} runId
 * @param {number} intervalMilliseconds
 * @param {{ readJson: (apiPath: string) => unknown, sleep: (milliseconds: number) => Promise<unknown>, warn: (message: string) => void }} dependencies
 * @returns {Promise<{ succeeded: boolean, lines: string[] }>}
 */
export async function waitForGate(runId, intervalMilliseconds, { readJson, sleep, warn }) {
  let consecutiveFailures = 0;
  for (;;) {
    try {
      const result = describePoll(poll(runId, readJson), runId);
      if (result.done) return { succeeded: true, lines: result.lines };
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (consecutiveFailures >= MAXIMUM_CONSECUTIVE_FAILURES) {
        return {
          succeeded: false,
          lines: [`POLL-FAILED run=${runId} after ${consecutiveFailures} failed polls in a row: ${message}`],
        };
      }
      warn(`Poll failed, retrying: ${message}`);
    }
    await sleep(intervalMilliseconds);
  }
}

function readGitHubJson(apiPath) {
  // The timeout turns a hung `gh` into a failed poll, which is retried.
  return JSON.parse(execFileSync('gh', ['api', apiPath], { encoding: 'utf8', timeout: 60000 }));
}

async function main(argv) {
  const { runId, intervalMilliseconds } = parseArguments(argv);
  const result = await waitForGate(runId, intervalMilliseconds, {
    readJson: readGitHubJson,
    sleep: delay,
    warn: (message) => process.stderr.write(`${message}\n`),
  });
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  if (!result.succeeded) process.exitCode = 1;
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
