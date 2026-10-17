import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { BoardTaskWire } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { WorkflowsButton } from '@/screens/board/WorkflowsButton';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore, type ProjectBoard } from '@/state/boardStore';
import { useWorkflowStore } from '@/state/workflowStore';
import { boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import type { WorkflowListEntry } from '@/workflow/workflowView';
import { workflowWireFixture } from '../helpers/workflows';

/**
 * The Board header's Workflows button (protocol 0.21.0, design screen 6, H1):
 * the project's unfinished workflows at a glance, toned like the Terminals
 * button beside it. Its list comes from the workflow store (the `list_workflows`
 * read); its tone comes from the sessions of the board rows that belong to those
 * workflows, so a draft with no rows is always at rest.
 */

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  // The screen is always "focused" under test; the real hook runs the effect
  // on focus and the cleanup on blur, which is the same thing for one render.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]),
}));

const mockFetchProjectWorkflows = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/workflowActions', () => ({
  fetchProjectWorkflows: (projectId: string) => mockFetchProjectWorkflows(projectId),
}));

const PROJECT_ID = 'project-1';
const OTHER_PROJECT_ID = 'project-2';

const SHIPPING: WorkflowListEntry = { id: 'workflow-1', title: 'Ship the checkout', state: 'running' };
const REFACTOR: WorkflowListEntry = { id: 'workflow-2', title: 'Refactor the cart', state: 'draft' };

function board(tasks: BoardTaskWire[]): ProjectBoard {
  return {
    columns: [],
    tasksById: Object.fromEntries(tasks.map((task) => [task.id, task])),
    snapshotAt: 0,
    showTicketNumbers: true,
    view: 'full',
    taskCountsByColumnId: {},
    commandTerminals: [],
    commandTerminalsOffered: false,
  };
}

/** A board row of `workflowId`, with `sessionId` on it. */
function workflowTask(taskId: string, workflowId: string, sessionId: string | null, state = 'running'): BoardTaskWire {
  return boardTaskFixture({ id: taskId, session_id: sessionId, workflow: workflowWireFixture({ id: workflowId, state }) });
}

function seedBoards(boardsByProjectId: Record<string, BoardTaskWire[]>): void {
  useBoardStore.setState({
    projects: Object.keys(boardsByProjectId).map((id) => ({ id, name: id })),
    boardsByProjectId: Object.fromEntries(Object.entries(boardsByProjectId).map(([id, tasks]) => [id, board(tasks)])),
    pendingMoves: [],
  });
}

/** A session the desktop has classified, in the given activity state. */
function observeSession(sessionId: string, state: 'thinking' | 'idle' | 'permission', projectId = PROJECT_ID): void {
  useActivityStore.getState().registerSession(sessionId, `task-of-${sessionId}`, projectId);
  useActivityStore
    .getState()
    .applySnapshot(sessionId, `task-of-${sessionId}`, projectId, streamSnapshotFixture({ activity: { state, reason: null } }));
}

function buttonFor(projectId: string): React.JSX.Element {
  return (
    <ThemeProvider>
      <WorkflowsButton projectId={projectId} />
    </ThemeProvider>
  );
}

async function renderButton(): Promise<void> {
  await render(buttonFor(PROJECT_ID));
}

