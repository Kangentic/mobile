import { act, renderHook } from '@testing-library/react-native';
import type { BoardTaskWire } from '@kangentic/protocol';
import { useResumeOffer } from '@/screens/task/useResumeOffer';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useResumeStore } from '@/state/resumeStore';
import { boardSnapshotFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

/**
 * Every board snapshot replaces EVERY row object of its project, so a reader
 * that selects the task row itself re-renders on each snapshot whether or not
 * anything it draws changed. `useResumeOffer` reads three of the row's fields
 * (`session_id`, `spawn_progress`, `resumable`) and narrows the row to those
 * under `useShallow`, so only a change to one of them is a render.
 *
 * That is invisible in what the hook RETURNS (the result is the same either
 * way), so the tests count renders: a hook that selected the row itself still
 * gives the right answer and fails only here.
 */

/** A task the desktop paused: no session, Resume offered, nothing in flight. */
const PAUSED_ROW: Partial<BoardTaskWire> = { session_id: null, resumable: true, spawn_progress: null };

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
