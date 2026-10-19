/**
 * scripts/waitForReleaseGate.mjs, driven entirely through its exports: when a
 * poll ends the wait and what it prints (describePoll), how the command line is
 * validated (parseArguments), which GitHub endpoints one poll reads (poll), and
 * how the wait retries and gives up (waitForGate). Every network and timing seam
 * is a fake passed in, so no test reaches `gh`, the network, or a real timer; the
 * thin `gh api` wrapper and `main` are exercised by /release on every release.
 */
import { describe, expect, it } from 'vitest';

import {
  MAXIMUM_CONSECUTIVE_FAILURES,
  MINIMUM_INTERVAL_SECONDS,
  describePoll,
  parseArguments,
  poll,
  waitForGate,
} from '../../scripts/waitForReleaseGate.mjs';

const RUN_ID = '39182661900';
const RUN_PATH = `repos/Kangentic/mobile/actions/runs/${RUN_ID}`;
const PENDING_PATH = `${RUN_PATH}/pending_deployments`;
const JOBS_PATH = `${RUN_PATH}/jobs?per_page=100`;

const USAGE_PREFIX = 'Usage: node scripts/waitForReleaseGate.mjs <run id>';

const GATE_DEPLOYMENT = {
  environment: { id: 7, name: 'play-store' },
  current_user_can_approve: false,
};
const GATE_LINE = `GATE run=${RUN_ID} environment=play-store environmentId=7 canApprove=false`;

describe('describePoll', () => {
  it('keeps waiting while the run is in progress with no gate pending', () => {
    expect(describePoll({ pending: [], run: { status: 'in_progress' }, jobs: [] }, RUN_ID)).toEqual({
      done: false,
      lines: [],
    });
  });

  it('stops on a pending gate and names its environment, id and whether it can be approved', () => {
    const result = describePoll(
      {
        pending: [
          { environment: { id: 123, name: 'app-store-connect' }, current_user_can_approve: true },
        ],
        run: null,
        jobs: [],
      },
      RUN_ID
    );
    expect(result).toEqual({
      done: true,
      lines: [`GATE run=${RUN_ID} environment=app-store-connect environmentId=123 canApprove=true`],
    });
  });

  it('stops on a completed run and lists every job, so a failed build is never read as a quiet wait', () => {
    const result = describePoll(
      {
        pending: [],
        run: { status: 'completed', conclusion: 'failure' },
        jobs: [
          { name: 'Build (device)', status: 'completed', conclusion: 'failure' },
          { name: 'Submit (TestFlight)', status: 'completed', conclusion: 'skipped' },
        ],
      },
      RUN_ID
    );
    expect(result.done).toBe(true);
    expect(result.lines).toEqual([
      `RUN-COMPLETED run=${RUN_ID} conclusion=failure`,
      'JOB Build (device): completed/failure',
      'JOB Submit (TestFlight): completed/skipped',
    ]);
  });

  it('treats a non-array pending_deployments answer as no gate rather than throwing', () => {
    expect(describePoll({ pending: { message: 'Not Found' }, run: { status: 'queued' }, jobs: [] }, RUN_ID).done).toBe(
      false
    );
  });

  it('treats a string pending answer as no gate, though a string has a numeric length', () => {
    // A rate-limit body can arrive as a bare string. Without an Array.isArray
    // check its length of 12 reads as twelve pending gates and `.map` throws.
    expect(describePoll({ pending: 'rate limited', run: { status: 'in_progress' }, jobs: [] }, RUN_ID)).toEqual({
      done: false,
      lines: [],
    });
  });

  it('prints one GATE line per pending deployment, in the order GitHub listed them', () => {
    const result = describePoll(
      {
        pending: [
          { environment: { id: 1, name: 'first-gate' }, current_user_can_approve: true },
          { environment: { id: 2, name: 'second-gate' }, current_user_can_approve: false },
        ],
        run: null,
        jobs: [],
      },
      RUN_ID
    );
    expect(result).toEqual({
      done: true,
      lines: [
        `GATE run=${RUN_ID} environment=first-gate environmentId=1 canApprove=true`,
        `GATE run=${RUN_ID} environment=second-gate environmentId=2 canApprove=false`,
      ],
    });
  });

  it('still ends the wait on a pending deployment that carries no environment, without throwing', () => {
    const result = describePoll({ pending: [{ current_user_can_approve: true }], run: null, jobs: [] }, RUN_ID);
    expect(result.done).toBe(true);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatch(new RegExp(`^GATE run=${RUN_ID} `));
  });

  it('reports only the completed line for a finished run that has no jobs', () => {
    expect(
      describePoll({ pending: [], run: { status: 'completed', conclusion: 'success' }, jobs: [] }, RUN_ID)
    ).toEqual({
      done: true,
      lines: [`RUN-COMPLETED run=${RUN_ID} conclusion=success`],
    });
  });
});

