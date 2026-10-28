import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import type { SessionSummaryWire, TaskReportWire, TranscriptEntryWire } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import type { CompletedTaskReportOutcome } from '@/connection/taskReportActions';
import { CompletedTaskScreen } from '@/screens/CompletedTaskScreen';
import { useBoardStore, type ArchivedTasks } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { boardTaskFixture } from '@/devsupport/desktopFixtures';
import type { RetentionProbeVariant } from '@/devsupport/retentionProbe';
import { reportFromTaskKnowledge, reportFromTaskReportWire } from '@/taskReport/completedTaskReport';

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

const mockFetchCompletedTaskReport = jest.fn<Promise<CompletedTaskReportOutcome>, [string, string]>();
jest.mock('@/connection/taskReportActions', () => ({
  fetchCompletedTaskReport: (projectId: string, taskId: string) => mockFetchCompletedTaskReport(projectId, taskId),
}));

const mockReportHandledError = jest.fn();
jest.mock('@/observability/crashReporting', () => ({
  reportHandledError: (site: string, error: unknown) => mockReportHandledError(site, error),
}));

const mockOpenURL = jest.fn().mockResolvedValue(true);
jest.mock('expo-linking', () => ({
  openURL: (url: string) => mockOpenURL(url),
}));

// Only the variant reader is replaced, so the Description's GitHub-flavor arm
// can be switched to its CommonMark control; the rest of the real module stays
// for the other components in this tree that import it. Typed from the real
// export so a renamed variant breaks this mock instead of drifting.
const mockGetRetentionProbeVariant = jest.fn<RetentionProbeVariant, []>().mockReturnValue('off');
jest.mock('@/devsupport/retentionProbe', () => ({
  ...jest.requireActual<typeof import('@/devsupport/retentionProbe')>('@/devsupport/retentionProbe'),
  getRetentionProbeVariant: () => mockGetRetentionProbeVariant(),
}));

// The markdown renderer is a native Fabric view; a View passthrough keeps the
// props this screen hands it (the markdown and its flavor) assertable.
jest.mock('react-native-enriched-markdown', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    EnrichedMarkdownText: (props: object) => ReactModule.createElement(View, props),
  };
});

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
    totalCostUsd: 43.42,
    totalInputTokens: 104_900_000,
    totalOutputTokens: 336_300,
    modelDisplayName: 'Sonnet 5.5',
    durationMs: 11_150_924,
    toolCallCount: 528,
    compactionCount: 0,
    linesAdded: 1000,
    linesRemoved: 114,
    filesChanged: 20,
    taskCreatedAt: '2026-10-26T10:00:00.000Z',
    startedAt: '2026-10-26T11:30:00.000Z',
    exitedAt: '2026-10-26T14:30:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

function reportWireFixture(overrides: Partial<TaskReportWire> = {}): TaskReportWire {
  return {
    taskId: 'task-1',
    startedAt: '2026-10-26T11:27:10.030Z',
    endedAt: '2026-10-26T14:33:15.358Z',
    route: [
      {
        swimlaneId: 'lane-executing',
        name: 'Executing',
        color: '#3b82f6',
        icon: 'square-terminal',
        role: null,
        totalMs: 4_245_951,
        visits: [{ startedAt: '2026-10-26T11:49:37.997Z', durationMs: 4_245_951 }],
        visitCount: 1,
      },
    ],
    commits: [{ sha: '1002e46f7e60ac84c19dff73b561faa35a21c4a7', subject: "test(review): pin navigateToVite's retry", committedAt: '2026-10-26T14:32:46.000Z' }],
    commitCount: 3,
    changes: {
      files: Array.from({ length: 10 }, (_, index) => ({
        path: `tests/unit/file${index}.test.ts`,
        status: 'M' as const,
        insertions: 10 + index,
        deletions: index,
        binary: false,
      })),
      fileCount: 20,
      totals: { insertions: 1047, deletions: 120, filesChanged: 20 },
      emptyReason: null,
    },
    changesError: null,
    summaryState: { kind: 'written', text: 'Fixed CI failures from the v0.50.0 release.' },
    ...overrides,
  };
}

