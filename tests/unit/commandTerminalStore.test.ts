/**
 * commandTerminalStore: the starts and stops the phone has in flight (protocol
 * 0.20.0). The board is the authority on which terminals exist; this holds what
 * the board cannot say yet (a start the user just tapped, a Stop on its way), so
 * the transitions and the grace boundary are what is pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LAUNCH_LISTING_GRACE_MS,
  isResumeInFlight,
  selectEarlierList,
  selectLaunch,
  selectResumeInFlight,
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
        resumeAgentSessionId: null,
        sessionId: null,
        failureMessage: null,
        settledAt: null,
        listedOnce: false,
      });
    });

    it('beginLaunch with a resume carries the conversation and is titled by its name, capped (protocol 0.24.0)', () => {
      const named = store().beginLaunch('project-1', 2, { agentSessionId: 'conversation-a', name: 'z'.repeat(COMMAND_TERMINAL_NAME_MAX_LENGTH * 2) });

      expect(store().launchesById[named]).toMatchObject({ phase: 'starting', slot: 2, resumeAgentSessionId: 'conversation-a' });
      expect(store().launchesById[named]?.name).toHaveLength(COMMAND_TERMINAL_NAME_MAX_LENGTH);
    });

    it('beginLaunch titles a resume of a conversation with no name by its predicted slot', () => {
      const launchId = store().beginLaunch('project-1', 3, { agentSessionId: 'conversation-b', name: null });

      expect(store().launchesById[launchId]?.name).toBe('Command Terminal 3');
    });

    it('beginLaunch titles a resume of a conversation with a blank name by its predicted slot, as with no name', () => {
      const emptyLaunchId = store().beginLaunch('project-1', 3, { agentSessionId: 'conversation-c', name: '' });
      const whitespaceLaunchId = store().beginLaunch('project-1', 4, { agentSessionId: 'conversation-d', name: '   ' });

      expect(store().launchesById[emptyLaunchId]?.name).toBe('Command Terminal 3');
      expect(store().launchesById[whitespaceLaunchId]?.name).toBe('Command Terminal 4');
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

  describe('resumes in flight', () => {
    it('selectResumeInFlight finds a resume while it starts and until a board lists its terminal', () => {
      const launchId = store().beginLaunch('project-1', 1, { agentSessionId: 'conversation-a', name: null });
      expect(selectResumeInFlight(store(), 'project-1', 'conversation-a')?.launchId).toBe(launchId);

      store().markLaunchStarted(launchId, { sessionId: 'sess-1', slot: 1, name: 'Command Terminal 1' });
      expect(selectResumeInFlight(store(), 'project-1', 'conversation-a')?.launchId).toBe(launchId);

      store().markLaunchListed(launchId);
      expect(selectResumeInFlight(store(), 'project-1', 'conversation-a')).toBeNull();
    });

    it('selectResumeInFlight lets go of a failed resume, and never matches a New or another project', () => {
      const failed = store().beginLaunch('project-1', 1, { agentSessionId: 'conversation-a', name: null });
      store().markLaunchFailed(failed, 'x');
      store().beginLaunch('project-1', 2);
      store().beginLaunch('project-2', 1, { agentSessionId: 'conversation-a', name: null });

      expect(selectResumeInFlight(store(), 'project-1', 'conversation-a')).toBeNull();
    });

    it('isResumeInFlight is false for a New, whatever its phase', () => {
      const launchId = store().beginLaunch('project-1', 1);

      expect(isResumeInFlight(store().launchesById[launchId]!)).toBe(false);
    });
  });

  describe('Earlier lists', () => {
    const conversation = { agentSessionId: 'conversation-a', name: 'Audit image sizes', endedAt: '2026-11-22T08:00:00.000Z' };
    const another = { agentSessionId: 'conversation-b', name: null, endedAt: '2026-11-14T08:00:00.000Z' };

    it('is loading with nothing held before its first read lands', () => {
      store().markEarlierLoading('project-1');

      expect(selectEarlierList(store(), 'project-1')).toEqual({ status: 'loading', conversations: null, revision: 0 });
      expect(selectEarlierList(store(), 'project-2')).toBeNull();
      expect(selectEarlierList(store(), null)).toBeNull();
    });

    it('keeps the rows last read through a reload and through a failed read', () => {
      store().setEarlier('project-1', [conversation]);
      store().markEarlierLoading('project-1');
      expect(selectEarlierList(store(), 'project-1')).toMatchObject({ status: 'loading', conversations: [conversation] });

      store().markEarlierFailed('project-1');
      expect(selectEarlierList(store(), 'project-1')).toMatchObject({ status: 'failed', conversations: [conversation] });
    });

    it('markEarlierFailed before any read leaves a held list with nothing in it, which a bootstrap re-reads', () => {
      store().markEarlierFailed('project-1');

      expect(selectEarlierList(store(), 'project-1')).toEqual({ status: 'failed', conversations: null, revision: 0 });
    });

    it('markEarlierLoading leaves the list object alone when it is already loading', () => {
      store().markEarlierLoading('project-1');
      const before = store().earlierByProjectId['project-1'];

      store().markEarlierLoading('project-1');

      expect(store().earlierByProjectId['project-1']).toBe(before);
    });

    describe('setEarlier with an answer that may not have changed', () => {
      /** The same conversations, as fresh objects in a fresh array, the way a re-read decodes them. */
      function freshCopy<Conversation extends object>(conversations: Conversation[]): Conversation[] {
        return conversations.map((held) => ({ ...held }));
      }

      it('keeps the held array and leaves the state object alone when a ready list is answered with the same conversations', () => {
        store().setEarlier('project-1', [conversation, another]);
        const heldArray = store().earlierByProjectId['project-1']?.conversations;
        const stateBefore = store().earlierByProjectId;

        store().setEarlier('project-1', freshCopy([conversation, another]));

        expect(store().earlierByProjectId['project-1']?.conversations).toBe(heldArray);
        expect(store().earlierByProjectId).toBe(stateBefore);
      });

      it('returns a reloading list to ready with the same array when the answer is the same', () => {
        store().setEarlier('project-1', [conversation, another]);
        const heldArray = store().earlierByProjectId['project-1']?.conversations;
        store().markEarlierLoading('project-1');
        expect(selectEarlierList(store(), 'project-1')?.status).toBe('loading');

        store().setEarlier('project-1', freshCopy([conversation, another]));

        expect(selectEarlierList(store(), 'project-1')?.status).toBe('ready');
        expect(store().earlierByProjectId['project-1']?.conversations).toBe(heldArray);
      });

      it.each([
        ['agentSessionId', [{ ...conversation, agentSessionId: 'conversation-z' }, another]],
        ['name', [{ ...conversation, name: 'Renamed' }, another]],
        ['endedAt', [{ ...conversation, endedAt: '2026-11-22T09:00:00.000Z' }, another]],
        ['length', [conversation]],
        ['order', [another, conversation]],
      ])('replaces the held array when the answer differs in %s', (_difference, answer) => {
        store().setEarlier('project-1', [conversation, another]);
        const heldArray = store().earlierByProjectId['project-1']?.conversations;

        store().setEarlier('project-1', answer);

        expect(store().earlierByProjectId['project-1']?.conversations).toBe(answer);
        expect(store().earlierByProjectId['project-1']?.conversations).not.toBe(heldArray);
        expect(selectEarlierList(store(), 'project-1')?.status).toBe('ready');
      });
    });

    it('dropEarlierConversation takes one row out and bumps the revision, and leaves an unread project alone', () => {
      store().setEarlier('project-1', [conversation, another]);

      store().dropEarlierConversation('project-1', 'conversation-a');
      expect(selectEarlierList(store(), 'project-1')).toMatchObject({ conversations: [another], revision: 1 });

      const before = store().earlierByProjectId;
      store().dropEarlierConversation('project-unread', 'conversation-a');
      expect(store().earlierByProjectId).toBe(before);
    });
  });

  it('reset empties every map, the Earlier lists included', () => {
    store().beginLaunch('project-1', 1);
    store().markStopping('sess-1');
    store().setEarlier('project-1', []);

    store().reset();

    expect(store().launchesById).toEqual({});
    expect(store().stopsBySessionId).toEqual({});
    expect(store().earlierByProjectId).toEqual({});
  });
});
