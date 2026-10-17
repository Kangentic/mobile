import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { WORKFLOWS_READ_FAILED_MESSAGE, WorkflowsScreen } from '@/screens/WorkflowsScreen';
import { useBoardStore } from '@/state/boardStore';
import { useWorkflowStore } from '@/state/workflowStore';
import type { WorkflowListEntry, WorkflowMember } from '@/workflow/workflowView';
import { workflowDetailFixture, workflowMemberFixture } from '../helpers/workflows';

/**
 * The Workflows sheet (protocol 0.21.0, design screen 6): a project's
 * unfinished workflows, one raised row each, reading the same on every row - the
 * glyph, the name, the desktop's state chip and its count ("1 of 6", or "5
 * tasks" before it starts). The count needs the workflow's own read, so it
 * appears once that read lands.
 */

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockBack = jest.fn();
let mockCanGoBack = true;
let mockParams: { projectId?: string } = { projectId: 'project-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: mockReplace, push: mockPush, back: mockBack, canGoBack: () => mockCanGoBack }),
}));

const mockFetchProjectWorkflows = jest.fn().mockResolvedValue(undefined);
const mockFetchWorkflowDetail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/workflowActions', () => ({
  fetchProjectWorkflows: (projectId: string) => mockFetchProjectWorkflows(projectId),
  fetchWorkflowDetail: (homeProjectId: string, workflowId: string) => mockFetchWorkflowDetail(homeProjectId, workflowId),
}));

const PROJECT_ID = 'project-1';
const SHIPPING: WorkflowListEntry = { id: 'workflow-1', title: 'Ship the checkout', state: 'running' };
const REFACTOR: WorkflowListEntry = { id: 'workflow-2', title: 'Refactor the cart', state: 'draft' };

/** `count` tasks of a workflow, the first `doneCount` of them done. */
function membersOf(count: number, doneCount: number): WorkflowMember[] {
  return Array.from({ length: count }, (_unused, index) =>
    workflowMemberFixture({
      key: `#${index + 1}`,
      taskId: `task-${index + 1}`,
      displayId: index + 1,
      place: index < doneCount ? 'done' : 'working',
    }),
  );
}

async function renderSheet(): Promise<void> {
  await render(
    <ThemeProvider>
      <WorkflowsScreen />
    </ThemeProvider>,
  );
}