function ready(wire: TaskReportWire = reportWireFixture()): CompletedTaskReportOutcome {
  return { kind: 'ready', report: reportFromTaskReportWire(wire) };
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

function seedTranscript(sessionId: string, entries: TranscriptEntryWire[]): void {
  useTranscriptStore.setState((state) => ({
    bySessionId: {
      ...state.bySessionId,
      [sessionId]: { hasWindow: true, entries, startIndex: 0, totalEntries: entries.length, revision: 1, tailRevision: 1, needsTailFetch: false },
    },
  }));
}

function taskFixture(overrides: Partial<ReturnType<typeof boardTaskFixture>> = {}): ReturnType<typeof boardTaskFixture> {
  return boardTaskFixture({
    id: 'task-1',
    session_id: null,
    archived_at: '2026-10-26T14:40:00.000Z',
    description: 'Three CI failures came up.\n\n### Done when\n- [ ] Main is green.',
    pr_number: 656,
    pr_url: 'https://github.com/Kangentic/kangentic/pull/656',
    pr_state: 'merged',
    ...overrides,
  });
}

async function renderCompletedTask(): Promise<void> {
  await render(
    <ThemeProvider>
      <CompletedTaskScreen />
    </ThemeProvider>,
  );
}

async function openSegment(mode: 'summary' | 'description'): Promise<void> {
  await renderCompletedTask();
  await fireEvent.press(screen.getByTestId(`completed-mode-${mode}`));
  // Let the report read settle.
  await act(async () => {});
}

describe('CompletedTaskScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadTranscriptTail.mockReset().mockResolvedValue(undefined);
    mockFetchCompletedTaskReport.mockReset().mockResolvedValue(ready());
    mockOpenURL.mockReset().mockResolvedValue(true);
    mockGetRetentionProbeVariant.mockReset().mockReturnValue('off');
    mockParams = { taskId: 'task-1', projectId: 'project-1' };
    useBoardStore.getState().reset();
    useTranscriptStore.getState().reset();
    useChannelStore.setState({ established: true });
  });

  /**
   * The move to Done nulls the task's session_id while the summary keeps the
   * session RECORDS the transcript is stitched from. A screen anchored on
   * task.session_id instead of summary.sessionId hands the conversation pane
   * a null id and it renders empty forever.
   */
  it('anchors the conversation on the summary sessionId, not the (nulled) task session_id', async () => {
    seedArchived('project-1', taskFixture(), summaryFixture({ sessionId: 'sess-summary-1' }));

    await renderCompletedTask();

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
    seedArchived('project-1', taskFixture(), summaryFixture({ sessionId: 'sess-summary-1' }));
    const retainSessionSpy = jest.spyOn(useTranscriptStore.getState(), 'retainSession');

    await renderCompletedTask();
    await act(async () => {});

    expect(retainSessionSpy).toHaveBeenCalledWith('sess-summary-1');
    expect(mockLoadTranscriptTail).toHaveBeenCalledWith('sess-summary-1');
    const retainCallOrder = retainSessionSpy.mock.invocationCallOrder[0];
    const fetchCallOrder = mockLoadTranscriptTail.mock.invocationCallOrder[0];
    expect(retainCallOrder).toBeLessThan(fetchCallOrder);
  });

  it('shows the not-found empty state when the task id has no archived match', async () => {
    mockParams = { taskId: 'ghost-task', projectId: 'project-1' };
    await renderCompletedTask();

    expect(screen.getByTestId('completed-task-missing')).toBeTruthy();
    expect(screen.getByText('Task unavailable')).toBeTruthy();
    expect(mockFetchCompletedTaskReport).not.toHaveBeenCalled();
  });

  it('shows the no-conversation empty state for a task archived without ever running an agent', async () => {
    seedArchived('project-1', taskFixture(), null);

    await renderCompletedTask();

    expect(screen.getByTestId('completed-task-no-conversation')).toBeTruthy();
    expect(screen.queryByTestId('stub-conversation-tab')).toBeNull();
    expect(mockLoadTranscriptTail).not.toHaveBeenCalled();
  });

  it('offers three segments: Conversation, Summary and Description', async () => {
    seedArchived('project-1', taskFixture(), summaryFixture());
    await renderCompletedTask();
    for (const mode of ['conversation', 'summary', 'description']) {
      expect(screen.getByTestId(`completed-mode-${mode}`)).toBeTruthy();
    }
  });

  describe('Summary', () => {
    it('reads the report for the archived row by its project id and task id', async () => {
      seedArchived('project-1', taskFixture(), summaryFixture());
      await openSegment('summary');
      expect(mockFetchCompletedTaskReport).toHaveBeenCalledWith('project-1', 'task-1');
    });

    it('waits for the channel before reading, and reads once it is up', async () => {
      useChannelStore.setState({ established: false });
      seedArchived('project-1', taskFixture(), summaryFixture());
      await openSegment('summary');
      expect(mockFetchCompletedTaskReport).not.toHaveBeenCalled();
      expect(screen.getByTestId('completed-summary-loading')).toBeTruthy();

      await act(async () => {
        useChannelStore.setState({ established: true });
      });
      expect(mockFetchCompletedTaskReport).toHaveBeenCalledTimes(1);
    });

    it('shows placeholders and no figure while the report is read, as the desktop waits for its report', async () => {
      mockFetchCompletedTaskReport.mockReturnValue(new Promise<CompletedTaskReportOutcome>(() => undefined));
      seedArchived('project-1', taskFixture(), summaryFixture());
      await openSegment('summary');
      expect(screen.getByTestId('completed-summary-loading')).toBeTruthy();
      expect(screen.queryByTestId('completed-strip')).toBeNull();
    });

    it("draws the strip from the report: span, runtime, git's changes, cost, PR and status", async () => {
      seedArchived('project-1', taskFixture(), summaryFixture());
      await openSegment('summary');

      expect(screen.getByTestId('completed-strip-span-started')).toBeTruthy();
      expect(screen.getByTestId('completed-strip-span-ended')).toBeTruthy();
      expect(screen.getByText('3h 6m')).toBeTruthy();
      expect(screen.getByText('3h 5m')).toBeTruthy();
      expect(screen.getByText('+1k')).toBeTruthy();
      expect(screen.getByText('-120')).toBeTruthy();
      expect(screen.getByText('$43.42')).toBeTruthy();
      expect(screen.getByText('#656')).toBeTruthy();
      expect(screen.getByText('Merged')).toBeTruthy();
      expect(screen.getByTestId('completed-strip-status')).toHaveTextContent('Completed');
    });

    it('reads "Exited (n)" after a non-zero exit', async () => {
      seedArchived('project-1', taskFixture(), summaryFixture({ exitCode: 2 }));
      await openSegment('summary');
      expect(screen.getByTestId('completed-strip-status')).toHaveTextContent('Exited (2)');
    });

    it('opens the PR in the OS handler', async () => {
      seedArchived('project-1', taskFixture(), summaryFixture());
      await openSegment('summary');
      await fireEvent.press(screen.getByTestId('completed-strip-pr'));
      expect(mockOpenURL).toHaveBeenCalledWith('https://github.com/Kangentic/kangentic/pull/656');
    });

    it('shows a PR it cannot open safely without making it pressable', async () => {
      seedArchived('project-1', taskFixture({ pr_url: 'kangentic://pull/656' }), summaryFixture());
      await openSegment('summary');
      await fireEvent.press(screen.getByTestId('completed-strip-pr'));
      expect(mockOpenURL).not.toHaveBeenCalled();
    });

    /**
     * "Not pressable" is a structural claim, not a handler that happens to
     * refuse: a chip that is a pressable with a guarded handler would still
     * pass an openURL-not-called check, and a screen reader would still
     * announce it as a link that does nothing. So the chip's role is asserted.
     */
    it('draws an https PR as a link and opens exactly that URL', async () => {
      seedArchived('project-1', taskFixture(), summaryFixture());
      await openSegment('summary');

      const chip = screen.getByTestId('completed-strip-pr');
      expect(chip.props.accessibilityRole).toBe('link');
      expect(chip.props.accessibilityLabel).toBe('Open pull request #656 (merged)');

      await fireEvent.press(chip);
      expect(mockOpenURL).toHaveBeenCalledTimes(1);
      expect(mockOpenURL).toHaveBeenCalledWith('https://github.com/Kangentic/kangentic/pull/656');
    });

    it.each([
      ['a custom scheme', 'kangentic://pull/656'],
      ['plain http', 'http://github.com/Kangentic/kangentic/pull/656'],
      ['no URL at all', null],
    ] as const)('draws a PR with %s as plain content, not a link', async (_kind, prUrl) => {
      seedArchived('project-1', taskFixture({ pr_url: prUrl }), summaryFixture());
      await openSegment('summary');

      const chip = screen.getByTestId('completed-strip-pr');
      expect(screen.getByText('#656')).toBeTruthy();
      expect(chip.props.accessibilityRole).toBeUndefined();
      expect(chip.props.accessibilityLabel).toBe('Pull request #656 (merged)');

      await fireEvent.press(chip);
      expect(mockOpenURL).not.toHaveBeenCalled();
    });

    it('survives the OS refusing to open the PR, handing the refusal to the dev log rather than leaving it unhandled', async () => {
      const refusal = new Error('no app can open this URL');
      mockOpenURL.mockRejectedValueOnce(refusal);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        seedArchived('project-1', taskFixture(), summaryFixture());
        await openSegment('summary');

        await fireEvent.press(screen.getByTestId('completed-strip-pr'));
        await act(async () => {});

        expect(mockOpenURL).toHaveBeenCalledTimes(1);
        // The only observable trace of the catch: the chip has no error surface of its own.
        expect(warnSpy).toHaveBeenCalledWith('[completed-task] could not open the pull request:', refusal);
        expect(screen.getByTestId('completed-strip-pr')).toBeTruthy();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('shows the cards in the desktop order, then Usage', async () => {
      seedArchived('project-1', taskFixture(), summaryFixture());
      await openSegment('summary');
      for (const testID of ['completed-summary-task', 'completed-summary-route', 'completed-summary-commits', 'completed-summary-files', 'completed-summary-usage']) {
        expect(screen.getByTestId(testID)).toBeTruthy();
      }
      expect(screen.getByTestId('completed-summary-task-text')).toHaveTextContent('Fixed CI failures from the v0.50.0 release.');
      expect(screen.getByTestId('completed-summary-commits-aside')).toHaveTextContent('1 of 3');
      expect(screen.getByTestId('completed-summary-files-aside')).toHaveTextContent('20');
    });

    /** "n of m" says the desktop sent fewer commits than it found; when it sent them all there is nothing to say. */
    it('shows no count beside Commits when every commit is listed', async () => {
      seedArchived('project-1', taskFixture(), summaryFixture());
      mockFetchCompletedTaskReport.mockResolvedValue(ready(reportWireFixture({ commitCount: 1 })));
      await openSegment('summary');

      // The card and its one commit are drawn, so the absence below is the aside's alone.
      expect(screen.getByTestId('completed-summary-commit-1002e46')).toBeTruthy();
      expect(screen.getByTestId('completed-summary-commits-title')).toHaveTextContent(/^Commits$/);
      expect(screen.queryByTestId('completed-summary-commits-aside')).toBeNull();
    });

    /**
     * On the Android emulator a lone card title in a flex row was measured
     * narrower than its text inside the FlashList, so "Task summary" lost its
     * second word. The fix is structural: the title is one Text and the count
     * a span nested in it, never a sibling in a row. Jest cannot reproduce the
     * native measurement, so this pins the structure.
     */
    it('draws each card title as one text with its count nested inside it', async () => {
      seedArchived('project-1', taskFixture(), summaryFixture());
      await openSegment('summary');
      const commitsTitle = screen.getByTestId('completed-summary-commits-title');
      // A Text host, not a row View holding two Texts.
      expect(commitsTitle.type).toBe('Text');
      expect(within(commitsTitle).getByTestId('completed-summary-commits-aside')).toBeTruthy();
      // The default matcher collapses the spacing before the count.
      expect(commitsTitle).toHaveTextContent('Commits 1 of 3');
      expect(screen.getByTestId('completed-summary-task-title')).toHaveTextContent('Task summary');
    });

    it('holds Files changed to eight rows until Show all', async () => {
      seedArchived('project-1', taskFixture(), summaryFixture());
      await openSegment('summary');
      expect(screen.getByTestId('completed-summary-file-7')).toBeTruthy();
      expect(screen.queryByTestId('completed-summary-file-8')).toBeNull();

      await fireEvent.press(screen.getByTestId('completed-summary-files-show-all'));
      expect(screen.getByTestId('completed-summary-file-9')).toBeTruthy();
      expect(screen.queryByTestId('completed-summary-files-show-all')).toBeNull();
    });

    it("shows the desktop's reason and the agent's last message when no summary is written", async () => {
      seedArchived('project-1', taskFixture(), summaryFixture());
      seedTranscript('sess-summary-1', [
        { kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'text', text: 'Looking first.' }] },
        { kind: 'assistant', uuid: 'a2', ts: 1, blocks: [{ type: 'text', text: 'One retry, then the per-item path.' }] },
      ]);
      mockFetchCompletedTaskReport.mockResolvedValue(ready(reportWireFixture({ summaryState: { kind: 'off' } })));
      await openSegment('summary');

      expect(screen.getByTestId('completed-summary-task-state')).toHaveTextContent('Task summaries are off');
      expect(screen.getByTestId('completed-summary-last-message').props.markdown).toBe('One retry, then the per-item path.');
    });

    it('clamps a long last message and toggles Show all and Show less', async () => {
      seedArchived('project-1', taskFixture(), summaryFixture());
      seedTranscript('sess-summary-1', [{ kind: 'assistant', uuid: 'a1', ts: 0, blocks: [{ type: 'text', text: 'A long answer.' }] }]);
      mockFetchCompletedTaskReport.mockResolvedValue(ready(reportWireFixture({ summaryState: { kind: 'pending' } })));
      await openSegment('summary');
      expect(screen.queryByTestId('completed-summary-last-message-toggle')).toBeNull();

      await fireEvent(screen.getByTestId('completed-summary-last-message-content'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 400 } },
      });
      expect(screen.getByTestId('completed-summary-last-message-toggle')).toHaveTextContent('Show all');
      expect(screen.getByTestId('completed-summary-last-message-fade')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('completed-summary-last-message-toggle'));
      expect(screen.getByTestId('completed-summary-last-message-toggle')).toHaveTextContent('Show less');
      expect(screen.queryByTestId('completed-summary-last-message-fade')).toBeNull();
    });

    it('draws a task that ran no agent: its span and route, and no runtime, changes, cost or usage', async () => {
      seedArchived('project-1', taskFixture({ pr_number: null, pr_url: null, pr_state: null }), null);
      mockFetchCompletedTaskReport.mockResolvedValue(
        ready(
          reportWireFixture({
            startedAt: '2026-07-19T08:58:00.000Z',
            endedAt: '2026-07-19T09:15:00.000Z',
            commits: [],
            commitCount: 0,
            changes: { files: [], fileCount: 0, totals: null, emptyReason: 'no-commits' },
            summaryState: { kind: 'pending' },
          }),
        ),
      );
      await openSegment('summary');

      expect(screen.getByText('17m')).toBeTruthy();
      expect(screen.queryByTestId('completed-strip-figures-agentRuntime')).toBeNull();
      expect(screen.queryByTestId('completed-strip-figures-changes')).toBeNull();
      expect(screen.queryByTestId('completed-strip-pr')).toBeNull();
      expect(screen.getByTestId('completed-summary-route')).toBeTruthy();
      expect(screen.queryByTestId('completed-summary-commits')).toBeNull();
      expect(screen.queryByTestId('completed-summary-files')).toBeNull();
      expect(screen.queryByTestId('completed-summary-usage')).toBeNull();
    });

    it("draws an older desktop's find_task answer: paths only, no route", async () => {
      seedArchived('project-1', taskFixture(), summaryFixture());
      mockFetchCompletedTaskReport.mockResolvedValue({
        kind: 'ready',
        report: reportFromTaskKnowledge({ summaryText: null, commits: [], commitCount: 0, changedFiles: ['src/a.ts'], changedFileCount: 1 }),
      });
      await openSegment('summary');
      expect(screen.getByTestId('completed-summary-task-state')).toHaveTextContent('Summary pending');
      expect(screen.queryByTestId('completed-summary-route')).toBeNull();
      expect(screen.getByTestId('completed-summary-file-0')).toBeTruthy();
      // The session's own lines, without git's totals.
      expect(screen.getByText('-114')).toBeTruthy();
    });

    it("says the record could not be read, reports it through the handled-error door, and keeps the phone's own figures", async () => {
      const refusal = new Error('both refused');
      seedArchived('project-1', taskFixture(), summaryFixture());
      mockFetchCompletedTaskReport.mockResolvedValue({ kind: 'unavailable', error: refusal });
      await openSegment('summary');

      expect(screen.getByTestId('completed-summary-unavailable')).toBeTruthy();
      expect(mockReportHandledError).toHaveBeenCalledWith('completed-task-report', refusal);
      expect(screen.getByText('$43.42')).toBeTruthy();
      expect(screen.queryByTestId('completed-summary-route')).toBeNull();
    });

    it('reports nothing when the report, or its fallback, answers', async () => {
      seedArchived('project-1', taskFixture(), summaryFixture());
      await openSegment('summary');
      expect(mockReportHandledError).not.toHaveBeenCalled();
    });
  });

  describe('Description', () => {
    it('shows the description in full, with the GitHub flavor so its checklist draws boxes', async () => {
      seedArchived('project-1', taskFixture(), summaryFixture());
      await openSegment('description');
      const markdown = screen.getByTestId('completed-description-markdown');
      expect(markdown.props.markdown).toBe('Three CI failures came up.\n\n### Done when\n- [ ] Main is green.');
      expect(markdown.props.flavor).toBe('github');
      expect(markdown.props.enableTaskListItemToggle).toBe(false);
    });

    /**
     * The retention probe's control arm (task #130): the same description on
     * the single-TextView CommonMark renderer every other surface uses. The
     * 'off' arm, the shipped one, is the GitHub flavor asserted above.
     */
    it('draws the description as CommonMark under the retention probe\'s description-commonmark arm', async () => {
      mockGetRetentionProbeVariant.mockReturnValue('description-commonmark');
      seedArchived('project-1', taskFixture(), summaryFixture());
      await openSegment('description');
      const markdown = screen.getByTestId('completed-description-markdown');
      expect(markdown.props.markdown).toBe('Three CI failures came up.\n\n### Done when\n- [ ] Main is green.');
      expect(markdown.props.flavor).toBe('commonmark');
    });

    it('says there is no description rather than showing a blank segment', async () => {
      seedArchived('project-1', taskFixture({ description: '  ' }), summaryFixture());
      await openSegment('description');
      expect(screen.getByTestId('completed-description-empty')).toBeTruthy();
    });
  });
});
