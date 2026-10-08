import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import type { BoardTaskWire } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { PAUSE_FAILED_MESSAGE, PAUSE_UNCONFIRMED_MESSAGE, TaskActionsScreen } from '@/screens/TaskActionsScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useResumeStore, type ResumeAttempt } from '@/state/resumeStore';
import { boardColumnFixture, boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockParams: { taskId?: string; projectId?: string } = { taskId: 'task-1', projectId: 'project-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: mockReplace, back: mockBack, push: jest.fn() }),
}));

const mockOpenURL = jest.fn().mockResolvedValue(true);
jest.mock('expo-linking', () => ({
  openURL: (url: string) => mockOpenURL(url),
}));

const mockArchiveTask = jest.fn().mockResolvedValue(undefined);
const mockDeleteTaskFromBoard = jest.fn().mockResolvedValue(undefined);
const mockResumeTaskSession = jest.fn();
const mockPauseTaskSession = jest.fn();
/** Mirrors PAUSE_WAIT_MS; the module is mocked whole, so the real constant is not there to import. */
const MOCK_PAUSE_WAIT_MS = 20_000;
jest.mock('@/connection/actions', () => ({
  archiveTask: (input: unknown) => mockArchiveTask(input),
  deleteTaskFromBoard: (input: unknown) => mockDeleteTaskFromBoard(input),
  resumeTaskSession: (taskId: string, projectId: string) => mockResumeTaskSession(taskId, projectId),
  pauseTaskSession: (taskId: string, projectId: string) => mockPauseTaskSession(taskId, projectId),
  // A getter: the factory is hoisted above the constant's initialization.
  get PAUSE_WAIT_MS() {
    return MOCK_PAUSE_WAIT_MS;
  },
}));

/** `withDoneColumn` decides whether Archive is even possible - it is a move into a done-role column. */
function seedBoard({
  withDoneColumn,
  task = {},
  taskOverride,
}: {
  withDoneColumn: boolean;
  task?: Partial<BoardTaskWire>;
  /**
   * A fully-built task stored as-is, bypassing the `boardTaskFixture` merge
   * below. `{ ...task }` spread over the fixture cannot produce a MISSING
   * key: an own `undefined` still leaves the key present, and an absent key
   * in `task` just falls through to the fixture's default. Needed only when
   * a caller has to `delete` a key first, the way the TaskCard test does.
   */
  taskOverride?: BoardTaskWire;
}): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [
          boardColumnFixture({ id: 'lane-todo', name: 'To Do', position: 0 }),
          ...(withDoneColumn ? [boardColumnFixture({ id: 'lane-done', name: 'Done', position: 1, role: 'done' })] : []),
        ],
        tasksById: {
          'task-1': taskOverride ?? boardTaskFixture({ id: 'task-1', title: 'Fix the login bug', swimlane_id: 'lane-todo', ...task }),
        },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
      },
    },
    pendingMoves: [],
  });
}

function renderTaskActions(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <TaskActionsScreen />
    </ThemeProvider>,
  );
}

