import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { SessionSummaryWire } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { CompletedTaskScreen } from '@/screens/CompletedTaskScreen';
import { useBoardStore, type ArchivedTasks } from '@/state/boardStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { boardTaskFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

let mockParams: { taskId?: string; projectId?: string } = { taskId: 'task-1', projectId: 'project-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn() }),
}));

const mockLoadTranscriptTail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/actions', () => ({
  loadTranscriptTail: (sessionId: string) => mockLoadTranscriptTail(sessionId),
}));

// The conversation feed is heavy (FlashList, transcript store subscriptions,
// live-tail buffering) and its own behavior is covered by
// tests/components/ConversationTab.test.tsx. This test is about SESSION
// BINDING (which sessionId this screen hands it), so it becomes a light
// marker recording the prop it was given - the same pattern
// SessionScreen.session-swap.test.tsx uses for its panes.
jest.mock('@/screens/task/ConversationTab', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    ConversationTab: (props: { sessionId: string | null; taskId: string; projectId: string | null }) =>
      ReactModule.createElement(View, { testID: 'stub-conversation-tab', accessibilityLabel: props.sessionId ?? 'none' }),
  };
});

function summaryFixture(overrides: Partial<SessionSummaryWire> = {}): SessionSummaryWire {
  return {
    sessionId: 'sess-summary-1',
    totalCostUsd: 2.5,
    totalInputTokens: 12000,
    totalOutputTokens: 3400,
    modelDisplayName: 'Opus 4.8',
    durationMs: 754000,
    toolCallCount: 12,
    compactionCount: 0,
    linesAdded: 40,
    linesRemoved: 12,
    filesChanged: 3,
    taskCreatedAt: '2026-07-01T00:00:00.000Z',
    startedAt: '2026-07-01T00:05:00.000Z',
    exitedAt: '2026-07-01T00:20:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

/** Seeds `archivedByProjectId` the way findArchivedTaskById reads it: task plus a sparse summary map. */
function seedArchived(projectId: string, task: ReturnType<typeof boardTaskFixture>, summary: SessionSummaryWire | null): void {
  const archived: ArchivedTasks = {
    tasks: [task],
    totalCount: 1,
    summariesByTaskId: summary ? { [task.id]: summary } : {},
    nextOffset: 1,
    loading: false,
  };
  useBoardStore.setState((state) => ({
    archivedByProjectId: { ...state.archivedByProjectId, [projectId]: archived },
  }));
}

function renderCompletedTask(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <CompletedTaskScreen />
    </ThemeProvider>,
  );
}

describe('CompletedTaskScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadTranscriptTail.mockReset().mockResolvedValue(undefined);
    mockParams = { taskId: 'task-1', projectId: 'project-1' };
    useBoardStore.getState().reset();
    useTranscriptStore.getState().reset();
  });

  /**
   * The move to Done nulls the task's session_id while the summary keeps the
   * session RECORDS the transcript is stitched from. A screen anchored on
   * task.session_id instead of summary.sessionId hands the conversation pane
   * a null id and it renders empty forever.
   */
  it('anchors the conversation on the summary sessionId, not the (nulled) task session_id', () => {
    const task = boardTaskFixture({ id: 'task-1', session_id: null, archived_at: '2026-07-01T00:20:00.000Z' });
    const summary = summaryFixture({ sessionId: 'sess-summary-1' });
    seedArchived('project-1', task, summary);

    renderCompletedTask();

    expect(screen.getByTestId('stub-conversation-tab').props.accessibilityLabel).toBe('sess-summary-1');
  });

  /**
   * applyWindow drops any window for a session that is not retained - a
   * memory guard so background sessions cannot pile up transcripts - and
   * retention is normally declared by openSessionScreen, which this screen
   * must never call. Fetching before retaining means the desktop's window
   * lands and is immediately discarded, which looks exactly like a desktop
   * that returned nothing.
   */
  it('retains the session before fetching its transcript tail', async () => {
    const task = boardTaskFixture({ id: 'task-1', session_id: null, archived_at: '2026-07-01T00:20:00.000Z' });
    const summary = summaryFixture({ sessionId: 'sess-summary-1' });
    seedArchived('project-1', task, summary);
    const retainSessionSpy = jest.spyOn(useTranscriptStore.getState(), 'retainSession');

    renderCompletedTask();
    await act(async () => {});

    expect(retainSessionSpy).toHaveBeenCalledWith('sess-summary-1');
    expect(mockLoadTranscriptTail).toHaveBeenCalledWith('sess-summary-1');
    const retainCallOrder = retainSessionSpy.mock.invocationCallOrder[0];
    const fetchCallOrder = mockLoadTranscriptTail.mock.invocationCallOrder[0];
    expect(retainCallOrder).toBeLessThan(fetchCallOrder);
  });

  it('shows the not-found empty state when the task id has no archived match', () => {
    mockParams = { taskId: 'ghost-task', projectId: 'project-1' };
    renderCompletedTask();

    expect(screen.getByTestId('completed-task-missing')).toBeTruthy();
    expect(screen.getByText('Task unavailable')).toBeTruthy();
  });

  it('shows the no-conversation empty state for a task archived without ever running an agent', () => {
    const task = boardTaskFixture({ id: 'task-1', session_id: null, archived_at: '2026-07-02T00:00:00.000Z' });
    seedArchived('project-1', task, null);

    renderCompletedTask();

    expect(screen.getByTestId('completed-task-no-conversation')).toBeTruthy();
    expect(screen.queryByTestId('stub-conversation-tab')).toBeNull();
    expect(mockLoadTranscriptTail).not.toHaveBeenCalled();
  });

  describe('summary formatters', () => {
    function seedAndOpenSummary(summaryOverrides: Partial<SessionSummaryWire>): void {
      const task = boardTaskFixture({ id: 'task-1', session_id: null, archived_at: '2026-07-02T00:00:00.000Z' });
      seedArchived('project-1', task, summaryFixture(summaryOverrides));
      renderCompletedTask();
      fireEvent.press(screen.getByTestId('completed-mode-summary'));
    }

    it('shows a sub-cent cost as <$0.01 rather than rounding down to free', () => {
      seedAndOpenSummary({ totalCostUsd: 0.004 });
      expect(screen.getByText('<$0.01')).toBeTruthy();
    });

    it('shows a zero cost as $0.00', () => {
      seedAndOpenSummary({ totalCostUsd: 0 });
      expect(screen.getByText('$0.00')).toBeTruthy();
    });

    it('renders a zero-duration session as 0m rather than blank or negative', () => {
      seedAndOpenSummary({ durationMs: 0 });
      expect(screen.getByText('0m')).toBeTruthy();
    });

    it('rounds a positive sub-30s duration down to 0m rather than skipping the minutes label', () => {
      seedAndOpenSummary({ durationMs: 20_000 });
      expect(screen.getByText('0m')).toBeTruthy();
    });

    it('drops the minutes when a duration lands on an exact hour', () => {
      seedAndOpenSummary({ durationMs: 7_200_000 });
      expect(screen.getByText('2h')).toBeTruthy();
    });

    it('shows both hours and minutes for a duration that is neither', () => {
      seedAndOpenSummary({ durationMs: 5_400_000 });
      expect(screen.getByText('1h 30m')).toBeTruthy();
    });

    it('formats large token counts compactly', () => {
      seedAndOpenSummary({ totalInputTokens: 1_500_000, totalOutputTokens: 2_500 });
      expect(screen.getByText('1.5M in / 2.5k out')).toBeTruthy();
    });

    it('leaves a small token count as a plain number', () => {
      seedAndOpenSummary({ totalInputTokens: 42, totalOutputTokens: 7 });
      expect(screen.getByText('42 in / 7 out')).toBeTruthy();
    });

    /**
     * Exactly ONE row on this screen reads a completed timestamp
     * (Completed - Started is the session's own startedAt, always parsable
     * here). Asserting "Unknown appears somewhere" would also pass a
     * formatter that always returns Unknown, so this counts the exact number
     * of matches rather than just checking presence.
     */
    it('shows Unknown for a completed timestamp that cannot be parsed, and nowhere else', () => {
      const task = boardTaskFixture({ id: 'task-1', session_id: null, archived_at: 'not-a-real-date' });
      seedArchived('project-1', task, summaryFixture());
      renderCompletedTask();
      fireEvent.press(screen.getByTestId('completed-mode-summary'));

      expect(screen.getAllByText('Unknown')).toHaveLength(1);
    });
  });
});
