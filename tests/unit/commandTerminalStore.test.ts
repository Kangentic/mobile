/**
 * commandTerminalStore: the starts and stops the phone has in flight (protocol
 * 0.20.0). The board is the authority on which terminals exist; this holds what
 * the board cannot say yet (a start the user just tapped, a Stop on its way), so
 * the transitions and the grace boundary are what is pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LAUNCH_LISTING_GRACE_MS,
  selectLaunch,
  selectStartingCount,
  selectStartingSlots,
  selectUnlistedStartedLaunches,
  useCommandTerminalStore,
} from '@/state/commandTerminalStore';
import { COMMAND_TERMINAL_NAME_MAX_LENGTH } from '@/state/boardStore';

const SETTLED_AT = 1_000_000;

function store() {
  return useCommandTerminalStore.getState();
}

describe('commandTerminalStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SETTLED_AT);
    useCommandTerminalStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('launches', () => {
    it('beginLaunch records a starting launch under the predicted slot and its "Command Terminal N" name', () => {
      const launchId = store().beginLaunch('project-1', 3);

      expect(store().launchesById[launchId]).toEqual({
        launchId,
        projectId: 'project-1',
        phase: 'starting',
        slot: 3,
        name: 'Command Terminal 3',
        sessionId: null,
        failureMessage: null,
        settledAt: null,
        listedOnce: false,
      });
    });

    it('markLaunchListed latches once a board has listed the terminal, keeping the object when already set', () => {
      const launchId = store().beginLaunch('project-1', 1);
      store().markLaunchStarted(launchId, { sessionId: 'sess-1', slot: 1, name: 'Command Terminal 1' });

      store().markLaunchListed(launchId);
      const listed = store().launchesById[launchId];
      store().markLaunchListed(launchId);

      expect(listed?.listedOnce).toBe(true);
      expect(store().launchesById[launchId]).toBe(listed);
    });

    it('beginLaunch hands back a distinct id per call, so two starts never share a launch', () => {
      const first = store().beginLaunch('project-1', 1);
      const second = store().beginLaunch('project-1', 2);

      expect(first).not.toBe(second);
      expect(Object.keys(store().launchesById).sort()).toEqual([first, second].sort());
    });

    it('markLaunchStarted takes the desktop\'s slot, name and session over the prediction, and stamps when it answered', () => {
      const launchId = store().beginLaunch('project-1', 1);

      store().markLaunchStarted(launchId, { sessionId: 'sess-1', slot: 2, name: 'Command Terminal 2' });

      expect(store().launchesById[launchId]).toMatchObject({
        phase: 'started',
        sessionId: 'sess-1',
        slot: 2,
        name: 'Command Terminal 2',
        settledAt: SETTLED_AT,
        failureMessage: null,
      });
    });

    it('markLaunchStarted caps the name the desktop answered with', () => {
      const launchId = store().beginLaunch('project-1', 1);

      store().markLaunchStarted(launchId, { sessionId: 'sess-1', slot: 1, name: 'z'.repeat(COMMAND_TERMINAL_NAME_MAX_LENGTH * 2) });

      expect(store().launchesById[launchId]?.name).toHaveLength(COMMAND_TERMINAL_NAME_MAX_LENGTH);
    });

    it('markLaunchFailed records the plain failure line and when it failed, with no session', () => {
      const launchId = store().beginLaunch('project-1', 1);

      store().markLaunchFailed(launchId, 'This project already runs four.');

      expect(store().launchesById[launchId]).toMatchObject({
        phase: 'failed',
        failureMessage: 'This project already runs four.',
        sessionId: null,
        settledAt: SETTLED_AT,
      });
    });

    it('clearLaunch drops the launch', () => {
      const launchId = store().beginLaunch('project-1', 1);

      store().clearLaunch(launchId);

      expect(store().launchesById).toEqual({});
    });

    it('leaves the state object itself alone for a launch id it does not hold', () => {
      store().beginLaunch('project-1', 1);
      const before = store().launchesById;

      store().markLaunchStarted('launch-missing', { sessionId: 'sess-1', slot: 1, name: 'x' });
      store().markLaunchFailed('launch-missing', 'x');
      store().clearLaunch('launch-missing');

      expect(store().launchesById).toBe(before);
    });

    it('selectLaunch finds a launch by id and is null for null or an unknown id', () => {
      const launchId = store().beginLaunch('project-1', 1);

      expect(selectLaunch(store(), launchId)).toBe(store().launchesById[launchId]);
      expect(selectLaunch(store(), null)).toBeNull();
      expect(selectLaunch(store(), 'launch-missing')).toBeNull();
    });
  });

  describe('starts in flight', () => {
    it('selectStartingCount counts only this project\'s launches still starting', () => {
      const starting = store().beginLaunch('project-1', 1);
      store().beginLaunch('project-1', 2);
      store().beginLaunch('project-2', 1);
      const started = store().beginLaunch('project-1', 3);
      store().markLaunchStarted(started, { sessionId: 'sess-3', slot: 3, name: 'Command Terminal 3' });
      const failed = store().beginLaunch('project-1', 4);
      store().markLaunchFailed(failed, 'x');

      expect(selectStartingCount(store(), 'project-1')).toBe(2);
      expect(selectStartingCount(store(), 'project-2')).toBe(1);
      expect(selectStartingCount(store(), 'project-unknown')).toBe(0);
      expect(selectStartingCount(store(), null)).toBe(0);

      // A launch leaves the count the moment it settles either way.
      store().markLaunchStarted(starting, { sessionId: 'sess-1', slot: 1, name: 'Command Terminal 1' });
      expect(selectStartingCount(store(), 'project-1')).toBe(1);
    });

    it('selectStartingSlots lists the slots this project\'s starting launches are predicted to take', () => {
      store().beginLaunch('project-1', 1);
      store().beginLaunch('project-1', 3);
      store().beginLaunch('project-2', 2);
      const started = store().beginLaunch('project-1', 2);
      store().markLaunchStarted(started, { sessionId: 'sess-2', slot: 2, name: 'Command Terminal 2' });

      expect(selectStartingSlots(store(), 'project-1').sort()).toEqual([1, 3]);
      expect(selectStartingSlots(store(), 'project-2')).toEqual([2]);
      expect(selectStartingSlots(store(), 'project-unknown')).toEqual([]);
    });
  });

  describe('selectUnlistedStartedLaunches', () => {
    function startedLaunch(sessionId: string): string {
      const launchId = store().beginLaunch('project-1', 1);
      store().markLaunchStarted(launchId, { sessionId, slot: 1, name: 'Command Terminal 1' });
      return launchId;
    }

    it('includes a started launch no board lists, up to the last millisecond of its grace window', () => {
      const launchId = startedLaunch('sess-1');

      const insideWindow = selectUnlistedStartedLaunches(store(), new Set(), SETTLED_AT + LAUNCH_LISTING_GRACE_MS - 1);

      expect(insideWindow.map((launch) => launch.launchId)).toEqual([launchId]);
    });

    it('drops it at exactly the grace deadline', () => {
      startedLaunch('sess-1');

      expect(selectUnlistedStartedLaunches(store(), new Set(), SETTLED_AT + LAUNCH_LISTING_GRACE_MS)).toEqual([]);
    });

    it('drops a launch a board already lists', () => {
      startedLaunch('sess-1');

      expect(selectUnlistedStartedLaunches(store(), new Set(['sess-1']), SETTLED_AT)).toEqual([]);
    });

    it('never includes a launch still starting or one that failed', () => {
      store().beginLaunch('project-1', 1);
      const failed = store().beginLaunch('project-1', 2);
      store().markLaunchFailed(failed, 'x');

      expect(selectUnlistedStartedLaunches(store(), new Set(), SETTLED_AT)).toEqual([]);
    });

    it('measures the window from when each launch was answered, not from when it began', () => {
      startedLaunch('sess-early');
      vi.setSystemTime(SETTLED_AT + 15_000);
      const late = startedLaunch('sess-late');

      const now = SETTLED_AT + LAUNCH_LISTING_GRACE_MS + 1;
      expect(selectUnlistedStartedLaunches(store(), new Set(), now).map((launch) => launch.launchId)).toEqual([late]);
    });
  });

  describe('stops', () => {
    it('markStopping, markStopFailed and clearStop move a session through the phases', () => {
      store().markStopping('sess-1');
      expect(store().stopsBySessionId).toEqual({ 'sess-1': 'stopping' });

      store().markStopFailed('sess-1');
      expect(store().stopsBySessionId).toEqual({ 'sess-1': 'failed' });

      // A retry after a failure goes back to stopping.
      store().markStopping('sess-1');
      expect(store().stopsBySessionId).toEqual({ 'sess-1': 'stopping' });

      store().clearStop('sess-1');
      expect(store().stopsBySessionId).toEqual({});
    });

    it('keeps one session\'s stop out of another\'s', () => {
      store().markStopping('sess-1');
      store().markStopFailed('sess-2');

      store().clearStop('sess-1');

      expect(store().stopsBySessionId).toEqual({ 'sess-2': 'failed' });
    });

    it('clearStop leaves the map itself alone for a session with no stop', () => {
      store().markStopping('sess-1');
      const before = store().stopsBySessionId;

      store().clearStop('sess-missing');

      expect(store().stopsBySessionId).toBe(before);
    });
  });

  it('reset empties both maps', () => {
    store().beginLaunch('project-1', 1);
    store().markStopping('sess-1');

    store().reset();

    expect(store().launchesById).toEqual({});
    expect(store().stopsBySessionId).toEqual({});
  });
});