describe('TaskActionsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1', projectId: 'project-1' };
    useBoardStore.getState().reset();
    seedBoard({ withDoneColumn: true });
  });

  /**
   * Pause in the hub (protocol 0.18.0), gated on the board row's `pausable`,
   * the desktop's promise that `pause-session` takes its own Pause path. The
   * desktop answers on ACCEPT while the agent shuts down behind it, so the
   * sheet holds "Pausing agent..." until the row itself reads paused.
   */
  describe('Pause session', () => {
    function seedLiveSession(task: Partial<BoardTaskWire> = {}): void {
      seedBoard({ withDoneColumn: true, task: { session_id: 'sess-1', swimlane_id: 'lane-done', pausable: true, ...task } });
    }

    function pauseRow(): ReturnType<typeof screen.getByTestId> {
      return screen.getByTestId('task-action-pause');
    }

    async function tapPause(): Promise<void> {
      await act(async () => {
        await fireEvent.press(pauseRow());
      });
    }

    /** The desktop's paused row: no session, paused, nothing left to pause. */
    async function landPausedRow(): Promise<void> {
      await act(() => {
        useBoardStore.setState((state) => {
          const board = state.boardsByProjectId['project-1'];
          if (!board) return state;
          const task = board.tasksById['task-1'];
          if (!task) return state;
          return {
            boardsByProjectId: {
              ...state.boardsByProjectId,
              'project-1': { ...board, tasksById: { 'task-1': { ...task, session_id: null, paused: true, pausable: false } } },
            },
          };
        });
      });
    }

    it('is offered when the row says pausable', async () => {
      seedLiveSession();
      await renderTaskActions();

      expect(pauseRow()).toBeTruthy();
      expect(within(pauseRow()).getByText('Pause session')).toBeTruthy();
    });

    it.each([
      ['false (no live session)', false],
      ['null (a desktop older than 0.18.0)', null],
    ])('is not offered when pausable is %s', async (_description, pausable) => {
      seedLiveSession({ pausable });
      await renderTaskActions();

      expect(screen.queryByTestId('task-action-pause')).toBeNull();
    });

    it('is not offered when the row has no pausable key at all (an older desktop)', async () => {
      const olderRow = boardTaskFixture({ id: 'task-1', session_id: 'sess-1' });
      delete olderRow.pausable;
      seedBoard({ withDoneColumn: true, taskOverride: olderRow });
      await renderTaskActions();

      expect(screen.queryByTestId('task-action-pause')).toBeNull();
    });

    /**
     * Mutation seen failing: closing on the accept instead of on the row
     * (calling closeIfStillOpen in onPause's then): mockBack was called
     * before the paused row landed.
     */
    it('holds "Pausing agent..." with every row disabled, and closes only when the row reads paused', async () => {
      seedLiveSession();
      mockPauseTaskSession.mockResolvedValue({ kind: 'accepted' });
      await renderTaskActions();

      await tapPause();

      expect(mockPauseTaskSession).toHaveBeenCalledWith('task-1', 'project-1');
      expect(within(pauseRow()).getByText('Pausing agent...')).toBeTruthy();
      for (const testID of ['task-action-pause', 'task-action-move', 'task-action-edit', 'task-action-archive', 'task-action-delete']) {
        expect(screen.getByTestId(testID).props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
      }
      expect(mockBack).not.toHaveBeenCalled();

      await landPausedRow();

      expect(mockBack).toHaveBeenCalledTimes(1);
    });

    /**
     * The Agents feed loads the sessions projection, which drops a paused
     * task that offers no Resume (one in Done). There the paused row never
     * arrives; the task leaves the store instead, and that settles it too.
     *
     * Mutation seen failing: settling on `taskPaused` alone (the sheet stayed
     * open on "Pausing agent..." after the row left).
     */
    it('closes when the task leaves the store, as the sessions projection drops a paused Done task', async () => {
      seedLiveSession();
      mockPauseTaskSession.mockResolvedValue({ kind: 'accepted' });
      await renderTaskActions();
      await tapPause();
      expect(mockBack).not.toHaveBeenCalled();

      await act(() => {
        useBoardStore.setState((state) => {
          const board = state.boardsByProjectId['project-1'];
          if (!board) return state;
          return { boardsByProjectId: { ...state.boardsByProjectId, 'project-1': { ...board, tasksById: {} } } };
        });
      });

      expect(mockBack).toHaveBeenCalledTimes(1);
    });

    it('stays open with the desktop\'s refusal text and gives the row back', async () => {
      seedLiveSession();
      mockPauseTaskSession.mockResolvedValue({ kind: 'refused', message: 'This task has no running session to pause.' });
      await renderTaskActions();

      await tapPause();

      expect(mockBack).not.toHaveBeenCalled();
      expect(screen.getByTestId('task-action-error').props.children).toBe('This task has no running session to pause.');
      expect(within(pauseRow()).getByText('Pause session')).toBeTruthy();
      expect(pauseRow().props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
    });

    it('uses its generic line for a refusal with no text', async () => {
      seedLiveSession();
      mockPauseTaskSession.mockResolvedValue({ kind: 'refused', message: null });
      await renderTaskActions();

      await tapPause();

      expect(screen.getByTestId('task-action-error').props.children).toBe(PAUSE_FAILED_MESSAGE);
    });

    /**
     * A timed-out pause may still apply (the desktop waits for the task lock),
     * so the sheet keeps waiting on the row. Only once the bound from the tap
     * passes with no paused row does it give the row back, saying so without
     * calling it a failure.
     */
    it('keeps waiting through a timed-out pause, and says so when the bound passes with no paused row', async () => {
      jest.useFakeTimers();
      try {
        seedLiveSession();
        mockPauseTaskSession.mockResolvedValue({ kind: 'unconfirmed' });
        await renderTaskActions();
        await tapPause();

        expect(within(pauseRow()).getByText('Pausing agent...')).toBeTruthy();
        expect(screen.queryByTestId('task-action-error')).toBeNull();

        await act(() => {
          jest.advanceTimersByTime(MOCK_PAUSE_WAIT_MS);
        });

        expect(mockBack).not.toHaveBeenCalled();
        expect(screen.getByTestId('task-action-error').props.children).toBe(PAUSE_UNCONFIRMED_MESSAGE);
        expect(pauseRow().props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * Pause needs the project to address the right desktop board, and the row
     * is offered from the task alone, so a route with a taskId and no
     * projectId must say so rather than send `undefined` as a project. The
     * mock RESOLVES an accepted outcome so a guard that went missing shows as
     * a call and a "Pausing agent..." row, not as a crash.
     *
     * Mutation seen failing: deleting the `!taskId || !projectId` guard in
     * onPause (the pause action was called with an undefined project).
     */
    it('says why and never calls the pause action when the route has no projectId', async () => {
      seedLiveSession();
      mockParams = { taskId: 'task-1' };
      mockPauseTaskSession.mockResolvedValue({ kind: 'accepted' });
      await renderTaskActions();
      expect(pauseRow()).toBeTruthy();

      await tapPause();

      expect(mockPauseTaskSession).not.toHaveBeenCalled();
      expect(screen.getByTestId('task-action-error').props.children).toBe('Cannot act on this task - close and reopen it');
      expect(within(pauseRow()).queryByText('Pausing agent...')).toBeNull();
      expect(within(pauseRow()).getByText('Pause session')).toBeTruthy();
      expect(mockBack).not.toHaveBeenCalled();
    });

    /**
     * The bound can give up on a pause the desktop still applies (it waits for
     * the task lock). When the paused row then lands, the "has not confirmed"
     * line is stale and goes, and the sheet stays open where the user is. Any
     * other line is not this effect's to clear.
     *
     * Mutation seen failing: removing the effect that clears the line on a
     * paused row (the error line was still shown after the row landed).
     */
    it('retracts the "not confirmed" line, and stays open, when the paused row lands late', async () => {
      jest.useFakeTimers();
      try {
        seedLiveSession();
        mockPauseTaskSession.mockResolvedValue({ kind: 'unconfirmed' });
        await renderTaskActions();
        await tapPause();
        await act(() => {
          jest.advanceTimersByTime(MOCK_PAUSE_WAIT_MS);
        });
        expect(screen.getByTestId('task-action-error').props.children).toBe(PAUSE_UNCONFIRMED_MESSAGE);

        await landPausedRow();

        expect(screen.queryByTestId('task-action-error')).toBeNull();
        expect(mockBack).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('leaves a different error line alone when a paused row lands', async () => {
      seedLiveSession();
      mockPauseTaskSession.mockResolvedValue({ kind: 'refused', message: 'This task has no running session to pause.' });
      await renderTaskActions();
      await tapPause();
      expect(screen.getByTestId('task-action-error').props.children).toBe('This task has no running session to pause.');

      await landPausedRow();

      expect(screen.getByTestId('task-action-error').props.children).toBe('This task has no running session to pause.');
    });
  });

  /**
   * Design review round 2, decision B: Resume in the hub for a paused card,
   * gated exactly as the session view's Resume is - on the board row's
   * `resumable` (protocol 0.16.0). The paused session here keeps its
   * `session_id` on the row (the idle-timeout suspend's shape), and the
   * snapshot carries the stream's copy of the flag.
   */
  describe('Resume session', () => {
    function seedPausedSession({ resumable }: { resumable: boolean }): void {
      seedBoard({ withDoneColumn: true, task: { session_id: 'sess-1', resumable } });
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore
        .getState()
        .applySnapshot(
          'sess-1',
          'task-1',
          'project-1',
          streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'suspended', resumable }),
        );
    }

    /**
     * The long-press hub on the Agents feed's sessionless Paused card: a
     * desktop pause cleared `session_id`, so the board row is all there is.
     */
    it('is offered for a desktop-paused task with no session, from the board row alone', async () => {
      seedBoard({ withDoneColumn: true, task: { session_id: null, resumable: true } });
      await renderTaskActions();

      expect(screen.getByTestId('task-action-resume')).toBeTruthy();
    });

    it('is not offered while the desktop labels the paused task (its resume is already under way)', async () => {
      seedBoard({ withDoneColumn: true, task: { session_id: null, resumable: true, spawn_progress: 'Resuming session...' } });
      await renderTaskActions();

      expect(screen.queryByTestId('task-action-resume')).toBeNull();
    });

    beforeEach(() => {
      useActivityStore.getState().reset();
      useResumeStore.setState({ byTaskId: {} });
    });

    it('closes once the desktop accepts the resume', async () => {
      seedPausedSession({ resumable: true });
      mockResumeTaskSession.mockResolvedValue({ phase: 'resuming', startedAt: 0 });
      await renderTaskActions();

      await act(async () => {
        await fireEvent.press(screen.getByTestId('task-action-resume'));
      });

      expect(mockResumeTaskSession).toHaveBeenCalledWith('task-1', 'project-1');
      expect(mockBack).toHaveBeenCalledTimes(1);
    });

    it('stays open with the desktop\'s refusal when the resume is refused', async () => {
      seedPausedSession({ resumable: true });
      mockResumeTaskSession.mockResolvedValue({ phase: 'failed', message: null });
      await renderTaskActions();

      await act(async () => {
        await fireEvent.press(screen.getByTestId('task-action-resume'));
      });

      expect(mockBack).not.toHaveBeenCalled();
      expect(screen.getByTestId('task-action-error').props.children).toBe('Session could not be resumed.');
    });

    it('stays open with the desktop\'s own refusal text when it sent one, not the generic line', async () => {
      seedPausedSession({ resumable: true });
      mockResumeTaskSession.mockResolvedValueOnce({ phase: 'failed', message: 'Cannot resume a task in To Do' });
      await renderTaskActions();

      await act(async () => {
        await fireEvent.press(screen.getByTestId('task-action-resume'));
      });

      expect(mockBack).not.toHaveBeenCalled();
      expect(screen.getByTestId('task-action-error').props.children).toBe('Cannot resume a task in To Do');
    });

    /**
     * The attempt is shared by every Resume surface, so a resume the session
     * view (or the header) started shows here too: the row takes no second tap.
     * Nothing is in flight in THIS sheet at mount, so the disable can only
     * come from the attempt's phase.
     */
    it('disables the row while an attempt is resuming, and takes no tap', async () => {
      seedPausedSession({ resumable: true });
      await renderTaskActions();
      expect(screen.getByTestId('task-action-resume').props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));

      await act(() => {
        useResumeStore.getState().markResuming('task-1', 0);
      });

      expect(screen.getByTestId('task-action-resume').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
      await fireEvent.press(screen.getByTestId('task-action-resume'));
      expect(mockResumeTaskSession).not.toHaveBeenCalled();
    });

    /**
     * The desktop's answer arrives after an await, and the user can swipe the
     * sheet away first. A late `router.back()` would pop whichever screen is
     * on top by then. The ACCEPTING shape is used on purpose: a refusal never
     * reaches the close, so it would pass whether or not the guard exists.
     */
    it('does not pop a screen underneath when the sheet is dismissed before the desktop accepts', async () => {
      seedPausedSession({ resumable: true });
      let resolveResume: (attempt: ResumeAttempt) => void = () => undefined;
      mockResumeTaskSession.mockReturnValueOnce(
        new Promise<ResumeAttempt>((resolve) => {
          resolveResume = resolve;
        }),
      );
      const { unmount } = await renderTaskActions();

      await act(async () => {
        await fireEvent.press(screen.getByTestId('task-action-resume'));
      });
      expect(mockResumeTaskSession).toHaveBeenCalledTimes(1);

      await unmount();
      await act(async () => {
        resolveResume({ phase: 'resuming', startedAt: 0 });
      });

      expect(mockBack).not.toHaveBeenCalled();
    });

    /**
     * The row is offered from the TASK id alone (the board lookup and the
     * resume gate never read the project), so a route that lost `projectId`
     * still draws it, and the press is the one place the missing context can
     * bite: resuming needs the project to address the right desktop board. It
     * must say so rather than send `undefined` as a project, or do nothing.
     * The mock RESOLVES an accepted attempt so that a guard that went missing
     * would show as a call and a close, not as a crash on an undefined return.
     */
    it('says why and never calls the resume action when the route has no projectId', async () => {
      seedPausedSession({ resumable: true });
      mockParams = { taskId: 'task-1' };
      mockResumeTaskSession.mockResolvedValue({ phase: 'resuming', startedAt: 0 });
      await renderTaskActions();
      expect(screen.getByTestId('task-action-resume')).toBeTruthy();

      await act(async () => {
        await fireEvent.press(screen.getByTestId('task-action-resume'));
      });

      expect(mockResumeTaskSession).not.toHaveBeenCalled();
      expect(screen.getByTestId('task-action-error').props.children).toBe('Cannot act on this task - close and reopen it');
      expect(mockBack).not.toHaveBeenCalled();
      // Nothing was started, so the row is not left locked behind an in-flight action.
      expect(screen.getByTestId('task-action-resume').props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
    });

    it('is not offered for a paused session the desktop does not mark resumable', async () => {
      seedPausedSession({ resumable: false });
      await renderTaskActions();

      expect(screen.queryByTestId('task-action-resume')).toBeNull();
    });

    it('is not offered for a task with no paused session', async () => {
      await renderTaskActions();

      expect(screen.queryByTestId('task-action-resume')).toBeNull();
    });
  });

  describe('View pull request', () => {
    const linkedPr = {
      pr_number: 42,
      pr_url: 'https://github.com/Kangentic/kangentic-mobile/pull/42',
      pr_state: 'open',
      pr_merge_readiness: 'conflicting',
    } satisfies Partial<BoardTaskWire>;

    it('is absent when the task has no linked PR', async () => {
      await renderTaskActions();
      expect(screen.queryByTestId('task-action-view-pr')).toBeNull();
    });

    it('opens the PR through the OS handler, so an installed GitHub app gets the handoff', async () => {
      seedBoard({ withDoneColumn: true, task: linkedPr });
      await renderTaskActions();

      await fireEvent.press(screen.getByTestId('task-action-view-pr'));

      // Assert the argument, not merely that it fired: a row wired to the
      // wrong task's URL would still "work" under a bare toHaveBeenCalled.
      expect(mockOpenURL).toHaveBeenCalledWith('https://github.com/Kangentic/kangentic-mobile/pull/42');
    });

    it('captions itself with the PR number and the same verdict word the card chip uses', async () => {
      seedBoard({ withDoneColumn: true, task: linkedPr });
      await renderTaskActions();

      expect(screen.getByText('#42 - conflicts')).toBeTruthy();
    });

    it('captions an open PR whose wire omits the readiness field entirely as plain open', async () => {
      // `pr_merge_readiness` became OPTIONAL in protocol 0.13.1, so a desktop
      // may leave the key off rather than send null. `prStateSummary`'s only
      // production caller is this screen's caption, reading the field
      // straight off the stored BoardTaskWire, so an absent key must land
      // here as "no verdict" - the same as null - not as a mismatched
      // comparison. Mirrors the TaskCard test for the same key.
      //
      // The key is DELETED rather than left undefined on purpose: an own
      // `pr_merge_readiness: undefined` still leaves the key present, and
      // `boardTaskFixture` defaults the field to null.
      const task = boardTaskFixture({
        id: 'task-1',
        title: 'Fix the login bug',
        swimlane_id: 'lane-todo',
        pr_number: 42,
        pr_url: 'https://github.com/Kangentic/kangentic-mobile/pull/42',
        pr_state: 'open',
      });
      delete task.pr_merge_readiness;
      expect('pr_merge_readiness' in task).toBe(false);

      seedBoard({ withDoneColumn: true, taskOverride: task });
      await renderTaskActions();

      // Verified failing: resolving the absent-readiness arm of
      // `presentationForReadiness` to the `ready` entry instead of `undefined`
      // rendered "#42 - ready" and turned this red, which is what proves the
      // absent key actually reaches the caption rather than being
      // normalised somewhere on the way in.
      expect(screen.getByText('#42 - open')).toBeTruthy();
    });

    it('captions a merged PR without leaking its stale verdict', async () => {
      seedBoard({
        withDoneColumn: true,
        task: { ...linkedPr, pr_state: 'merged', pr_merge_readiness: 'ready' },
      });
      await renderTaskActions();

      expect(screen.getByText('#42 - merged')).toBeTruthy();
    });

    it('drops the number rather than captioning "#null" when a PR was linked before number tracking', async () => {
      seedBoard({ withDoneColumn: true, task: { ...linkedPr, pr_number: null } });
      await renderTaskActions();

      expect(screen.getByText('conflicts')).toBeTruthy();
    });

    it('accepts an uppercase scheme, which is case-insensitive, without lowercasing the path', async () => {
      seedBoard({
        withDoneColumn: true,
        task: { ...linkedPr, pr_url: 'HTTPS://github.com/Kangentic/Kangentic-Mobile/pull/42' },
      });
      await renderTaskActions();

      await fireEvent.press(screen.getByTestId('task-action-view-pr'));

      expect(mockOpenURL).toHaveBeenCalledWith('HTTPS://github.com/Kangentic/Kangentic-Mobile/pull/42');
    });

    it('keeps the sheet open with the reason when the OS refuses to open the pull request', async () => {
      // The `.catch` on `Linking.openURL` had no test at all - the mock was a
      // permanent `mockResolvedValue(true)`, never made to reject. Mirrors the
      // archive-failure test below for the same handler shape.
      seedBoard({ withDoneColumn: true, task: linkedPr });
      mockOpenURL.mockRejectedValueOnce(new Error('No app can handle this link'));
      await renderTaskActions();

      await act(async () => {
        await fireEvent.press(screen.getByTestId('task-action-view-pr'));
      });

      expect(screen.getByText('No app can handle this link')).toBeTruthy();
      expect(mockBack).not.toHaveBeenCalled();
    });

    it.each([
      ['javascript:alert(1)'],
      ['http://github.com/Kangentic/kangentic-mobile/pull/42'],
      ['not a url at all'],
      ['https://'],
      [' https://github.com/x/y/pull/1'],
    ])('refuses to render a row for %s rather than handing it to the opener', async (prUrl) => {
      seedBoard({ withDoneColumn: true, task: { ...linkedPr, pr_url: prUrl } });
      await renderTaskActions();

      expect(screen.queryByTestId('task-action-view-pr')).toBeNull();
      expect(mockOpenURL).not.toHaveBeenCalled();
    });
  });

  it('titles itself with the task and offers the full lifecycle', async () => {
    await renderTaskActions();
    expect(screen.getByText('Fix the login bug')).toBeTruthy();
    expect(screen.getByTestId('task-action-move')).toBeTruthy();
    expect(screen.getByTestId('task-action-edit')).toBeTruthy();
    expect(screen.getByTestId('task-action-archive')).toBeTruthy();
    expect(screen.getByTestId('task-action-delete')).toBeTruthy();
  });

  /**
   * REPLACE, not push: dismissing the sheet these open should return to the
   * board, not to a menu the user has already finished with.
   */
  it('replaces itself with the move and edit sheets rather than stacking on them', async () => {
    await renderTaskActions();

    await fireEvent.press(screen.getByTestId('task-action-move'));
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/move-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });

    await fireEvent.press(screen.getByTestId('task-action-edit'));
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/edit-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
  });

  it('archives and dismisses', async () => {
    await renderTaskActions();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('task-action-archive'));
    });
    expect(mockArchiveTask).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-1' });
    expect(mockBack).toHaveBeenCalled();
  });

  /**
   * Archive and Delete close the sheet only after an await, and the user can
   * swipe the sheet away while the request is in flight. A late `router.back()`
   * would then pop whatever screen is on top by then, so it fires only while
   * the sheet is still mounted.
   */
  it('does not pop a screen underneath when the sheet is dismissed before an archive resolves', async () => {
    let resolveArchive: () => void = () => undefined;
    mockArchiveTask.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveArchive = resolve;
      }),
    );
    const { unmount } = await renderTaskActions();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('task-action-archive'));
    });
    expect(mockArchiveTask).toHaveBeenCalledTimes(1);

    await unmount();
    await act(async () => {
      resolveArchive();
    });

    expect(mockBack).not.toHaveBeenCalled();
  });

  it('does not pop a screen underneath when the sheet is dismissed before a delete resolves', async () => {
    let resolveDelete: () => void = () => undefined;
    mockDeleteTaskFromBoard.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );
    const { unmount } = await renderTaskActions();

    await fireEvent.press(screen.getByTestId('task-action-delete'));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('task-action-delete-confirm'));
    });
    expect(mockDeleteTaskFromBoard).toHaveBeenCalledTimes(1);

    await unmount();
    await act(async () => {
      resolveDelete();
    });

    expect(mockBack).not.toHaveBeenCalled();
  });

  /** Archive is a move into the done column, so a board without one cannot offer it. */
  it('disables archive on a board with no done column, and says why', async () => {
    seedBoard({ withDoneColumn: false });
    await renderTaskActions();
    expect(screen.getByTestId('task-action-archive').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('No Done column on this board')).toBeTruthy();
  });

  /** Delete also kills the task's live desktop session, so one tap must never fire it. */
  it('requires a second tap to delete', async () => {
    await renderTaskActions();

    await fireEvent.press(screen.getByTestId('task-action-delete'));
    expect(mockDeleteTaskFromBoard).not.toHaveBeenCalled();
    expect(screen.getByText('Removes the task and stops its session on your desktop')).toBeTruthy();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('task-action-delete-confirm'));
    });
    expect(mockDeleteTaskFromBoard).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-1' });
    expect(mockBack).toHaveBeenCalled();
  });

  /**
   * The armed confirmation must NOT expire on a clock.
   *
   * It used to relax after ten seconds, and the E2E flow caught it the only
   * way it could: Maestro spent 14.8s between the two tap gestures (6.2s of
   * that waiting for the view hierarchy to settle), so the confirm tap landed
   * on a row that had quietly disarmed and merely re-armed it. No delete_task
   * ever reached the desktop and the sheet showed no reason. A human who
   * stops to read "Removes the task and stops its session on your desktop"
   * hits the same wall. The old test could not see any of this because it
   * pressed twice in the same tick.
   */
  it('still deletes on the second tap long after the first, with no confirmation deadline', async () => {
    jest.useFakeTimers();
    try {
      await renderTaskActions();

      await fireEvent.press(screen.getByTestId('task-action-delete'));
      expect(screen.getByTestId('task-action-delete-confirm')).toBeTruthy();

      // Well past both the removed 10s window and any successor to it.
      await act(() => {
        jest.advanceTimersByTime(120_000);
      });
      expect(screen.getByTestId('task-action-delete-confirm')).toBeTruthy();
      expect(screen.queryByTestId('task-action-delete')).toBeNull();

      await act(async () => {
        await fireEvent.press(screen.getByTestId('task-action-delete-confirm'));
      });
      expect(mockDeleteTaskFromBoard).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-1' });
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * A destructive row that no-ops in silence is its own defect: the user
   * cannot tell a refusal from a broken app. Route params should always be
   * there, so this is a defect path - which is exactly why it must speak.
   */
  it('says why instead of doing nothing when the route params are missing', async () => {
    mockParams = {};
    await renderTaskActions();

    await fireEvent.press(screen.getByTestId('task-action-delete'));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('task-action-delete-confirm'));
    });

    expect(mockDeleteTaskFromBoard).not.toHaveBeenCalled();
    expect(screen.getByTestId('task-action-error')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('keeps the sheet open with the reason when an action fails', async () => {
    mockArchiveTask.mockRejectedValueOnce(new Error('The desktop refused'));
    await renderTaskActions();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('task-action-archive'));
    });
    expect(screen.getByText('The desktop refused')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });
});
