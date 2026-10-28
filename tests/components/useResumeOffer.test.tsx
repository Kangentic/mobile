import { act, renderHook } from '@testing-library/react-native';
import type { BoardTaskWire } from '@kangentic/protocol';
import { useResumeOffer } from '@/screens/task/useResumeOffer';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useResumeStore } from '@/state/resumeStore';
import { boardSnapshotFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';
import { workflowWireFixture } from '../helpers/workflows';

/**
 * Every board snapshot replaces EVERY row object of its project, so a reader
 * that selects the task row itself re-renders on each snapshot whether or not
 * anything it draws changed. `useResumeOffer` reads five of the row's fields
 * (`session_id`, `spawn_progress`, `resumable`, `paused`, `archived_at`) and
 * narrows the row to those under `useShallow`, so only a change to one of
 * them is a render.
 *
 * That is invisible in what the hook RETURNS (the result is the same either
 * way), so the tests count renders: a hook that selected the row itself still
 * gives the right answer and fails only here.
 */

/** A task the desktop paused: no session, Resume offered, nothing in flight. */
const PAUSED_ROW: Partial<BoardTaskWire> = { session_id: null, resumable: true, paused: true, spawn_progress: null };

/** Publishes one board snapshot holding the paused task with these fields changed; every call builds fresh row objects. */
function publishRow(overrides: Partial<BoardTaskWire>): void {
  useBoardStore
    .getState()
    .applyBoardSnapshot(boardSnapshotFixture({ projectId: 'project-1', view: 'sessions', tasks: [boardTaskFixture({ id: 'task-1', ...PAUSED_ROW, ...overrides })] }));
}

function heldRow(): BoardTaskWire {
  return useBoardStore.getState().boardsByProjectId['project-1'].tasksById['task-1'];
}

/** Renders the hook for the paused task and counts how many times its component body ran. */
async function renderCountedOffer() {
  const renders = { count: 0 };
  const rendered = await renderHook(() => {
    renders.count += 1;
    return useResumeOffer('task-1', null);
  });
  return { renders, result: rendered.result };
}

describe('useResumeOffer board-row subscription', () => {
  beforeEach(() => {
    useActivityStore.getState().reset();
    useBoardStore.getState().reset();
    useResumeStore.setState({ byTaskId: {} });
    publishRow({});
  });

  it('does not re-render when a snapshot replaces the row but changes none of the fields it reads', async () => {
    const { renders, result } = await renderCountedOffer();
    expect(result.current.offered).toBe(true);
    const rowBefore = heldRow();
    const rendersBefore = renders.count;

    await act(async () => {
      publishRow({ title: 'Renamed task', description: 'A new description.', updated_at: '2026-10-07T00:00:00.000Z' });
    });

    // The control: the snapshot really did hand the store a different row object.
    expect(heldRow()).not.toBe(rowBefore);
    expect(heldRow().title).toBe('Renamed task');
    expect(renders.count - rendersBefore).toBe(0);
  });

  it.each([
    ['spawn_progress', { spawn_progress: 'Resuming session...' }, false],
    ['resumable', { resumable: false }, false],
    ['session_id', { session_id: 'sess-other' }, true],
  ] as const)('re-renders when the row\'s %s changes', async (_field, change, expectedOffered) => {
    const { renders, result } = await renderCountedOffer();
    const rendersBefore = renders.count;

    await act(async () => {
      publishRow(change);
    });

    expect(renders.count).toBeGreaterThan(rendersBefore);
    expect(result.current.offered).toBe(expectedOffered);
  });
});

/**
 * Protocol 0.17.0 sends the paused fact apart from the Resume gate. A paused
 * task in Done now READS as Paused (its card says so, as the desktop's does),
 * so the only thing standing between it and a Resume control is this hook
 * still gating on `resumable`.
 */
describe('useResumeOffer and the 0.17.0 paused fact', () => {
  beforeEach(() => {
    useActivityStore.getState().reset();
    useBoardStore.getState().reset();
    useResumeStore.setState({ byTaskId: {} });
  });

  it('offers no Resume for a task that is paused but not resumable', async () => {
    publishRow({ resumable: false, paused: true });

    const { result } = await renderCountedOffer();

    expect(result.current.offered).toBe(false);
  });
});

/**
 * Protocol 0.21.0. The desktop refuses to resume ONE task of a paused workflow,
 * so a resumable paused task whose workflow is paused is offered View workflow
 * (`pausedWorkflow`) in place of Resume (`offered`), and never both. The
 * workflow's home project is named because it can be another board's.
 */
describe('useResumeOffer and a task of a paused workflow', () => {
  function workflowOf(state: string): BoardTaskWire['workflow'] {
    return workflowWireFixture({ id: 'workflow-9', project_id: 'project-home', state });
  }

  beforeEach(() => {
    useActivityStore.getState().reset();
    useBoardStore.getState().reset();
    useResumeStore.setState({ byTaskId: {} });
  });

  /**
   * Mutation seen failing: `offered: resumeOffered` (without `&& pausedWorkflow
   * === null`): both Resume and View workflow were offered ("Expected: false,
   * Received: true" on `offered`, with `pausedWorkflow` already correct).
   */
  it('offers View workflow, asked of the workflow\'s home project, and no Resume', async () => {
    publishRow({ workflow: workflowOf('paused') });

    const { result } = await renderCountedOffer();

    expect(result.current.pausedWorkflow).toEqual({ workflowId: 'workflow-9', homeProjectId: 'project-home' });
    expect(result.current.offered).toBe(false);
  });

  it('offers Resume and names no workflow while the workflow runs', async () => {
    publishRow({ workflow: workflowOf('running') });

    const { result } = await renderCountedOffer();

    expect(result.current.offered).toBe(true);
    expect(result.current.pausedWorkflow).toBeNull();
  });

  it('names no workflow for a paused workflow\'s task that the desktop does not mark resumable', async () => {
    publishRow({ resumable: false, workflow: workflowOf('paused') });

    const { result } = await renderCountedOffer();

    expect(result.current.offered).toBe(false);
    expect(result.current.pausedWorkflow).toBeNull();
  });

  it('follows the workflow\'s state as the board rows change it', async () => {
    publishRow({ workflow: workflowOf('running') });
    const { result } = await renderCountedOffer();
    expect(result.current.offered).toBe(true);

    await act(async () => {
      publishRow({ workflow: workflowOf('paused') });
    });
    expect(result.current.offered).toBe(false);
    expect(result.current.pausedWorkflow).not.toBeNull();

    await act(async () => {
      publishRow({ workflow: workflowOf('running') });
    });
    expect(result.current.offered).toBe(true);
    expect(result.current.pausedWorkflow).toBeNull();
  });

  /**
   * Protocol 0.25.0 (kangentic #923). A workflow's Pause and Resume leave a HELD
   * task's agent alone, so the workflow's Resume would not bring this one back:
   * it keeps its own Resume session and is not sent to View workflow.
   *
   * Mutation seen failing: dropping `&& !held` from `pausedWorkflow` in the hook
   * (the held task was sent to View workflow: "Expected: true, Received: false"
   * on `offered`, with `pausedWorkflow` non-null).
   */
  it('keeps Resume, and names no workflow, for a held task of a paused workflow', async () => {
    publishRow({ workflow: workflowOf('paused'), automations_disabled: true });

    const { result } = await renderCountedOffer();

    expect(result.current.offered).toBe(true);
    expect(result.current.pausedWorkflow).toBeNull();
  });

  it('still names the workflow for a task whose automations are not held', async () => {
    publishRow({ workflow: workflowOf('paused'), automations_disabled: false });

    const { result } = await renderCountedOffer();

    expect(result.current.offered).toBe(false);
    expect(result.current.pausedWorkflow).not.toBeNull();
  });

  it('follows the hold as the board rows flip it', async () => {
    publishRow({ workflow: workflowOf('paused'), automations_disabled: false });
    const { result } = await renderCountedOffer();
    expect(result.current.pausedWorkflow).not.toBeNull();

    await act(async () => {
      publishRow({ workflow: workflowOf('paused'), automations_disabled: true });
    });
    expect(result.current.offered).toBe(true);
    expect(result.current.pausedWorkflow).toBeNull();

    await act(async () => {
      publishRow({ workflow: workflowOf('paused'), automations_disabled: false });
    });
    expect(result.current.offered).toBe(false);
    expect(result.current.pausedWorkflow).not.toBeNull();
  });

  /**
   * The hook reads the workflow as primitives, because every snapshot replaces
   * the row's `workflow` OBJECT. That is invisible in what the hook returns, so
   * this counts renders, as the block above does.
   *
   * Mutation seen failing: a plain subscription to the row's `workflow` object
   * (`useBoardStore((state) => selectTaskRow(state, taskId)?.workflow ?? null)`
   * added to the hook): the snapshot re-rendered the hook with nothing changed
   * ("Expected: 0, Received: 1" on the render count, after the control passed).
   */
  it('does not re-render when a snapshot replaces the workflow object with an equal one', async () => {
    publishRow({ workflow: workflowOf('paused') });
    const { renders } = await renderCountedOffer();
    const workflowBefore = heldRow().workflow;
    const rendersBefore = renders.count;

    await act(async () => {
      publishRow({ workflow: workflowOf('paused') });
    });

    // The control: the store really did receive a different workflow object.
    expect(heldRow().workflow).not.toBe(workflowBefore);
    expect(renders.count - rendersBefore).toBe(0);
  });
});
