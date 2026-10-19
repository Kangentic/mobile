/**
 * The decision half of scripts/waitForReleaseGate.mjs: when a poll ends the
 * wait, and what it prints. The polling half is three `gh api` GETs and a sleep,
 * which /release exercises on every release.
 */
import { describe, expect, it } from 'vitest';

import { describePoll } from '../../scripts/waitForReleaseGate.mjs';

const RUN_ID = '39182661900';

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
});
