import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import type { BoardTaskWire } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { WORKFLOW_READ_FAILED_MESSAGE, WorkflowScreen } from '@/screens/workflow/WorkflowScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';
import { useWorkflowStore } from '@/state/workflowStore';
import { boardColumnFixture, boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import type { WorkflowDetail, WorkflowMember } from '@/workflow/workflowView';
import { workflowDetailFixture, workflowMemberFixture, workflowWireFixture } from '../helpers/workflows';

/**
 * One workflow, as a full screen (protocol 0.21.0, design screen 7, V6): the
 * desktop's workflow canvas turned into a list that reads like the board. The
 * header is one row (task #124) that names it and holds its one Pause or
 * Resume; under it come the board's columns in board order, holding only this
 * workflow's tasks.
 *
 * The workflow below is "Ship the checkout", home project 'project-1', seven
 * tasks spread over the shapes the list has to tell apart:
 *
 *   To Do      #4 (a card, no agent), plan-7 (planned: no board row yet)
 *   Planning   #5 (a card, working)
 *   Executing  #2 (a card, working), #3 (a card, idle), #6 (compact: its board
 *              is not loaded on this phone)
 *   Done       #1 (compact: a finished task opens its run)
 */

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockPush = jest.fn();
const mockBack = jest.fn();
let mockParams: { workflowId?: string; projectId?: string } = { workflowId: 'workflow-1', projectId: 'project-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: mockPush, back: mockBack, replace: jest.fn() }),
  // The screen is always "focused" under test; the real hook runs the effect
  // on focus and the cleanup on blur, which is the same thing for one render.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]),
}));

const mockOpenProjectBoard = jest.fn();
jest.mock('@/connection/actions', () => ({
  openProjectBoard: (projectId: string) => mockOpenProjectBoard(projectId),
}));

const mockControlWorkflow = jest.fn().mockResolvedValue(undefined);
const mockFetchWorkflowDetail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/workflowActions', () => ({
  controlWorkflow: (control: string, homeProjectId: string, workflowId: string) =>
    mockControlWorkflow(control, homeProjectId, workflowId),
  fetchWorkflowDetail: (homeProjectId: string, workflowId: string) => mockFetchWorkflowDetail(homeProjectId, workflowId),
}));

const HOME_PROJECT_ID = 'project-1';
const WORKFLOW_ID = 'workflow-1';
const FIVE_MINUTES_MS = 5 * 60_000;
/** Longer than the screen's 400 ms re-read debounce, so a read it armed has fired by then. */
const PAST_REREAD_DEBOUNCE_MS = 1_000;

const SHIPPING_MEMBERS: WorkflowMember[] = [
  workflowMemberFixture({ key: '#1', taskId: 'task-a', displayId: 1, title: 'Write the plan', place: 'done', columnName: 'Done' }),
  workflowMemberFixture({ key: '#2', taskId: 'task-b', displayId: 2, title: 'Build the cart', place: 'working', columnName: 'Executing' }),
  workflowMemberFixture({ key: '#3', taskId: 'task-c', displayId: 3, title: 'Wire the payments', place: 'working', columnName: 'Executing' }),
  workflowMemberFixture({ key: '#4', taskId: 'task-d', displayId: 4, title: 'Draft the receipts', place: 'todo', columnName: 'To Do' }),
  workflowMemberFixture({ key: '#5', taskId: 'task-f', displayId: 5, title: 'Spec the refunds', place: 'working', columnName: 'Planning' }),
  workflowMemberFixture({
    key: '#6',
    taskId: 'task-e',
    displayId: 6,
    projectId: 'project-other',
    board: 'Other board',
    title: 'Sync the ledger',
    place: 'working',
    columnName: 'Executing',
  }),
  workflowMemberFixture({ key: 'plan-7', taskId: null, displayId: null, title: 'Announce it', place: 'planned', columnName: 'To Do' }),
];

function shippingDetail(overrides: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return workflowDetailFixture({ id: WORKFLOW_ID, homeProjectId: HOME_PROJECT_ID, members: SHIPPING_MEMBERS, ...overrides });
}