describe('parseArguments', () => {
  it('defaults the interval to 30 seconds', () => {
    expect(parseArguments([RUN_ID])).toEqual({ runId: RUN_ID, intervalMilliseconds: 30000 });
  });

  it('accepts an explicit interval above the minimum and converts it to milliseconds', () => {
    expect(parseArguments([RUN_ID, '45'])).toEqual({ runId: RUN_ID, intervalMilliseconds: 45000 });
  });

  it('accepts an interval of exactly the minimum', () => {
    expect(parseArguments([RUN_ID, String(MINIMUM_INTERVAL_SECONDS)])).toEqual({
      runId: RUN_ID,
      intervalMilliseconds: MINIMUM_INTERVAL_SECONDS * 1000,
    });
  });

  it('pins the minimum interval at 10 seconds', () => {
    expect(MINIMUM_INTERVAL_SECONDS).toBe(10);
  });

  it.each([
    ['a missing run id', []],
    ['an empty run id', ['']],
    ['a non-numeric run id', ['abc']],
    ['a run id with trailing text', ['123abc']],
    ['a negative run id', ['-1']],
  ])('throws the usage error for %s', (_description, argv) => {
    expect(() => parseArguments(argv)).toThrow(USAGE_PREFIX);
  });

  it.each([
    ['abc'],
    ['0'],
    ['-5'],
    ['1.5'],
    [''],
    [String(MINIMUM_INTERVAL_SECONDS - 1)],
  ])('throws the usage error for the interval %j, which would hammer the API or never wait', (intervalArgument) => {
    expect(() => parseArguments([RUN_ID, intervalArgument])).toThrow(USAGE_PREFIX);
  });
});

/**
 * A readJson fake that records every path it is asked for and answers from a
 * map. A path outside the map throws, so a read the code should not make (or a
 * path spelled wrongly) fails by name instead of as a TypeError on undefined.
 */
function createReadJson(answers: Record<string, unknown>) {
  const requestedPaths: string[] = [];
  const readJson = (apiPath: string): unknown => {
    requestedPaths.push(apiPath);
    if (!(apiPath in answers)) throw new Error(`unexpected read: ${apiPath}`);
    return answers[apiPath];
  };
  return { readJson, requestedPaths };
}

describe('poll', () => {
  it('costs exactly one read when a gate is pending, and does not read the run', () => {
    const { readJson, requestedPaths } = createReadJson({ [PENDING_PATH]: [GATE_DEPLOYMENT] });
    expect(poll(RUN_ID, readJson)).toEqual({ pending: [GATE_DEPLOYMENT], run: null, jobs: [] });
    expect(requestedPaths).toEqual([PENDING_PATH]);
  });

  it('reads the pending gates and then the run while it is in progress, and never the jobs', () => {
    const run = { status: 'in_progress' };
    const { readJson, requestedPaths } = createReadJson({ [PENDING_PATH]: [], [RUN_PATH]: run });
    expect(poll(RUN_ID, readJson)).toEqual({ pending: [], run, jobs: [] });
    expect(requestedPaths).toEqual([PENDING_PATH, RUN_PATH]);
  });

  it('reads the run when pending_deployments answers with a string, since that is not a gate', () => {
    const run = { status: 'in_progress' };
    const { readJson, requestedPaths } = createReadJson({ [PENDING_PATH]: 'rate limited', [RUN_PATH]: run });
    expect(poll(RUN_ID, readJson).run).toBe(run);
    expect(requestedPaths).toEqual([PENDING_PATH, RUN_PATH]);
  });

  it('also reads the jobs of a completed run, asking for 100 a page', () => {
    const run = { status: 'completed', conclusion: 'success' };
    const jobs = [{ name: 'Build (device)', status: 'completed', conclusion: 'success' }];
    const { readJson, requestedPaths } = createReadJson({
      [PENDING_PATH]: [],
      [RUN_PATH]: run,
      [JOBS_PATH]: { jobs },
    });
    expect(poll(RUN_ID, readJson)).toEqual({ pending: [], run, jobs });
    expect(requestedPaths).toEqual([PENDING_PATH, RUN_PATH, JOBS_PATH]);
    expect(requestedPaths[2]).toMatch(/\?per_page=100$/);
  });

  it('gives an empty job list when the jobs response has no jobs field', () => {
    const run = { status: 'completed', conclusion: 'success' };
    const { readJson } = createReadJson({ [PENDING_PATH]: [], [RUN_PATH]: run, [JOBS_PATH]: {} });
    expect(poll(RUN_ID, readJson).jobs).toEqual([]);
  });
});

type ScriptedPoll = 'in-progress' | 'gate' | 'throw';

function repeat(scriptedPoll: ScriptedPoll, count: number): ScriptedPoll[] {
  return Array.from({ length: count }, () => scriptedPoll);
}

/**
 * Plays one scripted outcome per poll, advancing on the pending_deployments
 * read because every poll starts with it. Each thrown error is numbered, so a
 * test can tell the last error from the first. Once the script is spent the
 * answer is a gate, so a loop that should have stopped earlier ends as an
 * assertion diff instead of spinning, and `getStartedPolls` shows how far it ran.
 */
