import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { CirclePlay, Clock, LoaderCircle } from 'lucide-react-native';
import { ThemeProvider, darkTerminalTheme } from '@/components';
import { TaskHeader } from '@/screens/task/TaskHeader';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useResumeStore } from '@/state/resumeStore';
import { boardColumnFixture, boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { getLucideGlyph } from '../helpers/lucideGlyphs';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

const mockResumeTaskSession = jest.fn().mockResolvedValue({ phase: 'resuming', startedAt: 0 });
jest.mock('@/connection/actions', () => ({
  resumeTaskSession: (taskId: string, projectId: string) => mockResumeTaskSession(taskId, projectId),
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

async function renderTaskHeader(props: Partial<React.ComponentProps<typeof TaskHeader>> = {}): Promise<void> {
  await render(
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

  it('shows the current-column chip when a cached board locates the task', async () => {
    seedLocatedTask();
    await renderTaskHeader();
    expect(screen.getByTestId('task-header-column')).toBeTruthy();
    expect(screen.getByText('To Do')).toBeTruthy();
  });

  it('renders no chip when no board has located the task', async () => {
    await renderTaskHeader();
    expect(screen.queryByTestId('task-header-column')).toBeNull();
  });

  it("renders no chip when the task's swimlane names no column", async () => {
    seedLocatedTask('lane-gone');
    await renderTaskHeader();
    expect(screen.queryByTestId('task-header-column')).toBeNull();
  });

  /** The CompletedTaskScreen contract: archived tasks are on no board, so it passes no taskId and gets no chip. */
  it('renders no chip without a taskId', async () => {
    seedLocatedTask();
    await renderTaskHeader({ taskId: null });
    expect(screen.queryByTestId('task-header-column')).toBeNull();
  });

  it("tapping the chip pushes the move-task form sheet with the task and its board's project", async () => {
    seedLocatedTask();
    await renderTaskHeader();

    await fireEvent.press(screen.getByTestId('task-header-column'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/move-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
  });

  it('long-pressing the chip pushes the task-actions hub with the same params', async () => {
    seedLocatedTask();
    await renderTaskHeader();

    await fireEvent(screen.getByTestId('task-header-column'), 'longPress');

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
  it('re-labels the chip when an optimistic move lands under an unchanged columns array', async () => {
    seedLocatedTask();
    await renderTaskHeader();
    expect(screen.getByText('To Do')).toBeTruthy();

    await act(() => {
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
 * The desktop task view header's glyph for each state (TaskDetailHeader.tsx):
 * the agent icon while running, a clock while queued, the spinner while a
 * respawn is in flight, nothing once the session ended. A queued placeholder
 * has no PTY and so sits at `state: 'idle'` - which is all `sectionForEntry`
 * can see - so this header once drew the yellow idle envelope for it.
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
    if (color === darkTerminalTheme.colors.statusWorking) return 'working';
    if (color === darkTerminalTheme.colors.warning) return 'idle';
    return `unknown:${String(color)}`;
  };

  it('shows the desktop\'s still clock for a queued session, and no agent icon', async () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applySnapshot(
      'sess-1',
      'task-1',
      'project-1',
      streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'queued' }),
    );

    await renderTaskHeader({ sessionId: 'sess-1' });

    expect(getLucideGlyph(screen.getByTestId('task-header-status-queued'), Clock)).toBeTruthy();
    expect(renderedStatusTone()).toBeNull();
  });

  /**
   * The control, and the reason the test above is not just asserting "idle
   * renders something": the SAME idle entry without the queued status must
   * still draw the envelope.
   */
  it('still shows the idle envelope for an ordinary settled session', async () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applySnapshot(
      'sess-1',
      'task-1',
      'project-1',
      streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'running' }),
    );

    await renderTaskHeader({ sessionId: 'sess-1' });

    expect(renderedStatusTone()).toBe('idle');
  });

  /**
   * A swap is task-keyed, so the header finds it whether or not its outgoing
   * session is still bound: the desktop's header spins while a task is being
   * prepared, session or not.
   */
  it.each([
    ['still has its outgoing entry', 'sess-1'],
    ['has no session bound', null],
  ])('shows the desktop\'s spinner for a respawning task that %s, and no agent icon', async (_case, sessionId) => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'session-ended', intentional: true, spawnProgressLabel: 'Switching model...' },
    });

    await renderTaskHeader({ sessionId });

    expect(getLucideGlyph(screen.getByTestId('task-header-status-preparing'), LoaderCircle)).toBeTruthy();
    expect(renderedStatusTone()).toBeNull();
  });

  /**
   * An end with no step is an ended session, which the desktop header draws
   * nothing for. The seeded entry is idle, so a header that ignored the end
   * would draw the envelope.
   */
  it('draws nothing for a task whose session ended without a label', async () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'session-ended', intentional: true },
    });

    await renderTaskHeader({ sessionId: 'sess-1' });

    expect(renderedStatusTone()).toBeNull();
    expect(screen.queryByTestId('task-header-status-queued')).toBeNull();
    expect(screen.queryByTestId('task-header-status-preparing')).toBeNull();
  });

  it('draws no glyph at all when no session is bound and nothing is in flight', async () => {
    await renderTaskHeader({ sessionId: null });

    expect(renderedStatusTone()).toBeNull();
    expect(screen.queryByTestId('task-header-status-preparing')).toBeNull();
  });

  /**
   * A paused session the desktop marks resumable. No wire on protocol 0.15.0
   * carries the flag (desktop #762 adds it in 0.16.0), so it is set on the
   * entry directly; the snapshot alone leaves it false.
   */
  function seedPausedSession({ resumable }: { resumable: boolean }): void {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore
      .getState()
      .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'suspended' }));
    if (resumable) {
      useActivityStore.setState((state) => ({
        bySessionId: { ...state.bySessionId, 'sess-1': { ...state.bySessionId['sess-1'], resumable: true } },
      }));
    }
  }

  it('offers the desktop\'s play circle for a paused session the desktop marks resumable, and resumes on tap', async () => {
    useResumeStore.setState({ byTaskId: {} });
    seedPausedSession({ resumable: true });

    await renderTaskHeader({ sessionId: 'sess-1' });

    const resumeButton = screen.getByTestId('task-header-resume');
    expect(getLucideGlyph(resumeButton, CirclePlay)).toBeTruthy();
    expect(resumeButton.props.accessibilityLabel).toBe('Resume session');
    expect(renderedStatusTone()).toBeNull();
    await act(async () => {
      await fireEvent.press(resumeButton);
    });
    expect(mockResumeTaskSession).toHaveBeenCalledWith('task-1', 'project-1');
  });

  /**
   * The desktop draws no toggle when its own Resume is blocked; a desktop
   * that does not mark the session resumable is the phone's blocked case. The
   * seeded entry is idle, so a header that fell through would draw the
   * envelope, which is what it drew for a paused session before Resume.
   */
  it('draws nothing for a paused session the desktop does not mark resumable', async () => {
    seedPausedSession({ resumable: false });

    await renderTaskHeader({ sessionId: 'sess-1' });

    expect(screen.queryByTestId('task-header-resume')).toBeNull();
    expect(renderedStatusTone()).toBeNull();
  });

  it('spins the muted spinner, and takes no second tap, while the resume runs', async () => {
    useResumeStore.setState({ byTaskId: {} });
    useResumeStore.getState().markResuming('task-1', Date.now());
    seedPausedSession({ resumable: true });

    await renderTaskHeader({ sessionId: 'sess-1' });

    expect(screen.getByTestId('task-header-resume-spinner')).toBeTruthy();
    expect(screen.getByTestId('task-header-resume').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
  });
});