describe('WorkflowsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanGoBack = true;
    mockParams = { projectId: PROJECT_ID };
    useBoardStore.getState().reset();
    useWorkflowStore.getState().reset();
    useWorkflowStore.getState().setList(PROJECT_ID, [SHIPPING, REFACTOR]);
  });

  it('draws a row per listed workflow, with its name and the desktop\'s state chip', async () => {
    await renderSheet();

    const shippingRow = screen.getByTestId('workflows-row-workflow-1');
    expect(within(shippingRow).getByText('Ship the checkout')).toBeTruthy();
    expect(within(screen.getByTestId('workflows-row-workflow-1-summary-state')).getByText('Running')).toBeTruthy();

    const refactorRow = screen.getByTestId('workflows-row-workflow-2');
    expect(within(refactorRow).getByText('Refactor the cart')).toBeTruthy();
    expect(within(screen.getByTestId('workflows-row-workflow-2-summary-state')).getByText('Not started')).toBeTruthy();
  });

  /**
   * The count is the workflow's own read, so a row draws its chip at once and
   * its count when that read lands.
   *
   * Mutation seen failing: handing the summary `taskCount={null}`: the pill
   * never appeared, so the second half of this test found no
   * `workflows-row-workflow-1-summary-count` (and the two sibling count tests
   * below went red the same way).
   */
  it('draws no count until the workflow\'s own read lands, then "1 of 6" for a running one and "5 tasks" for a draft', async () => {
    await renderSheet();
    expect(screen.queryByTestId('workflows-row-workflow-1-summary-count')).toBeNull();
    expect(screen.queryByTestId('workflows-row-workflow-2-summary-count')).toBeNull();

    await act(() => {
      useWorkflowStore.getState().setDetail('workflow-1', workflowDetailFixture({ id: 'workflow-1', members: membersOf(6, 1) }));
      useWorkflowStore
        .getState()
        .setDetail('workflow-2', workflowDetailFixture({ id: 'workflow-2', state: 'draft', members: membersOf(5, 0) }));
    });

    expect(screen.getByTestId('workflows-row-workflow-1-summary-count')).toHaveTextContent('1 of 6');
    expect(screen.getByTestId('workflows-row-workflow-2-summary-count')).toHaveTextContent('5 tasks');
  });

  /**
   * Mutation seen failing: counting a constant 0 done (`doneCount` forced to
   * 0 once the detail is held): the pill read "0 of 6" where "4 of 6" was
   * expected.
   */
  it('counts the done tasks of the workflow, not a fixed number', async () => {
    useWorkflowStore.getState().setDetail('workflow-1', workflowDetailFixture({ id: 'workflow-1', members: membersOf(6, 4) }));
    await renderSheet();

    expect(screen.getByTestId('workflows-row-workflow-1-summary-count')).toHaveTextContent('4 of 6');
  });

  it('spells a single task of a draft in the singular', async () => {
    useWorkflowStore
      .getState()
      .setDetail('workflow-2', workflowDetailFixture({ id: 'workflow-2', state: 'draft', members: membersOf(1, 0) }));
    await renderSheet();

    expect(screen.getByTestId('workflows-row-workflow-2-summary-count')).toHaveTextContent('1 task');
  });

  /**
   * REPLACE, not push: the sheet is finished with once a workflow is chosen, so
   * Back from the workflow view returns to the Board rather than to a sheet.
   *
   * Mutation seen failing: `router.push` in place of `router.replace`: "Expected
   * number of calls: 1, Received number of calls: 0" on the replace mock.
   */
  it('replaces itself with the workflow view, carrying the project the sheet was opened for', async () => {
    await renderSheet();

    await fireEvent.press(screen.getByTestId('workflows-row-workflow-2'));

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/workflow',
      params: { workflowId: 'workflow-2', projectId: PROJECT_ID },
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  describe('its reads', () => {
    it('reads the project\'s list when it opens', async () => {
      await renderSheet();

      expect(mockFetchProjectWorkflows).toHaveBeenCalledWith(PROJECT_ID);
    });

    /**
     * Mutation seen failing: emptying the per-workflow loop: "Expected number
     * of calls: 2, Received number of calls: 0" on `fetchWorkflowDetail`, so no
     * row would ever get its count.
     */
    it('reads every listed workflow, from the project it was opened for', async () => {
      await renderSheet();

      expect(mockFetchWorkflowDetail).toHaveBeenCalledTimes(2);
      expect(mockFetchWorkflowDetail).toHaveBeenCalledWith(PROJECT_ID, 'workflow-1');
      expect(mockFetchWorkflowDetail).toHaveBeenCalledWith(PROJECT_ID, 'workflow-2');
    });

    it('reads nothing and lists nothing when the route carries no project', async () => {
      mockParams = {};
      await renderSheet();

      expect(mockFetchProjectWorkflows).not.toHaveBeenCalled();
      expect(mockFetchWorkflowDetail).not.toHaveBeenCalled();
      expect(screen.queryByTestId('workflows-row-workflow-1')).toBeNull();
    });
  });

  describe('when there is nothing to list', () => {
    /**
     * Mutation seen failing: removing the `router.back()` call from the effect
     * ("Expected number of calls: 1, Received number of calls: 0" on back): the
     * sheet stayed open over a Board whose Workflows button had gone.
     */
    it('closes once the list reads empty, because the last workflow finished while it was open', async () => {
      await renderSheet();
      expect(mockBack).not.toHaveBeenCalled();

      await act(() => {
        useWorkflowStore.getState().setList(PROJECT_ID, []);
      });

      expect(mockBack).toHaveBeenCalledTimes(1);
    });

    it('does not close a sheet that has nothing to go back to', async () => {
      mockCanGoBack = false;
      await renderSheet();

      await act(() => {
        useWorkflowStore.getState().setList(PROJECT_ID, []);
      });

      expect(mockBack).not.toHaveBeenCalled();
    });

    it('does not close while a re-read is merely in flight over the last good list', async () => {
      await renderSheet();

      await act(() => {
        useWorkflowStore.getState().markListLoading(PROJECT_ID);
      });

      expect(mockBack).not.toHaveBeenCalled();
      expect(screen.getByTestId('workflows-row-workflow-1')).toBeTruthy();
    });

    it('says so, and does not close, when the read failed with nothing held', async () => {
      useWorkflowStore.getState().reset();
      useWorkflowStore.getState().markListFailed(PROJECT_ID);
      await renderSheet();

      expect(screen.getByTestId('workflows-read-failed')).toHaveTextContent(WORKFLOWS_READ_FAILED_MESSAGE);
      expect(mockBack).not.toHaveBeenCalled();
    });

    it('keeps the last good rows, and says nothing, when a re-read fails', async () => {
      await renderSheet();

      await act(() => {
        useWorkflowStore.getState().markListFailed(PROJECT_ID);
      });

      expect(screen.getByTestId('workflows-row-workflow-1')).toBeTruthy();
      expect(screen.queryByTestId('workflows-read-failed')).toBeNull();
    });
  });
});
