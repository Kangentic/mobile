#!/usr/bin/env node
/**
 * Waits on one GitHub Actions run until it has a pending deployment gate, or it
 * completes, then prints what it found and exits 0. /release runs it in the
 * background between dispatching a build and approving its store gates, so the
 * session is woken once, when there is something to act on.
 *
 * READ-ONLY by construction: the only calls are GETs of the run, its jobs, and
 * its pending_deployments, through `gh api` with no -X and no fields. It never
 * approves, rejects, cancels, re-runs or dispatches anything; approving a gate
 * stays a separate, explicit `gh api -X POST` that /release makes itself. The
 * autoMode.allow rule in .claude/settings.json that lets auto mode run this
 * script names it by path and relies on that, so keep it that way.
 *
 * Usage:
 *   node scripts/waitForReleaseGate.mjs <run id> [interval seconds, default 30]
 *
 * Output, one line each:
 *   GATE run=<id> environment=<name> environmentId=<id> canApprove=<bool>
 *   RUN-COMPLETED run=<id> conclusion=<conclusion>, then JOB <name>: <status>/<conclusion>
 */
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { isEntrypoint } from './lib/is-entrypoint.mjs';

const REPOSITORY = 'Kangentic/mobile';

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

function readJson(apiPath) {
  return JSON.parse(execFileSync('gh', ['api', apiPath], { encoding: 'utf8' }));
}

/**
 * The run and its jobs are read only when no gate is pending, which is every
 * poll but the last, so one GET per interval is the common case.
 */
function poll(runId) {
  const pending = readJson(`repos/${REPOSITORY}/actions/runs/${runId}/pending_deployments`);
  if (Array.isArray(pending) && pending.length > 0) return { pending, run: null, jobs: [] };
  const run = readJson(`repos/${REPOSITORY}/actions/runs/${runId}`);
  const jobs = run.status === 'completed' ? (readJson(`repos/${REPOSITORY}/actions/runs/${runId}/jobs`).jobs ?? []) : [];
  return { pending, run, jobs };
}

async function main(argv) {
  const [runId, intervalArgument = '30'] = argv;
  if (!/^\d+$/.test(runId ?? '')) {
    throw new Error('Usage: node scripts/waitForReleaseGate.mjs <run id> [interval seconds]');
  }
  const intervalMilliseconds = Number(intervalArgument) * 1000;
  for (;;) {
    try {
      const result = describePoll(poll(runId), runId);
      if (result.done) {
        for (const line of result.lines) process.stdout.write(`${line}\n`);
        return;
      }
    } catch (error) {
      // A transient API or network failure must not end the wait: the gate it
      // is waiting for can be twenty minutes away.
      process.stderr.write(`Poll failed, retrying: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await delay(intervalMilliseconds);
  }
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
