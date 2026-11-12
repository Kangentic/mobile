import React from 'react';
import { View } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { TranscriptEntryWire } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { AppErrorBoundaryScreen } from '@/screens/AppErrorBoundaryScreen';
import { ConversationTab } from '@/screens/task/ConversationTab';
import { useActivityStore } from '@/state/activityStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { appendChunk, resetTerminalFeed, retainTerminal } from '@/state/terminalFeed';
import { loadOlderTranscript, loadTranscriptTail } from '@/connection/actions';
import { useChannelStore } from '@/state/channelStore';

jest.mock('@/connection/actions', () => ({
  sendUserMessage: jest.fn().mockResolvedValue(undefined),
  answerPermissionPrompt: jest.fn().mockResolvedValue(undefined),
  loadTranscriptTail: jest.fn().mockResolvedValue(undefined),
  loadOlderTranscript: jest.fn().mockResolvedValue(undefined),
}));

// EnrichedMarkdownText is a native Fabric component; pass props through a View.
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

// ComposerBar (imported by the tab module) pulls in the dictation engine.
jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: jest.fn().mockReturnValue(true),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    start: jest.fn(),
    stop: jest.fn(),
  },
  useSpeechRecognitionEvent: jest.fn(),
}));

// AppErrorBoundaryScreen renders a Screen, which reads the safe area.
jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockReportCaughtError = jest.fn();
jest.mock('@/observability/crashReporting', () => ({
  ...jest.requireActual('@/observability/crashReporting'),
  reportCaughtError: (error: Error, boundary: string) => mockReportCaughtError(error, boundary),
}));

const mockNativeScrollToEnd = jest.fn();
/** When set, the list throws from a layout effect: MOBILE-F's real phase. */
const mockFlashListFailure: { error: Error | null } = { error: null };
// Wraps the REAL FlashList (every other test in this file keeps exercising
// its actual virtualization and layout behavior) and only hands back a native
// scroll ref with a spy on it, so the re-anchor test below can assert on the
// scroll without reaching into native scroll-command dispatch.
jest.mock('@shopify/flash-list', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  const ActualFlashListModule = jest.requireActual('@shopify/flash-list');
  const RealFlashList = ActualFlashListModule.FlashList;
  const SpyingFlashList = ReactModule.forwardRef(function SpyingFlashList(
    props: object,
    forwardedRef: React.Ref<{ getNativeScrollRef: () => { scrollToEnd: (params?: { animated?: boolean }) => void } }>,
  ) {
    ReactModule.useLayoutEffect(() => {
      if (mockFlashListFailure.error !== null) throw mockFlashListFailure.error;
    });
    ReactModule.useImperativeHandle(forwardedRef, () => ({
      getNativeScrollRef: () => ({ scrollToEnd: mockNativeScrollToEnd }),
    }));
    return ReactModule.createElement(RealFlashList, props);
  });
  return { ...ActualFlashListModule, FlashList: SpyingFlashList };
});

const fixtureEntries: TranscriptEntryWire[] = [
  { kind: 'user', uuid: 'user-1', ts: 1, text: 'Fix the login bug' },
  {
    kind: 'assistant',
    uuid: 'assist-1',
    ts: 2,
    blocks: [
      { type: 'text', text: 'Looking at the auth flow now.' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm run lint' } },
    ],
  },
  { kind: 'tool_result', uuid: 'result-1', ts: 3, toolUseId: 'tool-1', content: 'lint passed', isError: false },
  { kind: 'system', uuid: 'system-1', ts: 4, subtype: 'compaction', text: 'compacted' },
];

function seedStores(): void {
  useTranscriptStore.getState().reset();
  useActivityStore.getState().reset();
  resetTerminalFeed();
  useTranscriptStore.setState({
    bySessionId: {
      'sess-1': {
        hasWindow: true,
        entries: fixtureEntries,
        startIndex: 0,
        totalEntries: fixtureEntries.length,
        revision: 1,
        tailRevision: 1,
        needsTailFetch: false,
      },
    },
    retainedSessionIds: ['sess-1'],
  });
  useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
}

async function renderTab(sessionId: string | null = 'sess-1'): Promise<void> {
  await render(
    <ThemeProvider>
      <ConversationTab taskId="task-1" sessionId={sessionId} projectId="project-1" />
    </ThemeProvider>,
  );
  if (sessionId !== null) {
    // FlashList renders nothing (or, with startRenderingFromBottom, only the
    // bottom item) until it has a measured viewport; jest never lays out, so
    // hand it one.
    await fireEvent(screen.getByTestId('conversation-list'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } },
    });
  }
}