/** The board rows of the members whose board is loaded, each carrying the workflow in `workflowState`. */
function seedBoard(workflowState = 'running', swimlaneOf: Record<string, string> = {}): void {
  const workflow = workflowWireFixture({ id: WORKFLOW_ID, state: workflowState });
  const rowIn = (taskId: string, displayId: number, title: string, defaultLane: string, sessionId: string | null = null) =>
    boardTaskFixture({
      id: taskId,
      display_id: displayId,
      title,
      swimlane_id: swimlaneOf[taskId] ?? defaultLane,
      session_id: sessionId,
      workflow,
    });
  useBoardStore.setState({
    projects: [{ id: HOME_PROJECT_ID, name: 'Alpha' }],
    boardsByProjectId: {
      [HOME_PROJECT_ID]: {
        columns: [
          boardColumnFixture({ id: 'lane-todo', name: 'To Do', role: 'todo', position: 0 }),
          boardColumnFixture({ id: 'lane-planning', name: 'Planning', role: null, position: 1 }),
          boardColumnFixture({ id: 'lane-executing', name: 'Executing', role: null, position: 2 }),
          boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', position: 3 }),
        ],
        tasksById: {
          'task-a': rowIn('task-a', 1, 'Write the plan', 'lane-done'),
          'task-b': rowIn('task-b', 2, 'Build the cart', 'lane-executing', 'sess-b'),
          'task-c': rowIn('task-c', 3, 'Wire the payments', 'lane-executing', 'sess-c'),
          'task-d': rowIn('task-d', 4, 'Draft the receipts', 'lane-todo'),
          'task-f': rowIn('task-f', 5, 'Spec the refunds', 'lane-planning', 'sess-f'),
        },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
        commandTerminals: [],
        commandTerminalsOffered: false,
      },
    },
    pendingMoves: [],
  });
}

/** #2 and #5 work and #3 waits on the user. */
function seedSessions(): void {
  const activity = useActivityStore.getState();
  activity.registerSession('sess-b', 'task-b', HOME_PROJECT_ID);
  activity.applySnapshot('sess-b', 'task-b', HOME_PROJECT_ID, streamSnapshotFixture({ activity: { state: 'thinking', reason: null } }));
  activity.registerSession('sess-f', 'task-f', HOME_PROJECT_ID);
  activity.applySnapshot('sess-f', 'task-f', HOME_PROJECT_ID, streamSnapshotFixture({ activity: { state: 'thinking', reason: null } }));
  activity.registerSession('sess-c', 'task-c', HOME_PROJECT_ID);
  activity.applySnapshot('sess-c', 'task-c', HOME_PROJECT_ID, streamSnapshotFixture({ activity: { state: 'idle', reason: null } }));
}

/** Patches rows of the home project's board in place, so a test can give a task a description or archive it. */
function patchHomeRows(patches: Record<string, Partial<BoardTaskWire>>): void {
  const board = useBoardStore.getState().boardsByProjectId[HOME_PROJECT_ID];
  if (!board) throw new Error('board not seeded');
  const tasksById = { ...board.tasksById };
  for (const [taskId, patch] of Object.entries(patches)) {
    const row = tasksById[taskId];
    if (!row) throw new Error(`no board row for ${taskId}`);
    tasksById[taskId] = { ...row, ...patch };
  }
  useBoardStore.setState({ boardsByProjectId: { [HOME_PROJECT_ID]: { ...board, tasksById } } });
}

async function renderWorkflow(): Promise<void> {
  await render(
    <ThemeProvider>
      <WorkflowScreen />
    </ThemeProvider>,
  );
}

function sectionTestIds(): string[] {
  return screen.getAllByTestId(/^workflow-section-/).map((section) => section.props.testID as string);
}