function createScriptedGitHub(script: ScriptedPoll[]) {
  let startedPolls = 0;
  let thrownErrors = 0;
  const readJson = (apiPath: string): unknown => {
    if (apiPath === PENDING_PATH) {
      const scriptedPoll = script[startedPolls] ?? 'gate';
      startedPolls += 1;
      if (scriptedPoll === 'throw') {
        thrownErrors += 1;
        throw new Error(`gh api failed (attempt ${thrownErrors})`);
      }
      return scriptedPoll === 'gate' ? [GATE_DEPLOYMENT] : [];
    }
    if (apiPath === RUN_PATH) return { status: 'in_progress' };
    throw new Error(`unexpected read: ${apiPath}`);
  };
  return { readJson, getStartedPolls: () => startedPolls };
}

const SLEEP_CALL_LIMIT = 50;

/** Fakes for the timing and logging seams. The sleep resolves at once and records what it was asked for. */
function createWaitFakes(script: ScriptedPoll[]) {
  const { readJson, getStartedPolls } = createScriptedGitHub(script);
  const sleepCalls: number[] = [];
  const warnings: string[] = [];
  const sleep = async (milliseconds: number): Promise<void> => {
    sleepCalls.push(milliseconds);
    if (sleepCalls.length > SLEEP_CALL_LIMIT) throw new Error('loop did not terminate');
  };
  const warn = (message: string): void => {
    warnings.push(message);
  };
  return { dependencies: { readJson, sleep, warn }, getStartedPolls, sleepCalls, warnings };
}

const INTERVAL_MILLISECONDS = 12000;

describe('waitForGate', () => {
  it('sleeps once between an in-progress poll and a gate, then reports the gate', async () => {
    const { dependencies, getStartedPolls, sleepCalls, warnings } = createWaitFakes(['in-progress', 'gate']);
    await expect(waitForGate(RUN_ID, INTERVAL_MILLISECONDS, dependencies)).resolves.toEqual({
      succeeded: true,
      lines: [GATE_LINE],
    });
    expect(sleepCalls).toEqual([INTERVAL_MILLISECONDS]);
    expect(getStartedPolls()).toBe(2);
    expect(warnings).toEqual([]);
  });

  it('retries after one failed poll, warning with the error message, then reports the gate', async () => {
    const { dependencies, getStartedPolls, sleepCalls, warnings } = createWaitFakes(['throw', 'gate']);
    await expect(waitForGate(RUN_ID, INTERVAL_MILLISECONDS, dependencies)).resolves.toEqual({
      succeeded: true,
      lines: [GATE_LINE],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('gh api failed (attempt 1)');
    expect(sleepCalls).toEqual([INTERVAL_MILLISECONDS]);
    expect(getStartedPolls()).toBe(2);
  });

  it('warns with the text of a thrown value that is not an Error', async () => {
    const warnings: string[] = [];
    let hasThrown = false;
    const readJson = (apiPath: string): unknown => {
      if (apiPath !== PENDING_PATH) throw new Error(`unexpected read: ${apiPath}`);
      if (!hasThrown) {
        hasThrown = true;
        throw 'plain string failure';
      }
      return [GATE_DEPLOYMENT];
    };
    const result = await waitForGate(RUN_ID, INTERVAL_MILLISECONDS, {
      readJson,
      sleep: async () => undefined,
      warn: (message) => {
        warnings.push(message);
      },
    });
    expect(result).toEqual({ succeeded: true, lines: [GATE_LINE] });
    expect(warnings).toEqual(['Poll failed, retrying: plain string failure']);
  });

  it('gives up after the maximum number of consecutive failed polls and names the last error', async () => {
    const { dependencies, getStartedPolls, sleepCalls, warnings } = createWaitFakes(
      repeat('throw', MAXIMUM_CONSECUTIVE_FAILURES)
    );
    const result = await waitForGate(RUN_ID, INTERVAL_MILLISECONDS, dependencies);
    expect(result).toEqual({
      succeeded: false,
      lines: [`POLL-FAILED run=${RUN_ID} after 10 failed polls in a row: gh api failed (attempt 10)`],
    });
    expect(getStartedPolls()).toBe(MAXIMUM_CONSECUTIVE_FAILURES);
    expect(warnings).toHaveLength(MAXIMUM_CONSECUTIVE_FAILURES - 1);
    expect(sleepCalls).toHaveLength(MAXIMUM_CONSECUTIVE_FAILURES - 1);
  });

  it('counts failures per streak, so a good in-progress poll in between resets the count', async () => {
    const streak = MAXIMUM_CONSECUTIVE_FAILURES - 1;
    const { dependencies, getStartedPolls, warnings } = createWaitFakes([
      ...repeat('throw', streak),
      'in-progress',
      ...repeat('throw', streak),
      'gate',
    ]);
    await expect(waitForGate(RUN_ID, INTERVAL_MILLISECONDS, dependencies)).resolves.toEqual({
      succeeded: true,
      lines: [GATE_LINE],
    });
    expect(warnings).toHaveLength(streak * 2);
    expect(getStartedPolls()).toBe(streak * 2 + 2);
  });
});