/** Puts the session's window mid-transcript so older history exists above it. */
function seedWindowWithOlderHistory(): void {
  useTranscriptStore.setState((state) => ({
    bySessionId: {
      ...state.bySessionId,
      'sess-1': { ...state.bySessionId['sess-1'], startIndex: 405, totalEntries: 476 },
    },
  }));
}

describe('ConversationTab', () => {
  beforeEach(() => {
    seedStores();
    jest.mocked(loadOlderTranscript).mockClear();
    mockNativeScrollToEnd.mockClear();
  });

  async function scrollTo(offsetFromTop: number): Promise<void> {
    await fireEvent.scroll(screen.getByTestId('conversation-list'), {
      nativeEvent: {
        contentOffset: { x: 0, y: offsetFromTop },
        contentSize: { width: 400, height: 12_000 },
        layoutMeasurement: { width: 400, height: 800 },
      },
    });
  }

  /**
   * The feed opens anchored at the newest message, so it begins life near the
   * top of its own window. Live on a Pixel that paged in 60 older entries
   * AFTER the initial bottom anchor had run, prepending a screenful above the
   * scroll offset: the chat opened blank and only filled in once the user
   * scrolled. History paging is a scroll-up affordance and waits for a drag.
   */
  it('does not page older history before the user has scrolled', async () => {
    seedWindowWithOlderHistory();
    await renderTab();

    await scrollTo(0);
    expect(loadOlderTranscript).not.toHaveBeenCalled();
  });

  it('pages older history once the user drags the feed near the top', async () => {
    seedWindowWithOlderHistory();
    await renderTab();

    await fireEvent(screen.getByTestId('conversation-list'), 'scrollBeginDrag');
    await scrollTo(0);
    expect(loadOlderTranscript).toHaveBeenCalledWith('sess-1');
  });

  /**
   * The reason paging is driven by scroll offset and not FlashList's
   * onStartReached: that callback is edge-triggered, so declining it once
   * (which the pre-scroll gate above does by design) consumed the only event
   * and left the list pinned at the top of its window, loading nothing. A
   * level-triggered offset check still pages on the next scroll event.
   */
  it('still pages after an earlier near-top scroll was declined', async () => {
    seedWindowWithOlderHistory();
    await renderTab();

    await scrollTo(0);
    expect(loadOlderTranscript).not.toHaveBeenCalled();

    await fireEvent(screen.getByTestId('conversation-list'), 'scrollBeginDrag');
    await scrollTo(0);
    expect(loadOlderTranscript).toHaveBeenCalledWith('sess-1');
  });

  it('does not page while the user is scrolled far from the top', async () => {
    seedWindowWithOlderHistory();
    await renderTab();

    await fireEvent(screen.getByTestId('conversation-list'), 'scrollBeginDrag');
    await scrollTo(9000);
    expect(loadOlderTranscript).not.toHaveBeenCalled();
  });

  it('shows the empty state without a session', async () => {
    await renderTab(null);
    expect(screen.getByText('No active session for this task')).toBeTruthy();
  });

  it('renders the flattened transcript cells from the store', async () => {
    await renderTab();
    expect(screen.getByText('Fix the login bug')).toBeTruthy();
    expect(screen.getByTestId('markdown-cell-assist-1-0').props.markdown).toBe('Looking at the auth flow now.');
    expect(screen.getByTestId('tool-call-tool-1')).toBeTruthy();
    expect(screen.getByText('context compacted')).toBeTruthy();
  });

  it('shows the live tail only while the session is thinking', async () => {
    retainTerminal('sess-1');
    appendChunk('sess-1', 'npm install\ncompiling module graph\n');
    await renderTab();

    // Idle: buffered bytes exist but the tail stays hidden.
    expect(screen.queryByText('▌ live')).toBeNull();

    await act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } },
      });
    });
    expect(screen.getByText('▌ live')).toBeTruthy();
    expect(screen.getByText('npm install')).toBeTruthy();
    expect(screen.getByText('compiling module graph')).toBeTruthy();

    await act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'activity', state: 'idle', reason: { kind: 'idle' } },
      });
    });
    expect(screen.queryByText('▌ live')).toBeNull();
  });

  it('renders the permission card when a prompt is awaited', async () => {
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'permission', promptId: 'sess-1:tool-1', pending: true },
    });
    await renderTab();

    expect(screen.getByText('Permission requested')).toBeTruthy();
    expect(screen.getByTestId('permission-approve')).toBeTruthy();
    expect(screen.getByTestId('permission-deny')).toBeTruthy();
    // The body shows the located tool_use's full command (the tool-call
    // cell's summary shows the same text, hence getAllByText).
    expect(screen.getAllByText('npm run lint').length).toBeGreaterThan(0);
  });

  it('routes to the terminal, with no blind action, when the awaited tool_use is not in the transcript', async () => {
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'permission', promptId: 'sess-1:tool-unknown', pending: true },
    });
    await renderTab();

    // Without a tool_use the app cannot say what approving would grant, and
    // Approve sends a digit that could answer the wrong question.
    expect(screen.queryByText('Permission requested')).toBeNull();
    expect(screen.queryByTestId('permission-approve')).toBeNull();
    expect(screen.queryByTestId('permission-deny')).toBeNull();
    expect(screen.getByText('The agent needs you')).toBeTruthy();
    expect(screen.getByText('Open in terminal')).toBeTruthy();
  });

  /**
   * A session's window assembles over several frames (the open fetch lands,
   * cells build, the streaming tail appends, cell heights get measured), so
   * anchoring only on the FIRST content-size change lands the chat lens in
   * empty space - it must re-anchor on every growth until the user actually
   * takes over scrolling.
   */
  it('re-anchors to the end on every content-size change, not just the first, until the user drags', async () => {
    await renderTab();
    const list = screen.getByTestId('conversation-list');

    await fireEvent(list, 'contentSizeChange', 400, 2000);
    const callsAfterFirstGrowth = mockNativeScrollToEnd.mock.calls.length;
    expect(callsAfterFirstGrowth).toBeGreaterThan(0);

    // A second, later growth must re-anchor too, not be a no-op because the
    // list already anchored once.
    await fireEvent(list, 'contentSizeChange', 400, 2400);
    expect(mockNativeScrollToEnd.mock.calls.length).toBeGreaterThan(callsAfterFirstGrowth);

    const callsBeforeDrag = mockNativeScrollToEnd.mock.calls.length;
    await fireEvent(list, 'scrollBeginDrag');
    await fireEvent(list, 'contentSizeChange', 400, 2800);
    expect(mockNativeScrollToEnd.mock.calls.length).toBe(callsBeforeDrag);
  });
});