describe('WorkflowScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { workflowId: WORKFLOW_ID, projectId: HOME_PROJECT_ID };
    useChannelStore.setState({ pairedState: 'paired', transportState: 'connected', established: true });
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useWorkflowStore.getState().reset();
  });

  describe('with the workflow read', () => {
    beforeEach(() => {
      seedBoard();
      seedSessions();
      useWorkflowStore.getState().setDetail(WORKFLOW_ID, shippingDetail());
    });

    /**
     * One row (task #124): the name on one truncating line and the one control.
     * Pause names the running state, and the sections below carry the counts,
     * so the header draws no state chip, count or tally.
     *
     * Mutations seen failing: the state chip drawn beside the title
     * (`<WorkflowStateChip state={state} />`): the header held "Running"; the
     * title given two lines (`numberOfLines={2}`): "Expected: 1, Received: 2";
     * and a tally line put back under the header (a caption reading "1 idle"):
     * it was found.
     */
    it('names the workflow in one header row, with no state chip, count or tally', async () => {
      await renderWorkflow();

      expect(screen.getByTestId('workflow-title')).toHaveTextContent('Ship the checkout');
      expect(screen.getByTestId('workflow-title').props.numberOfLines).toBe(1);
      const header = within(screen.getByTestId('workflow-header'));
      expect(header.getByTestId('workflow-pause')).toBeTruthy();
      expect(header.queryByText('Running')).toBeNull();
      expect(header.queryByText(/of 7/)).toBeNull();
      expect(screen.queryByText(/^\d+ (idle|active|waiting|done)$/)).toBeNull();
    });

    /**
     * Mutation seen failing: reversing the section sort in `groupWorkflowMembers`
     * (the operands of the order comparison swapped), which put Done first and
     * To Do last (the `toEqual` diff showed the four ids in reverse).
     */
    it('lists only the columns holding the workflow\'s tasks, in board order with Done last', async () => {
      await renderWorkflow();

      expect(sectionTestIds()).toEqual([
        'workflow-section-role:todo',
        'workflow-section-column:Planning',
        'workflow-section-column:Executing',
        'workflow-section-role:done',
      ]);
    });

    /**
     * Mutation seen failing: dropping the `section.key !== WORKFLOW_DONE_SECTION_KEY`
     * test from the item builder: the finished task in Done drew as a live card
     * and `workflow-compact-task-a` was not found.
     */
    it('draws a live card for a loaded task and a compact one for a done, unloaded or planned task', async () => {
      await renderWorkflow();

      for (const taskId of ['task-b', 'task-c', 'task-d', 'task-f']) {
        expect(screen.getByTestId(`workflow-card-${taskId}`)).toBeTruthy();
        expect(screen.queryByTestId(`workflow-compact-${taskId}`)).toBeNull();
      }
      // Done, on a board that is not loaded here, and planned (no task id: keyed by its plan key).
      for (const compactKey of ['task-a', 'task-e', 'plan-7']) {
        expect(screen.getByTestId(`workflow-compact-${compactKey}`)).toBeTruthy();
      }
      expect(screen.queryByTestId('workflow-card-task-a')).toBeNull();
      expect(screen.queryByTestId('workflow-card-task-e')).toBeNull();
    });

    /**
     * Mutation seen failing: inverting the `member.place === 'done'` gate (a
     * finished task's card opened nothing): the push mock had 0 calls.
     */
    it('opens a finished task\'s run from its compact card, and nothing from a planned one', async () => {
      await renderWorkflow();

      await fireEvent.press(screen.getByTestId('workflow-compact-task-a'));
      expect(mockPush).toHaveBeenCalledWith({ pathname: '/completed-task', params: { taskId: 'task-a', projectId: 'project-1' } });

      mockPush.mockClear();
      await fireEvent.press(screen.getByTestId('workflow-compact-plan-7'));
      await fireEvent.press(screen.getByTestId('workflow-compact-task-e'));
      expect(mockPush).not.toHaveBeenCalled();
    });

    /**
     * Mutation seen failing: dropping `showTicketNumbers &&` from the compact
     * card's number, so a board that hides numbers still showed "#1".
     */
    it('numbers a compact card only when its board shows ticket numbers', async () => {
      await renderWorkflow();
      expect(screen.getByTestId('workflow-compact-task-a')).toHaveTextContent('#1', { exact: false });

      const board = useBoardStore.getState().boardsByProjectId[HOME_PROJECT_ID];
      if (!board) throw new Error('board not seeded');
      await act(async () => {
        useBoardStore.setState({ boardsByProjectId: { [HOME_PROJECT_ID]: { ...board, showTicketNumbers: false } } });
      });

      expect(screen.getByTestId('workflow-compact-task-a')).not.toHaveTextContent('#1', { exact: false });
    });

    it('opens the long-press hub for a card\'s task on its own board', async () => {
      await renderWorkflow();

      await fireEvent(screen.getByTestId('workflow-card-task-b'), 'longPress');

      expect(mockPush).toHaveBeenCalledWith({ pathname: '/task-actions', params: { taskId: 'task-b', projectId: 'project-1' } });
    });

    /**
     * #3's row is archived while it still names a working column (Executing). It
     * draws compact, as a finished task does, and the section headers follow it
     * to Done.
     *
     * Two guards stand behind this and either alone holds the compact card:
     * `groupWorkflowMembers` files an archived row under Done, and the item
     * builder then draws the Done section compact; the builder's own
     * `row.archived_at === null` test is a second line behind the first. So the
     * mutation named for the builder's test alone stays GREEN (it is redundant,
     * not wrong). What this pins is the pair.
     *
     * Mutations seen failing: (1) the builder's `archived_at === null` test
     * dropped AND the `rowFor` handed to `groupWorkflowMembers` returning the row
     * with `archived_at: null`, which together draw the card ("Unable to find an
     * element with testID: workflow-compact-task-c"); (2) the `rowFor` change
     * alone, which keeps the compact card but leaves the task in Executing
     * ("Expected: "Executing, 2", Received: "Executing, 3"").
     */
    it('draws an archived task compact and files it under Done, though its row still names a working column', async () => {
      patchHomeRows({ 'task-c': { archived_at: '2026-10-16T09:00:00.000Z' } });
      await renderWorkflow();

      expect(screen.getByTestId('workflow-compact-task-c')).toBeTruthy();
      expect(screen.queryByTestId('workflow-card-task-c')).toBeNull();
      expect(screen.getByTestId('workflow-section-column:Executing').props.accessibilityLabel).toBe('Executing, 2');
      expect(screen.getByTestId('workflow-section-role:done').props.accessibilityLabel).toBe('Done, 2');
    });

    describe('its cards, the canvas variant', () => {
      /**
       * Every row here carries the workflow, which is exactly what makes the
       * board variant draw the workflow's name in the band in place of the
       * project's. The canvas does the reverse: the whole view is about the
       * workflow, and its tasks can sit on several boards.
       *
       * Mutations seen failing: `variant="canvas"` changed to `variant="board"`
       * in the screen's `renderItem` ("Unable to find an element with testID:
       * workflow-card-task-b-column-project", the dump showing
       * `-column-workflow-name` in its place); and, in `BoardTaskCard`, the
       * strip's `workflow` no longer cleared for the canvas (the same message).
       */
      it('names a card\'s project in its band, and not the workflow', async () => {
        await renderWorkflow();

        for (const taskId of ['task-b', 'task-d']) {
          expect(screen.getByTestId(`workflow-card-${taskId}-column-project`)).toHaveTextContent('Alpha');
          expect(screen.queryByTestId(`workflow-card-${taskId}-column-workflow-name`)).toBeNull();
        }
      });

      /**
       * The body is the agent's last line while a session runs, as on the Agents
       * feed, and nothing otherwise, even when the row has a description.
       *
       * Mutations seen failing: `variant="board"` in the screen's `renderItem`
       * (the sessionless card drew its description: "expect(received).toBeNull()
       * ... testID="workflow-card-task-d-snippet">Draft the receipts template.");
       * in `BoardTaskCard`, the not-running arm of the canvas body changed from
       * `''` to the description (the same line); and the running arm ignoring the
       * agent's line ("Expected instance to have text content: Wiring the cart
       * totals. Received: Plan the cart schema.").
       */
      it('draws no description on a card without a running agent, and the agent\'s last line on one with', async () => {
        patchHomeRows({
          'task-b': { description: 'Plan the cart schema.' },
          'task-d': { description: 'Draft the receipts template.' },
        });
        useActivityStore.getState().applyActivityEvent({
          kind: 'activity',
          sessionId: 'sess-b',
          taskId: 'task-b',
          payload: { type: 'message-preview', text: 'Wiring the cart totals.' },
        });
        await renderWorkflow();

        expect(screen.queryByTestId('workflow-card-task-d-snippet')).toBeNull();
        expect(screen.queryByText('Draft the receipts template.')).toBeNull();
        expect(screen.getByTestId('workflow-card-task-b-snippet')).toHaveTextContent('Wiring the cart totals.');
        expect(screen.queryByText('Plan the cart schema.')).toBeNull();
      });

      /**
       * The wait label (the band's "5m") is the canvas's own: the board card
       * draws none. It renders nothing for a session's first minute, so the
       * idle agent here has been waiting five.
       *
       * Mutations seen failing: `variant="board"` in the screen's `renderItem`,
       * and, in `BoardTaskCard`, the canvas-only `waitingSinceMs` gate inverted
       * to `board` (both: "Unable to find an element with testID:
       * workflow-card-task-c-wait").
       */
      it('shows how long an idle agent has waited on the user, and nothing for one that works', async () => {
        useActivityStore
          .getState()
          .applySnapshot(
            'sess-c',
            'task-c',
            HOME_PROJECT_ID,
            streamSnapshotFixture({ activity: { state: 'idle', reason: { kind: 'idle', since: Date.now() - FIVE_MINUTES_MS } } }),
          );
        await renderWorkflow();

        expect(screen.getByTestId('workflow-card-task-c-wait')).toHaveTextContent('5m');
        expect(screen.queryByTestId('workflow-card-task-b-wait')).toBeNull();
      });

      /**
       * Kangentic #923: a task of a RUNNING workflow held by its own automations
       * switch wears the "Automations paused" strip over its band here too, and
       * its To Do footer reads Paused rather than the engine's queue. The
       * unheld cards beside it wear neither.
       *
       * Mutations seen failing: BoardTaskCard passing `held` as false to
       * workflowWaitingFooter (the footer label was not "Paused"), and passing
       * `automationsDisabled={false}` to TaskCard (the strip testID was not found).
       */
      it('stacks the paused strip over a held task\'s band and reads Paused in its To Do footer', async () => {
        patchHomeRows({ 'task-d': { automations_disabled: true } });
        await renderWorkflow();

        expect(screen.getByTestId('workflow-card-task-d-automations-disabled')).toHaveTextContent('Automations paused');
        expect(screen.getByTestId('workflow-card-task-d-status-bar-label')).toHaveTextContent('Paused');
        expect(screen.queryByTestId('workflow-card-task-b-automations-disabled')).toBeNull();
      });
    });

    it('opens every board a task of the workflow sits on, in full', async () => {
      await renderWorkflow();

      expect(mockOpenProjectBoard).toHaveBeenCalledWith('project-1');
      expect(mockOpenProjectBoard).toHaveBeenCalledWith('project-other');
    });

    it('reads the workflow when the screen is focused, asked of its home project', async () => {
      await renderWorkflow();

      expect(mockFetchWorkflowDetail).toHaveBeenCalledWith(HOME_PROJECT_ID, WORKFLOW_ID);
    });
  });

  describe('Pause and Resume', () => {
    beforeEach(() => {
      seedSessions();
    });

    /**
     * Mutation seen failing: reading the control backwards
     * (`state === 'paused' ? 'pause' : 'resume'`): the running workflow's
     * button called `controlWorkflow` with "resume" (and the paused one with
     * "pause"), the Expected/Received diff on the call's first argument.
     */
    it('offers Pause while the workflow runs, and pauses it at once, with no confirmation', async () => {
      seedBoard('running');
      useWorkflowStore.getState().setDetail(WORKFLOW_ID, shippingDetail());
      await renderWorkflow();

      expect(screen.queryByTestId('workflow-resume')).toBeNull();
      await fireEvent.press(screen.getByTestId('workflow-pause'));

      expect(mockControlWorkflow).toHaveBeenCalledTimes(1);
      expect(mockControlWorkflow).toHaveBeenCalledWith('pause', HOME_PROJECT_ID, WORKFLOW_ID);
    });

    it('offers Resume while the workflow is paused, and resumes it', async () => {
      seedBoard('paused');
      useWorkflowStore.getState().setDetail(WORKFLOW_ID, shippingDetail({ state: 'paused' }));
      await renderWorkflow();

      expect(screen.queryByTestId('workflow-pause')).toBeNull();
      await fireEvent.press(screen.getByTestId('workflow-resume'));

      expect(mockControlWorkflow).toHaveBeenCalledTimes(1);
      expect(mockControlWorkflow).toHaveBeenCalledWith('resume', HOME_PROJECT_ID, WORKFLOW_ID);
    });

    /**
     * The board rows are newer than the last read, so the header follows THEM.
     * Here the read still says running while every row already says paused.
     * The header names no state word while paused either (task #124): Resume
     * is the whole signal. It is scoped to the header because a task card
     * below can show its own "Paused" waiting footer.
     *
     * Mutations seen failing: taking the state from the read alone
     * (`detail?.state`): the header kept offering Pause ("Unable to find an
     * element with testID: workflow-resume", with `workflow-pause` in the dump);
     * and the state chip drawn beside the title only while paused
     * (`state === 'paused' ? <WorkflowStateChip state={state} /> : null`): the
     * header held "Paused" (`expect(received).toBeNull()` received the
     * chip's Text).
     */
    it('follows the board rows rather than the older read for the state', async () => {
      seedBoard('paused');
      useWorkflowStore.getState().setDetail(WORKFLOW_ID, shippingDetail({ state: 'running' }));
      await renderWorkflow();

      expect(screen.getByTestId('workflow-resume')).toBeTruthy();
      expect(screen.queryByTestId('workflow-pause')).toBeNull();
      expect(within(screen.getByTestId('workflow-header')).queryByText('Paused')).toBeNull();
    });

    it('swaps Pause for Resume as the rows report the pause', async () => {
      seedBoard('running');
      useWorkflowStore.getState().setDetail(WORKFLOW_ID, shippingDetail());
      await renderWorkflow();
      expect(screen.getByTestId('workflow-pause')).toBeTruthy();

      await act(() => {
        seedBoard('paused');
      });

      expect(screen.getByTestId('workflow-resume')).toBeTruthy();
      expect(screen.queryByTestId('workflow-pause')).toBeNull();
    });

    /**
     * With no button, the header names no state either (task #124, decision
     * G1): the list shows it, every task planned in To Do or every task in Done.
     *
     * Mutation seen failing: the state chip drawn beside the title
     * (`<WorkflowStateChip state={state} />`): the header held "Not started" and
     * "Complete".
     */
    it.each(['draft', 'done'] as const)('offers neither for a workflow that is %s, and names no state', async (state) => {
      useWorkflowStore
        .getState()
        .setDetail(WORKFLOW_ID, shippingDetail({ state, members: [workflowMemberFixture({ key: 'plan-1', taskId: null, place: 'planned' })] }));
      await renderWorkflow();

      expect(screen.getByTestId('workflow-title')).toHaveTextContent('Ship the checkout');
      expect(screen.queryByTestId('workflow-pause')).toBeNull();
      expect(screen.queryByTestId('workflow-resume')).toBeNull();
      expect(within(screen.getByTestId('workflow-header')).queryByText(/Not started|Complete/)).toBeNull();
    });

    /**
     * Mutation seen failing: dropping the pill's `disabled` prop (its
     * accessibilityState still said disabled, and a second tap called
     * `controlWorkflow` again): "Expected number of calls: 0, Received number
     * of calls: 1".
     */
    it('reads "Pausing..." and takes no second tap while the desktop answers', async () => {
      seedBoard('running');
      useWorkflowStore.getState().setDetail(WORKFLOW_ID, shippingDetail());
      await renderWorkflow();

      await act(() => {
        useWorkflowStore.getState().beginControl(WORKFLOW_ID, 'pausing');
      });

      expect(screen.getByTestId('workflow-pause')).toHaveTextContent('Pausing...');
      expect(screen.getByTestId('workflow-pause').props.accessibilityState.disabled).toBe(true);
      await fireEvent.press(screen.getByTestId('workflow-pause'));
      expect(mockControlWorkflow).not.toHaveBeenCalled();
    });

    /**
     * Mutation seen failing: not rendering the store's failure line: the refusal
     * the desktop sent never reached the screen (`workflow-control-failed` was
     * not found).
     */
    it('shows the line a refused Pause or Resume left, and none otherwise', async () => {
      seedBoard('running');
      useWorkflowStore.getState().setDetail(WORKFLOW_ID, shippingDetail());
      await renderWorkflow();
      expect(screen.queryByTestId('workflow-control-failed')).toBeNull();

      await act(() => {
        useWorkflowStore.getState().beginControl(WORKFLOW_ID, 'pausing');
        useWorkflowStore.getState().endControl(WORKFLOW_ID, 'Could not pause the workflow');
      });

      expect(screen.getByTestId('workflow-control-failed')).toHaveTextContent('Could not pause the workflow');
    });
  });

  describe('before the workflow is read', () => {
    it('shows placeholders while there is nothing to draw, and no list', async () => {
      await renderWorkflow();

      expect(screen.getByTestId('workflow-loading')).toBeTruthy();
      expect(screen.queryByTestId('workflow-list')).toBeNull();
      expect(screen.queryByTestId('workflow-read-failed')).toBeNull();
    });

    it('keeps the placeholders while the first read is in flight', async () => {
      useWorkflowStore.getState().markDetailLoading(WORKFLOW_ID);
      await renderWorkflow();

      expect(screen.getByTestId('workflow-loading')).toBeTruthy();
    });

    /**
     * The retry is the focus read's twin, so the mount's own read is cleared
     * first: exactly ONE call, from the press, proves the button does the work.
     *
     * Mutation seen failing: a retry button with no handler: no
     * `fetchWorkflowDetail` call followed the press ("Expected number of calls:
     * 1, Received number of calls: 0").
     */
    it('says the read failed and retries it from the home project', async () => {
      useWorkflowStore.getState().markDetailFailed(WORKFLOW_ID);
      await renderWorkflow();
      expect(within(screen.getByTestId('workflow-read-failed')).getByText(WORKFLOW_READ_FAILED_MESSAGE)).toBeTruthy();
      expect(screen.queryByTestId('workflow-loading')).toBeNull();
      mockFetchWorkflowDetail.mockClear();

      await fireEvent.press(screen.getByTestId('workflow-retry'));

      expect(mockFetchWorkflowDetail).toHaveBeenCalledTimes(1);
      expect(mockFetchWorkflowDetail).toHaveBeenCalledWith(HOME_PROJECT_ID, WORKFLOW_ID);
    });

    /**
     * A route that names no workflow or no project has nothing to ask, so no
     * read is ever in flight or going to fail: it must say so rather than hold
     * the skeleton forever, and offer no retry that could not do anything.
     * Nothing is seeded, as a bad deep link would find it.
     *
     * Mutations seen failing: `loading` and `failed` taken back to
     * `detail === null && detailRead?.status !== 'failed'` and `... === 'failed'`
     * (no `routable`): every row held the skeleton ("expect(received).toBeNull()
     * ... testID="workflow-loading""); and, with those restored, the retry button
     * made unconditional: every row still drew `workflow-retry` ("expect(received).toBeNull()
     * ... testID="workflow-retry"", at the retry assertion).
     */
    it.each([
      { description: 'no workflow id', params: { projectId: HOME_PROJECT_ID } },
      { description: 'an empty workflow id', params: { workflowId: '', projectId: HOME_PROJECT_ID } },
      { description: 'no project id', params: { workflowId: WORKFLOW_ID } },
      { description: 'an empty project id', params: { workflowId: WORKFLOW_ID, projectId: '' } },
      { description: 'neither id', params: {} },
    ] as { description: string; params: { workflowId?: string; projectId?: string } }[])(
      'says the read failed, with no skeleton and no retry, for a route with $description',
      async ({ params }) => {
        mockParams = params;
        await renderWorkflow();

        expect(screen.queryByTestId('workflow-loading')).toBeNull();
        expect(within(screen.getByTestId('workflow-read-failed')).getByText(WORKFLOW_READ_FAILED_MESSAGE)).toBeTruthy();
        expect(screen.queryByTestId('workflow-retry')).toBeNull();
        expect(mockFetchWorkflowDetail).not.toHaveBeenCalled();
      },
    );

    it('keeps drawing the last good read when a re-read fails', async () => {
      seedBoard();
      useWorkflowStore.getState().setDetail(WORKFLOW_ID, shippingDetail());
      await renderWorkflow();

      await act(() => {
        useWorkflowStore.getState().markDetailFailed(WORKFLOW_ID);
      });

      expect(screen.getByTestId('workflow-list')).toBeTruthy();
      expect(screen.queryByTestId('workflow-read-failed')).toBeNull();
      expect(screen.queryByTestId('workflow-loading')).toBeNull();
    });
  });

  describe('as the board changes', () => {
    /**
     * A task moving, finishing or pausing reaches the phone as a board row
     * first, and the workflow's own read (its order, its counts) follows it,
     * debounced so a burst of task events costs one read.
     *
     * Mutation seen failing: disabling the digest effect (it returned before
     * arming its timer): no read followed the move ("Expected number of calls:
     * 1, Received number of calls: 0").
     */
    it('reads the workflow again, once, shortly after one of its tasks moves', async () => {
      jest.useFakeTimers();
      try {
        seedBoard();
        useWorkflowStore.getState().setDetail(WORKFLOW_ID, shippingDetail());
        await renderWorkflow();
        await act(() => {
          jest.advanceTimersByTime(1_000);
        });
        mockFetchWorkflowDetail.mockClear();

        await act(() => {
          seedBoard('running', { 'task-d': 'lane-planning' });
        });
        expect(mockFetchWorkflowDetail).not.toHaveBeenCalled();
        await act(() => {
          jest.advanceTimersByTime(1_000);
        });

        expect(mockFetchWorkflowDetail).toHaveBeenCalledTimes(1);
        expect(mockFetchWorkflowDetail).toHaveBeenCalledWith(HOME_PROJECT_ID, WORKFLOW_ID);
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * Opening the screen costs ONE read, the focus read. A read already cached
     * when it opens is not a board change, so its digest must not arm the
     * debounced re-read as well. Nothing is cleared between the render and the
     * count: a cleared mock would hide the second read.
     *
     * Mutation seen failing: removing the `rowsDigestSeen` early return from the
     * digest effect, so the first digest armed the timer: "Expected number of
     * calls: 1, Received number of calls: 2".
     */
    it('reads the workflow once when it opens on a cached read, and not again after the debounce', async () => {
      jest.useFakeTimers();
      try {
        seedBoard();
        useWorkflowStore.getState().setDetail(WORKFLOW_ID, shippingDetail());
        await renderWorkflow();
        await act(() => {
          jest.advanceTimersByTime(PAST_REREAD_DEBOUNCE_MS);
        });

        expect(mockFetchWorkflowDetail).toHaveBeenCalledTimes(1);
        expect(mockFetchWorkflowDetail).toHaveBeenCalledWith(HOME_PROJECT_ID, WORKFLOW_ID);
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * The same, when the first read lands after the screen opened: it is the
     * read the focus read asked for, so it costs no second one. A later move
     * still does, so the skip is exactly one digest and not the rest of the
     * screen's life.
     *
     * Mutations seen failing: the same removal ("Expected number of calls: 1,
     * Received number of calls: 2" after the read landed); and the opposite, the
     * skip made unconditional so no digest ever arms the timer ("Expected number
     * of calls: 2, Received number of calls: 1" after the move).
     */
    it('does not read again for the read that lands after it opened, only for a move after that', async () => {
      jest.useFakeTimers();
      try {
        seedBoard();
        await renderWorkflow();
        expect(mockFetchWorkflowDetail).toHaveBeenCalledTimes(1);

        await act(() => {
          useWorkflowStore.getState().setDetail(WORKFLOW_ID, shippingDetail());
        });
        await act(() => {
          jest.advanceTimersByTime(PAST_REREAD_DEBOUNCE_MS);
        });
        expect(mockFetchWorkflowDetail).toHaveBeenCalledTimes(1);

        await act(() => {
          seedBoard('running', { 'task-d': 'lane-planning' });
        });
        await act(() => {
          jest.advanceTimersByTime(PAST_REREAD_DEBOUNCE_MS);
        });
        expect(mockFetchWorkflowDetail).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * The row outranks the older read: the read still says #4 is in To Do (its
     * `columnName` and `place`), and the live row says Planning. The section
     * headers carry how many tasks each holds, which is what moves.
     *
     * Mutation seen failing: ignoring the live row's column in
     * `groupWorkflowMembers` (`liveColumn` forced to null), so #4 stayed in To Do
     * on the read's word: the To Do header still read "To Do, 2" after the move
     * ("Expected: "To Do, 1", Received: "To Do, 2"").
     */
    it('moves a card to its new column section as its row moves, ahead of the next read', async () => {
      seedBoard();
      useWorkflowStore.getState().setDetail(WORKFLOW_ID, shippingDetail());
      await renderWorkflow();
      expect(screen.getByTestId('workflow-section-role:todo').props.accessibilityLabel).toBe('To Do, 2');
      expect(screen.getByTestId('workflow-section-column:Planning').props.accessibilityLabel).toBe('Planning, 1');

      // #4 moves to Planning; plan-7 still holds To Do.
      await act(() => {
        seedBoard('running', { 'task-d': 'lane-planning' });
      });

      expect(screen.getByTestId('workflow-section-role:todo').props.accessibilityLabel).toBe('To Do, 1');
      expect(screen.getByTestId('workflow-section-column:Planning').props.accessibilityLabel).toBe('Planning, 2');
      expect(screen.getByTestId('workflow-card-task-d')).toBeTruthy();
    });
  });
});
