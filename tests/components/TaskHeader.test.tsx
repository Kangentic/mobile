import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider, darkTerminalTheme } from '@/components';
import { TaskHeader } from '@/screens/task/TaskHeader';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { boardColumnFixture, boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

/**
 * The header's current-column chip: status (which column the task sits in)
 * and affordance (tap = the move sheet, long-press = the actions hub) in one
 * element. It renders only once a cached board locates the task, because
 * MoveTaskScreen renders a dead sheet against a board it cannot find - the
 * guard lives HERE, once, rather than in each screen that hosts the header.
 */
function seedLocatedTask(swimlaneId: string = 'lane-todo'): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture(), boardColumnFixture({ id: 'lane-doing', name: 'Doing', position: 1 })],
        tasksById: {
          'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: swimlaneId }),
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

function renderTaskHeader(props: Partial<React.ComponentProps<typeof TaskHeader>> = {}): void {
  render(
    <ThemeProvider>
      <TaskHeader taskTitle="Fix the login bug" sessionId={null} taskId="task-1" {...props} />
    </ThemeProvider>,
  );
}

describe('TaskHeader column chip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
  });

  it('shows the current-column chip when a cached board locates the task', () => {
    seedLocatedTask();
    renderTaskHeader();
    expect(screen.getByTestId('task-header-column')).toBeTruthy();
    expect(screen.getByText('To Do')).toBeTruthy();
  });

  it('renders no chip when no board has located the task', () => {
    renderTaskHeader();
    expect(screen.queryByTestId('task-header-column')).toBeNull();
  });

  it("renders no chip when the task's swimlane names no column", () => {
    seedLocatedTask('lane-gone');
    renderTaskHeader();
    expect(screen.queryByTestId('task-header-column')).toBeNull();
  });

  /** The CompletedTaskScreen contract: archived tasks are on no board, so it passes no taskId and gets no chip. */
  it('renders no chip without a taskId', () => {
    seedLocatedTask();
    renderTaskHeader({ taskId: null });
    expect(screen.queryByTestId('task-header-column')).toBeNull();
  });

  it("tapping the chip pushes the move-task form sheet with the task and its board's project", () => {
    seedLocatedTask();
    renderTaskHeader();

    fireEvent.press(screen.getByTestId('task-header-column'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/move-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
  });

  it('long-pressing the chip pushes the task-actions hub with the same params', () => {
    seedLocatedTask();
    renderTaskHeader();

    fireEvent(screen.getByTestId('task-header-column'), 'longPress');

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/task-actions',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
  });

  /**
   * selectTaskColumn's doc comment (src/state/boardStore.ts) promises the
   * chip re-labels "the instant the user confirms a move, before the
   * desktop's re-snapshot lands" - an optimistic move swaps swimlane_id
   * under an UNCHANGED columns array. boardStore.test.ts locks the selector
   * half of that; this locks that the mounted chip actually re-renders
   * against it, rather than freezing on the column it first subscribed to.
   */
  it('re-labels the chip when an optimistic move lands under an unchanged columns array', () => {
    seedLocatedTask();
    renderTaskHeader();
    expect(screen.getByText('To Do')).toBeTruthy();

    act(() => {
      useBoardStore.getState().applyOptimisticMove({
        projectId: 'project-1',
        taskId: 'task-1',
        toSwimlaneId: 'lane-doing',
        toPosition: 0,
      });
    });

    expect(screen.getByText('Doing')).toBeTruthy();
    expect(screen.queryByText('To Do')).toBeNull();
  });
});

/**
 * One task must not report two different states on two screens at once. The
 * feed row and the board card badge a queued or mid-respawn session with the
 * muted starting ring; this header drew the yellow idle envelope for the very
 * same session, because a queued placeholder has no PTY and so sits at
 * `state: 'idle'` - which is all `sectionForEntry` can see.
 */
describe('TaskHeader status glyph', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    seedLocatedTask();
  });

  /**
   * Which kind rendered, read off the mark's TINT.
   *
   * Not off a testID: `AgentStatusIcon` resolves `testID ?? fallbackTestID`, and
   * this header passes an explicit `task-header-status`, so the per-kind
   * fallback ids never appear here and every kind answers to the same selector.
   * The colour is the one thing that differs, and it is already how
   * AgentStatusIcon.test.tsx distinguishes them.
   *
   * 'idle' and 'idle-unread' share the warning tone by design, so they collapse
   * to one answer - which is all this header ever draws for them anyway.
   */
  const renderedStatusTone = (): string | null => {
    const icon = screen.queryByTestId('task-header-status');
    if (icon === null) return null;
    const { color } = icon.props;
    if (color === darkTerminalTheme.colors.statusIdle) return 'starting';
    if (color === darkTerminalTheme.colors.statusWorking) return 'working';
    if (color === darkTerminalTheme.colors.warning) return 'idle';
    return `unknown:${String(color)}`;
  };

  it('shows the starting ring for a queued session, matching the feed and the board card', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applySnapshot(
      'sess-1',
      'task-1',
      'project-1',
      streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'queued' }),
    );

    renderTaskHeader({ sessionId: 'sess-1' });

    expect(renderedStatusTone()).toBe('starting');
  });

  /**
   * The control, and the reason the test above is not just asserting "idle
   * renders something": the SAME idle entry without the queued status must
   * still draw the envelope.
   */
  it('still shows the idle envelope for an ordinary settled session', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applySnapshot(
      'sess-1',
      'task-1',
      'project-1',
      streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'running' }),
    );

    renderTaskHeader({ sessionId: 'sess-1' });

    expect(renderedStatusTone()).toBe('idle');
  });

  /**
   * A swap is task-keyed, so the header finds it without a session id of its
   * own - but only where a glyph already existed. The guard stays on
   * `activityEntry` deliberately: a swap may change the glyph but never
   * conjure one where the header had nothing bound.
   */
  it('shows the starting ring for a respawning task that still has its outgoing entry', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'session-ended', intentional: true, spawnProgressLabel: 'Switching model...' },
    });

    renderTaskHeader({ sessionId: 'sess-1' });

    expect(renderedStatusTone()).toBe('starting');
  });

  /**
   * The desktop's column-move swap arrives with NO label. The header must
   * read it exactly like the labelled one, or a Code Review move would draw
   * the idle envelope while the feed drew the starting ring for the same
   * task. The label-only store write fails this with 'idle', which is the
   * right reason.
   */
  it('shows the starting ring for a task whose session ended without a label', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'session-ended', intentional: true },
    });

    renderTaskHeader({ sessionId: 'sess-1' });

    expect(renderedStatusTone()).toBe('starting');
  });

  it('draws no glyph at all when no session is bound, respawn or not', () => {
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'session-ended', intentional: true, spawnProgressLabel: 'Switching model...' },
    });

    renderTaskHeader({ sessionId: null });

    expect(renderedStatusTone()).toBeNull();
  });
});