/**
 * The 7-inch store shelf opened a session short of its end, with the permission
 * card's Approve and Deny under the composer (the measurement is in the MOBILE-F
 * section of docs/developer-guide.md). The immediate re-anchor can run before
 * the taller content is mounted, so the anchor scrolls once more on the next
 * frame, after the mount, unless the reader has dragged by then.
 *
 * Mutations that redden these: drop the deferred `scrollFeedToEnd` from
 * `useFeedEndAnchor` (the first), or its `userTookOverScrollRef` check (the
 * second).
 */
describe('ConversationTab - the end anchor lands after the mount', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    seedStores();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function settleRender(): Promise<void> {
    await renderTab();
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
    mockNativeScrollToEnd.mockClear();
  }

  it('scrolls to the end again on the next frame', async () => {
    await settleRender();

    await fireEvent(screen.getByTestId('conversation-list'), 'contentSizeChange', 617, 2254);
    expect(mockNativeScrollToEnd).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(32);
    });
    expect(mockNativeScrollToEnd).toHaveBeenCalledTimes(2);
    expect(mockNativeScrollToEnd).toHaveBeenLastCalledWith({ animated: false });
  });

  it('leaves the feed where a drag in that frame put it', async () => {
    await settleRender();
    const list = screen.getByTestId('conversation-list');

    await fireEvent(list, 'contentSizeChange', 617, 2254);
    await fireEvent(list, 'scrollBeginDrag');
    await act(async () => {
      jest.advanceTimersByTime(32);
    });

    expect(mockNativeScrollToEnd).toHaveBeenCalledTimes(1);
  });

  /**
   * Mutation that reddens this: make `jumpToLatest` in ConversationTab.tsx call
   * `scrollFeedToEnd(listRef.current)` directly (imported from
   * '@/components/conversation/scrollFeedToEnd') instead of `anchorToEnd()`.
   */
  it('scrolls again on the next frame after Jump to latest', async () => {
    await settleRender();

    await fireEvent.scroll(screen.getByTestId('conversation-list'), {
      nativeEvent: {
        contentOffset: { x: 0, y: 0 },
        contentSize: { width: 400, height: 12_000 },
        layoutMeasurement: { width: 400, height: 800 },
      },
    });
    mockNativeScrollToEnd.mockClear();
    await fireEvent.press(screen.getByTestId('jump-to-latest'));
    expect(mockNativeScrollToEnd).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(32);
    });
    expect(mockNativeScrollToEnd).toHaveBeenCalledTimes(2);
    expect(mockNativeScrollToEnd).toHaveBeenLastCalledWith({ animated: false });
  });
});

