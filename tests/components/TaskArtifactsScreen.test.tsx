import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import type { BoardTaskArtifactWire } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { TaskArtifactsScreen } from '@/screens/TaskArtifactsScreen';
import { useBoardStore, type ArchivedTasks } from '@/state/boardStore';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockBack = jest.fn();
let mockCanGoBack = true;
let mockParams: { taskId?: string } = { taskId: 'task-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: mockBack, canGoBack: () => mockCanGoBack, replace: jest.fn(), push: jest.fn() }),
}));

const mockOpenURL = jest.fn().mockResolvedValue(true);
jest.mock('expo-linking', () => ({
  openURL: (url: string) => mockOpenURL(url),
}));

const mockReportHandledError = jest.fn();
jest.mock('@/observability/crashReporting', () => ({
  reportHandledError: (site: string, error: unknown) => mockReportHandledError(site, error),
}));

const FIGMA: BoardTaskArtifactWire = { url: 'https://www.figma.com/file/abc', name: 'Checkout design' };
const PLAN: BoardTaskArtifactWire = { url: 'https://claude.ai/chat/xyz', name: 'Plan' };
const INSECURE: BoardTaskArtifactWire = { url: 'http://example.com/page', name: 'Insecure' };

function seedLiveTask(artifacts: BoardTaskArtifactWire[] | null): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture({ id: 'lane-todo', name: 'To Do', position: 0 })],
        tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-todo', artifacts }) },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
        commandTerminals: [],
        commandTerminalsOffered: false,
        resumeOnOpenOffered: false,
        priorities: null,
      },
    },
  });
}

function seedArchivedTask(artifacts: BoardTaskArtifactWire[]): void {
  const archived: ArchivedTasks = {
    tasks: [boardTaskFixture({ id: 'task-1', artifacts })],
    totalCount: 1,
    summariesByTaskId: {},
    nextOffset: 1,
    loading: false,
  };
  useBoardStore.setState({ archivedByProjectId: { 'project-1': archived }, archivedProjectOrder: ['project-1'] });
}

async function renderSheet(): Promise<void> {
  await render(
    <ThemeProvider>
      <TaskArtifactsScreen />
    </ThemeProvider>,
  );
}

async function pressRow(index: number): Promise<void> {
  await act(async () => {
    await fireEvent.press(screen.getByTestId(`task-artifacts-row-${index}`));
  });
}

describe('TaskArtifactsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanGoBack = true;
    mockParams = { taskId: 'task-1' };
    useBoardStore.getState().reset();
  });

  /** Mutation seen failing: the row map rendering `links.slice(1)` (the first row went missing). */
  it('lists one row per https link, with its name and host', async () => {
    seedLiveTask([FIGMA, PLAN]);
    await renderSheet();

    const first = screen.getByTestId('task-artifacts-row-0');
    expect(within(first).getByText('Checkout design')).toBeTruthy();
    expect(within(first).getByText('figma.com')).toBeTruthy();
    const second = screen.getByTestId('task-artifacts-row-1');
    expect(within(second).getByText('Plan')).toBeTruthy();
    expect(within(second).getByText('claude.ai')).toBeTruthy();
    expect(screen.queryByTestId('task-artifacts-row-2')).toBeNull();
  });

  /** Mutation seen failing: useTaskArtifactLinks skipping openableArtifacts' https filter (a third row for the http link). */
  it('leaves a link that is not https out of the list', async () => {
    seedLiveTask([FIGMA, INSECURE, PLAN]);
    await renderSheet();

    expect(screen.getByTestId('task-artifacts-row-0')).toBeTruthy();
    expect(screen.getByTestId('task-artifacts-row-1')).toBeTruthy();
    expect(screen.queryByTestId('task-artifacts-row-2')).toBeNull();
    expect(screen.queryByText('Insecure')).toBeNull();
  });

  /** Mutation seen failing: the then-branch no longer calling router.back(). */
  it('opens the pressed link in the OS handler and closes the sheet', async () => {
    seedLiveTask([FIGMA, PLAN]);
    await renderSheet();

    await pressRow(1);

    expect(mockOpenURL).toHaveBeenCalledWith('https://claude.ai/chat/xyz');
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('task-artifacts-error')).toBeNull();
    expect(mockReportHandledError).not.toHaveBeenCalled();
  });

  /**
   * Mutation seen failing: the rejection handler removed (no error line; back
   * still called by a then-only chain), and the door call removed (the
   * refusal shown to the person never reported).
   */
  it('says "Could not open the link", reports it, and stays open when the OS refuses the link', async () => {
    seedLiveTask([FIGMA, PLAN]);
    const refusal = new Error('No app can handle this link');
    mockOpenURL.mockRejectedValueOnce(refusal);
    await renderSheet();

    await pressRow(0);

    expect(screen.getByTestId('task-artifacts-error')).toHaveTextContent('Could not open the link');
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReportHandledError).toHaveBeenCalledTimes(1);
    expect(mockReportHandledError).toHaveBeenCalledWith('task-artifact-open', refusal);
  });

  it('clears the error line when the next press is tried', async () => {
    seedLiveTask([FIGMA, PLAN]);
    mockOpenURL.mockRejectedValueOnce(new Error('No app can handle this link'));
    await renderSheet();
    await pressRow(0);
    expect(screen.getByTestId('task-artifacts-error')).toBeTruthy();

    await pressRow(1);

    expect(screen.queryByTestId('task-artifacts-error')).toBeNull();
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('does not pop a screen that cannot go back', async () => {
    mockCanGoBack = false;
    seedLiveTask([FIGMA, PLAN]);
    await renderSheet();

    await pressRow(0);

    expect(mockOpenURL).toHaveBeenCalledTimes(1);
    expect(mockBack).not.toHaveBeenCalled();
  });

  /**
   * A completed task is held in its project's archive, not on the live board,
   * and its page carries the links too. Mutation seen failing: the archived
   * lookup removed from useTaskArtifactLinks (no rows for the archived task).
   */
  it('finds the links of an ARCHIVED task as well as a live one', async () => {
    seedArchivedTask([FIGMA, PLAN]);
    await renderSheet();

    expect(within(screen.getByTestId('task-artifacts-row-0')).getByText('Checkout design')).toBeTruthy();
    expect(within(screen.getByTestId('task-artifacts-row-1')).getByText('Plan')).toBeTruthy();
  });

  it('lists no rows for a task with no links', async () => {
    seedLiveTask(null);
    await renderSheet();

    expect(screen.queryByTestId('task-artifacts-row-0')).toBeNull();
  });
});