describe('WorkflowsButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useWorkflowStore.getState().reset();
  });

  describe('when the project has no workflows to show', () => {
    /**
     * Mutation seen failing: deleting `if (workflows.length === 0) return null`,
     * which drew the button ("Workflows, 0 open", count 0) in all four of the
     * cases below.
     */
    it('renders nothing before any list has been read', async () => {
      await renderButton();

      expect(screen.queryByTestId('header-workflows-button')).toBeNull();
    });

    it('renders nothing for a list that read empty', async () => {
      useWorkflowStore.getState().setList(PROJECT_ID, []);
      await renderButton();

      expect(screen.queryByTestId('header-workflows-button')).toBeNull();
    });

    it('renders nothing when the read failed and there is nothing held (a desktop that predates workflows)', async () => {
      useWorkflowStore.getState().markListFailed(PROJECT_ID);
      await renderButton();

      expect(screen.queryByTestId('header-workflows-button')).toBeNull();
    });

    it('renders nothing for a project whose list is another project\'s', async () => {
      useWorkflowStore.getState().setList(OTHER_PROJECT_ID, [SHIPPING]);
      await renderButton();

      expect(screen.queryByTestId('header-workflows-button')).toBeNull();
    });
  });

  describe('with workflows listed', () => {
    beforeEach(() => {
      useWorkflowStore.getState().setList(PROJECT_ID, [SHIPPING, REFACTOR]);
    });

    /**
     * The mount is read by the focus effect alone. The digest effect skips its
     * first run per project, so a mount costs ONE `list_workflows` round trip,
     * not two (the second was a guaranteed-redundant re-run). No mockClear
     * between the render and the assertion: the count includes the mount.
     *
     * Mutation seen failing: replacing the digest effect's guarded body with a
     * bare `void fetchProjectWorkflows(projectId);` (the old code): this test
     * went red on "Expected number of calls: 1, Received number of calls: 2".
     */
    it('reads the project\'s workflows exactly once on mount', async () => {
      await renderButton();

      expect(mockFetchProjectWorkflows).toHaveBeenCalledTimes(1);
      expect(mockFetchProjectWorkflows).toHaveBeenCalledWith(PROJECT_ID);
    });

    /**
     * A project switch is the same story: the focus effect re-runs for the new
     * `projectId`, and the digest effect must treat the new project's first run
     * as its own mount rather than as a state change. Each project's board is
     * seeded with a different digest, so nothing but the project id could
     * explain a second read.
     *
     * Mutations seen failing: the same bare `void fetchProjectWorkflows(projectId);`
     * (2 calls instead of 1), and a guard that skips only the very first run
     * (`digestProjectId.current === null` instead of `!== projectId`): the switch
     * read twice while the mount test stayed green.
     */
    it('reads exactly once when the button is pointed at another project', async () => {
      useWorkflowStore.getState().setList(OTHER_PROJECT_ID, [REFACTOR]);
      seedBoards({
        [PROJECT_ID]: [workflowTask('task-a', 'workflow-1', null, 'running')],
        [OTHER_PROJECT_ID]: [workflowTask('task-b', 'workflow-2', null, 'draft')],
      });
      const view = await render(buttonFor(PROJECT_ID));
      mockFetchProjectWorkflows.mockClear();

      await view.rerender(buttonFor(OTHER_PROJECT_ID));

      expect(mockFetchProjectWorkflows).toHaveBeenCalledTimes(1);
      expect(mockFetchProjectWorkflows).toHaveBeenCalledWith(OTHER_PROJECT_ID);
    });

    it('draws the button with the count of workflows', async () => {
      await renderButton();

      expect(screen.getByTestId('header-workflows-button')).toBeTruthy();
      expect(screen.getByTestId('header-workflows-count')).toHaveTextContent('2');
      expect(screen.getByTestId('header-workflows-button').props.accessibilityLabel).toBe('Workflows, 2 open');
    });

    it('opens the Workflows sheet for this project on a tap', async () => {
      await renderButton();

      await fireEvent.press(screen.getByTestId('header-workflows-button'));

      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith({ pathname: '/workflows', params: { projectId: PROJECT_ID } });
    });

    /**
     * A workflow starting, pausing, resuming or finishing reaches the phone as
     * its tasks' board rows first, so the list is read again when the set of
     * (workflow, state) pairs on the board changes.
     *
     * Mutation seen failing: dropping `digest` from the read effect's
     * dependencies: no second read followed the state change ("Expected number
     * of calls: 1, Received number of calls: 0").
     */
    it('reads the list again when a workflow\'s state changes on the board', async () => {
      seedBoards({ [PROJECT_ID]: [workflowTask('task-a', 'workflow-1', null, 'running')] });
      await renderButton();
      mockFetchProjectWorkflows.mockClear();

      await act(() => {
        seedBoards({ [PROJECT_ID]: [workflowTask('task-a', 'workflow-1', null, 'paused')] });
      });

      expect(mockFetchProjectWorkflows).toHaveBeenCalledTimes(1);
      expect(mockFetchProjectWorkflows).toHaveBeenCalledWith(PROJECT_ID);
    });

    it('does not read the list again for a board change that moves no workflow state', async () => {
      seedBoards({ [PROJECT_ID]: [workflowTask('task-a', 'workflow-1', null, 'running')] });
      await renderButton();
      mockFetchProjectWorkflows.mockClear();

      await act(() => {
        seedBoards({ [PROJECT_ID]: [workflowTask('task-a', 'workflow-1', 'sess-a', 'running')] });
      });

      expect(mockFetchProjectWorkflows).not.toHaveBeenCalled();
    });
  });

  /**
   * Toned like the Terminals button: amber when any agent of the project's
   * workflows is idle or asking, green while any works and none waits, and at
   * rest otherwise. The tone testID rides the glyph's wrapper, and exactly one
   * of the three is ever drawn.
   */
  describe('the tone', () => {
    beforeEach(() => {
      useWorkflowStore.getState().setList(PROJECT_ID, [SHIPPING, REFACTOR]);
    });

    function expectOnlyTone(tone: 'needs-you' | 'working' | 'rest'): void {
      for (const candidate of ['needs-you', 'working', 'rest'] as const) {
        if (candidate === tone) expect(screen.getByTestId(`header-workflows-${candidate}`)).toBeTruthy();
        else expect(screen.queryByTestId(`header-workflows-${candidate}`)).toBeNull();
      }
    }

    it('rests when no workflow task has an agent at all (a workflow can be all To Do, or paused)', async () => {
      seedBoards({ [PROJECT_ID]: [workflowTask('task-a', 'workflow-1', null)] });
      await renderButton();

      expectOnlyTone('rest');
      expect(screen.getByTestId('header-workflows-button').props.accessibilityLabel).toBe('Workflows, 2 open');
    });

    it('rests for a workflow list the board has no rows for yet', async () => {
      await renderButton();

      expectOnlyTone('rest');
    });

    it('rests for a paused (suspended) agent, which is waiting on nobody', async () => {
      seedBoards({ [PROJECT_ID]: [workflowTask('task-a', 'workflow-1', 'sess-a')] });
      useActivityStore.getState().registerSession('sess-a', 'task-a', PROJECT_ID);
      useActivityStore
        .getState()
        .applySnapshot('sess-a', 'task-a', PROJECT_ID, streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'suspended' }));
      await renderButton();

      expectOnlyTone('rest');
    });

    it('is green while an agent of the workflow is working', async () => {
      seedBoards({ [PROJECT_ID]: [workflowTask('task-a', 'workflow-1', 'sess-a')] });
      observeSession('sess-a', 'thinking');
      await renderButton();

      expectOnlyTone('working');
    });

    /**
     * Mutation seen failing: swapping the two arms of `sessionTone`'s final
     * ternary (a working agent read as needing you, an idle one as working):
     * five tests in this block went red, each on the wrong tone's testID.
     */
    it.each(['idle', 'permission'] as const)('turns amber when an agent is %s', async (state) => {
      seedBoards({ [PROJECT_ID]: [workflowTask('task-a', 'workflow-1', 'sess-a')] });
      observeSession('sess-a', state);
      await renderButton();

      expectOnlyTone('needs-you');
      expect(screen.getByTestId('header-workflows-button').props.accessibilityLabel).toBe('Workflows, 2 open, one or more need you');
    });

    it('turns amber when any agent waits, even while another works', async () => {
      seedBoards({ [PROJECT_ID]: [workflowTask('task-a', 'workflow-1', 'sess-a'), workflowTask('task-b', 'workflow-2', 'sess-b')] });
      observeSession('sess-a', 'thinking');
      observeSession('sess-b', 'idle');
      await renderButton();

      expectOnlyTone('needs-you');
    });

    it('reads an agent the desktop has not classified yet as working, not as needing you', async () => {
      seedBoards({ [PROJECT_ID]: [workflowTask('task-a', 'workflow-1', 'sess-a')] });
      // Registered but never snapshotted: activityObserved is still false and
      // its default state is 'idle', which must not read as the user's move yet.
      useActivityStore.getState().registerSession('sess-a', 'task-a', PROJECT_ID);
      await renderButton();

      expectOnlyTone('working');
    });

    /**
     * Only the project's LISTED workflows count. A task of any other workflow
     * (a finished one, say, which the list leaves out) says nothing here.
     *
     * Mutation seen failing: dropping the `workflowIds.has(...)` test from
     * `workflowSessionKey`: the unlisted workflow's idle agent turned the
     * button amber.
     */
    it('ignores the agents of a workflow the list does not carry', async () => {
      seedBoards({ [PROJECT_ID]: [workflowTask('task-a', 'workflow-finished', 'sess-a')] });
      observeSession('sess-a', 'idle');
      await renderButton();

      expectOnlyTone('rest');
    });

    it('ignores the agent of an ordinary task, which belongs to no workflow', async () => {
      seedBoards({ [PROJECT_ID]: [boardTaskFixture({ id: 'task-a', session_id: 'sess-a' })] });
      observeSession('sess-a', 'idle');
      await renderButton();

      expectOnlyTone('rest');
    });

    /**
     * A workflow can span boards, so its tasks' sessions are searched on every
     * loaded board, not only this one. The foreign board is listed AFTER this
     * project's, so a search that stopped at the first board would miss it.
     *
     * Mutation seen failing: searching only the first loaded board
     * (`Object.values(boardsByProjectId).slice(0, 1)`): the other board's idle
     * agent was missed and the button stayed at `header-workflows-rest`.
     */
    it('counts the agent of a workflow task that sits on another project\'s board', async () => {
      seedBoards({
        [PROJECT_ID]: [],
        [OTHER_PROJECT_ID]: [workflowTask('task-a', 'workflow-1', 'sess-a')],
      });
      observeSession('sess-a', 'idle', OTHER_PROJECT_ID);
      await renderButton();

      expectOnlyTone('needs-you');
    });

    it('follows the activity stream from working to needing you', async () => {
      seedBoards({ [PROJECT_ID]: [workflowTask('task-a', 'workflow-1', 'sess-a')] });
      observeSession('sess-a', 'thinking');
      await renderButton();
      expectOnlyTone('working');

      await act(() => {
        useActivityStore.getState().applyActivityEvent({
          kind: 'activity',
          sessionId: 'sess-a',
          taskId: 'task-a',
          payload: { type: 'permission', promptId: 'sess-a:tool-1', pending: true },
        });
      });

      expectOnlyTone('needs-you');
    });
  });
});