/**
 * Stands in for expo-router's `<Try catch={ErrorBoundary}>`, which is what
 * app/_layout.tsx's `ErrorBoundary` export installs around the whole route
 * tree. Without a boundary of its own, a feed throw lands here.
 */
class RootBoundaryStandIn extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override render(): React.ReactNode {
    if (this.state.error !== null) {
      return <AppErrorBoundaryScreen error={this.state.error} retry={async () => undefined} />;
    }
    return this.props.children;
  }
}

/**
 * Sentry MOBILE-F: a list loop in the feed threw from FlashList's layout effect
 * and reached the root boundary, so one feed replaced the whole app. The screen
 * around the feed has to survive it, and the crash has to stay reported, because
 * a caught error never reaches the global handler.
 *
 * Mutation that reddens these: render ConversationFeed without its boundary. The
 * root screen comes up in its place.
 */
describe('ConversationTab - feed error boundary', () => {
  const loopError = new Error('Maximum update depth exceeded.');
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    seedStores();
    mockReportCaughtError.mockClear();
    // React logs every caught error; expected here, and noise in the run.
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFlashListFailure.error = loopError;
  });

  afterEach(() => {
    mockFlashListFailure.error = null;
    consoleError.mockRestore();
  });

  function tree(sessionId: string): React.JSX.Element {
    return (
      <ThemeProvider>
        <RootBoundaryStandIn>
          <View testID="session-screen-sibling" />
          <ConversationTab taskId="task-1" sessionId={sessionId} projectId="project-1" />
        </RootBoundaryStandIn>
      </ThemeProvider>
    );
  }

  it('keeps a feed crash inside the pane, so the screen around it survives', async () => {
    await render(tree('sess-1'));

    expect(screen.queryByTestId('app-error-boundary')).toBeNull();
    expect(screen.getByTestId('feed-error')).toBeTruthy();
    expect(screen.getByText('Chat failed to load')).toBeTruthy();
    expect(screen.getByTestId('session-screen-sibling')).toBeTruthy();
  });

  it('reports the crash under its own boundary name, not the root one', async () => {
    await render(tree('sess-1'));

    expect(mockReportCaughtError).toHaveBeenCalledTimes(1);
    expect(mockReportCaughtError).toHaveBeenCalledWith(loopError, 'conversation-feed');
  });

  it('remounts the feed on Try again', async () => {
    await render(tree('sess-1'));

    mockFlashListFailure.error = null;
    await fireEvent.press(screen.getByTestId('feed-error-retry'));

    expect(screen.queryByTestId('feed-error')).toBeNull();
    expect(screen.getByTestId('conversation-list')).toBeTruthy();
  });

  /** The two MOBILE-F events 5 s apart fit Try again throwing straight back. */
  it('stays on the fallback, and reports again, when Try again throws again', async () => {
    await render(tree('sess-1'));

    await fireEvent.press(screen.getByTestId('feed-error-retry'));

    expect(screen.getByTestId('feed-error')).toBeTruthy();
    expect(screen.queryByTestId('app-error-boundary')).toBeNull();
    expect(mockReportCaughtError).toHaveBeenCalledTimes(2);
  });

  /**
   * CompletedTaskScreen renders ConversationTab with no `key`, so the session
   * can change under a live boundary. One session's failure is no verdict on
   * the next.
   *
   * Mutation that reddens this: drop the boundary's `key`.
   */
  it('gives another session a fresh start', async () => {
    const view = await render(tree('sess-1'));
    expect(screen.getByTestId('feed-error')).toBeTruthy();

    mockFlashListFailure.error = null;
    await view.rerender(tree('sess-2'));

    expect(screen.queryByTestId('feed-error')).toBeNull();
    expect(screen.getByTestId('conversation-list')).toBeTruthy();
  });
});

/**
 * The self-heal's RETRY. A newest-window fetch that failed on an established
 * channel used to wait for the next change of the flag, the channel or the
 * session, none of which a failure causes: on a release build a cold-launch
 * notification tap left Chat on "Loading conversation..." for over a minute.
 * It now retries on a bounded budget (2 s, 5 s, 10 s), and stops the moment
 * the window lands.
 *
 * Mutation that reddens these: drop the retry from the effect's catch.
 */
describe('ConversationTab - newest-window fetch retry', () => {
  const tailFetch = loadTranscriptTail as jest.MockedFunction<typeof loadTranscriptTail>;

  async function flushFetches(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function advance(milliseconds: number): Promise<void> {
    await act(async () => {
      jest.advanceTimersByTime(milliseconds);
    });
    await flushFetches();
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    seedStores();
    // A window the store has flagged as unpatchable: the fetch is owed.
    useTranscriptStore.setState((state) => ({
      bySessionId: { 'sess-1': { ...state.bySessionId['sess-1'], needsTailFetch: true } },
    }));
    await act(() => {
      useChannelStore.setState({ established: true });
    });
    tailFetch.mockReset();
  });

  afterEach(async () => {
    await act(() => {
      useChannelStore.getState().reset();
    });
    tailFetch.mockReset();
    tailFetch.mockResolvedValue(undefined);
    jest.useRealTimers();
  });

  it('retries a failed fetch until one lands, then stops', async () => {
    tailFetch.mockRejectedValueOnce(new Error('capability timeout')).mockRejectedValueOnce(new Error('capability timeout'));
    tailFetch.mockResolvedValue(undefined);
    await renderTab();
    await flushFetches();
    expect(tailFetch).toHaveBeenCalledTimes(1);

    await advance(2000);
    expect(tailFetch).toHaveBeenCalledTimes(2);
    await advance(5000);
    expect(tailFetch).toHaveBeenCalledTimes(3);

    // The third landed: no more attempts, however long the screen stays up.
    await advance(30000);
    expect(tailFetch).toHaveBeenCalledTimes(3);
  });

  it('gives up after three retries against a desktop that keeps failing', async () => {
    tailFetch.mockRejectedValue(new Error('refused'));
    await renderTab();
    await flushFetches();
    await advance(2000);
    await advance(5000);
    await advance(10000);
    expect(tailFetch).toHaveBeenCalledTimes(4);

    await advance(60000);
    expect(tailFetch).toHaveBeenCalledTimes(4);
  });

  it('drops a pending retry once the window lands some other way', async () => {
    tailFetch.mockRejectedValue(new Error('capability timeout'));
    await renderTab();
    await flushFetches();
    expect(tailFetch).toHaveBeenCalledTimes(1);

    await act(() => {
      useTranscriptStore.setState((state) => ({
        bySessionId: { 'sess-1': { ...state.bySessionId['sess-1'], needsTailFetch: false } },
      }));
    });
    await advance(20000);
    expect(tailFetch).toHaveBeenCalledTimes(1);
  });
});
