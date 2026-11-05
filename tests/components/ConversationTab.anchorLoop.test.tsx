/**
 * Sentry MOBILE-F, reproduced: "Maximum update depth exceeded" from the feed's
 * FlashList. This drives the REAL FlashList, the REAL feed and React's own
 * nested-update limit. The only thing scripted is what each cell measures.
 *
 * FlashList's `scrollToEnd` runs `scrollToIndex` when the last row is not
 * rendered, and a step of that is a state update queued inside the list's layout
 * effect. A step restarts whenever the target moved, and on a transcript opened
 * straight at the bottom almost every row is unmeasured, so one measurement
 * re-estimates them all and moves it by thousands of points. Traced on a
 * transcript of this shape, it restarted more than twenty times, each restart
 * costing a render that lays out and a render that commits. That commit resets
 * FlashList's 40-render guard, so React's limit of 50 is what ends it.
 *
 * The transcript is a search result, and an extreme one: of 2,400 random
 * transcripts two runs threw, nine in ten stayed under 20 renders, and this is
 * the one that threw, hill-climbed until it was not a matter of luck. Through
 * the unfixed path it throws at 15 of 16 window heights from 560 to 880. Scaled
 * down it needs its tall cells around 1,700 points or more, about two screens
 * each, and stops throwing by 1,190. The site alternates in bands of window
 * height between `commitLayout` and `setRenderId`, the line Sentry reported,
 * because the same chain alternates between the two. 800 is in a `setRenderId`
 * band.
 *
 * It only has to stay a transcript that throws through the unfixed path. If a
 * FlashList bump stops this reddening under the mutation named below, search
 * again rather than trusting the green.
 *
 * Mutation that reddens these: make `scrollFeedToEnd` call `list?.scrollToEnd`.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { TranscriptEntryWire } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { ConversationTab } from '@/screens/task/ConversationTab';
import { useActivityStore } from '@/state/activityStore';
import { resetTerminalFeed } from '@/state/terminalFeed';
import { useTranscriptStore } from '@/state/transcriptStore';

jest.mock('@/connection/actions', () => ({
  sendUserMessage: jest.fn().mockResolvedValue(undefined),
  answerPermissionPrompt: jest.fn().mockResolvedValue(undefined),
  loadTranscriptTail: jest.fn().mockResolvedValue(undefined),
  loadOlderTranscript: jest.fn().mockResolvedValue(undefined),
}));

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

jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: jest.fn().mockReturnValue(true),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    start: jest.fn(),
    stop: jest.fn(),
  },
  useSpeechRecognitionEvent: jest.fn(),
}));

const mockReportCaughtError = jest.fn();
jest.mock('@/observability/crashReporting', () => ({
  ...jest.requireActual('@/observability/crashReporting'),
  reportCaughtError: (error: Error, boundary: string) => mockReportCaughtError(error, boundary),
}));

const WINDOW_HEIGHT = 800;
const CELL_WIDTH = 400;

/** What each data index measures. Scripted per test. */
const mockMeasurement: { cellHeight: (index: number) => number; windowHeight: number } = {
  cellHeight: () => 100,
  windowHeight: 800,
};

jest.mock('@shopify/flash-list/dist/recyclerview/utils/measureLayout', () => ({
  ...jest.requireActual('@shopify/flash-list/dist/recyclerview/utils/measureLayout'),
  measureParentSize: () => ({ width: 400, height: mockMeasurement.windowHeight }),
  measureFirstChildLayout: () => ({ x: 0, y: 0, width: 400, height: 0 }),
  measureItemLayout: (cell: { scriptedIndex: number }) => ({
    x: 0,
    y: 0,
    width: 400,
    height: mockMeasurement.cellHeight(cell.scriptedIndex),
  }),
}));

const mockNativeScrollToEnd = jest.fn();
const mockListProps: { drawDistance: number | undefined } = { drawDistance: undefined };
/** Resolved by FlashList's `onLoad`, the moment `isFirstPaintOnUiComplete` is set. */
const mockFirstPaint: { signal: () => void } = { signal: () => undefined };

// The REAL FlashList, plus: a cell container whose ref says which data index it
// holds, a spy on the native scroll, and a signal for first paint. FlashList
// lays out differently before and after first paint, so which of first paint and
// the first size change comes first is a race on a device, and the reason the
// test has to order them itself.
jest.mock('@shopify/flash-list', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  const ActualFlashListModule = jest.requireActual('@shopify/flash-list');
  const ScriptedCell = ReactModule.forwardRef(function ScriptedCell(
    { index, ...viewProps }: { index: number },
    forwardedRef: React.Ref<{ scriptedIndex: number }>,
  ) {
    ReactModule.useImperativeHandle(forwardedRef, () => ({ scriptedIndex: index }), [index]);
    return ReactModule.createElement(View, viewProps);
  });
  const ScriptedFlashList = ReactModule.forwardRef(function ScriptedFlashList(
    props: { drawDistance?: number },
    forwardedRef: unknown,
  ) {
    const innerRef = ReactModule.useRef(null);
    mockListProps.drawDistance = props.drawDistance;
    ReactModule.useImperativeHandle(forwardedRef, () => ({
      // The real one, so the mutation above reaches the real walk.
      scrollToEnd: (params?: { animated?: boolean }) => innerRef.current?.scrollToEnd(params),
      getNativeScrollRef: () => ({ scrollToEnd: mockNativeScrollToEnd }),
    }));
    return ReactModule.createElement(ActualFlashListModule.FlashList, {
      ...props,
      ref: innerRef,
      CellRendererComponent: ScriptedCell,
      onLoad: () => mockFirstPaint.signal(),
    });
  });
  return { ...ActualFlashListModule, FlashList: ScriptedFlashList };
});

interface ManagerPrototype {
  updateScrollOffset: (this: unknown, offset: number, velocity?: unknown) => unknown;
}

const managerPrototype = (
  jest.requireActual('@shopify/flash-list/dist/recyclerview/RecyclerViewManager') as {
    RecyclerViewManager: { prototype: ManagerPrototype };
  }
).RecyclerViewManager.prototype;

/** One user line and one assistant answer per turn: two cells, two item types. */
function transcript(turnCount: number): TranscriptEntryWire[] {
  const entries: TranscriptEntryWire[] = [];
  for (let turn = 0; turn < turnCount; turn += 1) {
    entries.push({ kind: 'user', uuid: `user-${turn}`, ts: turn * 2, text: `Question ${turn}` });
    entries.push({
      kind: 'assistant',
      uuid: `assistant-${turn}`,
      ts: turn * 2 + 1,
      blocks: [{ type: 'text', text: `Answer ${turn}` }],
    });
  }
  return entries;
}

/** Stretches of a session, as [measured height, cell count]: long reports, then terse exchanges. */
const CELL_STRETCHES: [height: number, count: number][] = [
  [2380, 31],
  [30, 35],
  [2380, 28],
  [2100, 37],
  [665, 14],
  [30, 54],
  [1148, 1],
];

const TURN_COUNT = 100;
const CELL_HEIGHTS = CELL_STRETCHES.flatMap(([height, count]) => Array.from({ length: count }, () => height));

function seedSession(): void {
  const entries = transcript(TURN_COUNT);
  useTranscriptStore.getState().reset();
  useActivityStore.getState().reset();
  resetTerminalFeed();
  useTranscriptStore.setState({
    bySessionId: {
      'sess-1': {
        hasWindow: true,
        entries,
        startIndex: 0,
        totalEntries: entries.length,
        revision: 1,
        tailRevision: 1,
        needsTailFetch: false,
      },
    },
    retainedSessionIds: ['sess-1'],
  });
  useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
}

/** Opens the feed and waits for first paint, the order the long walk needs. */
async function openFeed(): Promise<void> {
  const firstPaint = new Promise<void>((resolve) => {
    mockFirstPaint.signal = resolve;
  });
  await render(
    <ThemeProvider>
      <ConversationTab taskId="task-1" sessionId="sess-1" projectId="project-1" />
    </ThemeProvider>,
  );
  await act(async () => {
    await firstPaint;
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

/**
 * Waits out the feed's settling deadline, which puts the list on its resting
 * draw distance: the state a late window lands in, and the only one a reader
 * can press anything in. This is load-bearing. While settling, the wider band
 * measures enough that the unfixed walk stays under the limit on this
 * transcript, so anchoring before this would pass with the bug put back.
 */
async function waitForReveal(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 750));
  });
}

function scrollEventAt(offset: number): { nativeEvent: object } {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: CELL_WIDTH, height: offset + WINDOW_HEIGHT },
      layoutMeasurement: { width: CELL_WIDTH, height: WINDOW_HEIGHT },
    },
  };
}

describe('ConversationTab - anchoring a long transcript (Sentry MOBILE-F)', () => {
  let consoleError: jest.SpyInstance;
  let consoleWarn: jest.SpyInstance;

  beforeEach(() => {
    seedSession();
    mockMeasurement.cellHeight = (index) => CELL_HEIGHTS[index] ?? 100;
    mockMeasurement.windowHeight = WINDOW_HEIGHT;
    mockReportCaughtError.mockClear();
    mockNativeScrollToEnd.mockClear();
    // React logs a caught error, and FlashList warns when its guard trips.
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    jest.restoreAllMocks();
  });

  it('anchors a long transcript without reaching the update limit', async () => {
    await openFeed();
    await waitForReveal();
    const list = screen.getByTestId('conversation-list');

    await fireEvent(list, 'contentSizeChange', CELL_WIDTH, 2000);
    await settle();
    // The round trip a device makes: the native scroll reports back as an event.
    await fireEvent.scroll(list, scrollEventAt(30000));
    await settle();

    expect(mockReportCaughtError).not.toHaveBeenCalled();
    expect(screen.queryByTestId('feed-error')).toBeNull();
  });

  /**
   * The assertion that cannot pass by accident. The test above stays green on
   * any transcript too mild to throw; this one fails on the unfixed path for
   * every transcript, because a walk drives the offset from JavaScript.
   */
  it('anchors through the native scroll, without driving the list from JavaScript', async () => {
    await openFeed();
    const updateScrollOffset = jest.spyOn(managerPrototype, 'updateScrollOffset');

    await fireEvent(screen.getByTestId('conversation-list'), 'contentSizeChange', CELL_WIDTH, 2000);
    await settle();

    expect(updateScrollOffset).not.toHaveBeenCalled();
    expect(mockNativeScrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  /**
   * The walk the native scroll replaced had one useful side effect: it measured
   * about two windows above the bottom on its way down. Without that the first
   * drag runs into rows estimated far too tall, each collapses as it arrives, and
   * the feed snaps back toward the bottom. Measured on a release build; the
   * numbers are in the developer guide's MOBILE-F section.
   *
   * So the list measures that band while it settles unseen, then drops back. The
   * resting value has to be explicit: FlashList reads this prop as
   * `drawDistance ?? current`, so `undefined` would leave it wide for good, with
   * nothing wrong on screen.
   *
   * Mutations that redden this: pass `RESTING_DRAW_DISTANCE` throughout, or
   * `undefined` once revealed.
   */
  it('measures a band above the bottom while it settles, then drops back', async () => {
    await openFeed();
    const settlingDrawDistance = mockListProps.drawDistance ?? 0;
    expect(settlingDrawDistance).toBeGreaterThan(WINDOW_HEIGHT);

    await fireEvent(screen.getByTestId('conversation-list'), 'contentSizeChange', CELL_WIDTH, 2000);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(mockListProps.drawDistance).toBe(250);
  });

  describe('Jump to latest', () => {
    async function showJumpToLatest(): Promise<void> {
      await openFeed();
      await waitForReveal();
      const list = screen.getByTestId('conversation-list');
      await fireEvent(list, 'scrollBeginDrag');
      await fireEvent.scroll(list, {
        nativeEvent: {
          contentOffset: { x: 0, y: 0 },
          contentSize: { width: CELL_WIDTH, height: 30000 },
          layoutMeasurement: { width: CELL_WIDTH, height: WINDOW_HEIGHT },
        },
      });
    }

    /** It took the same walk: this transcript threw from the button as well. */
    it('jumps without reaching the update limit', async () => {
      await showJumpToLatest();

      await fireEvent.press(screen.getByTestId('jump-to-latest'));
      await settle();

      expect(mockReportCaughtError).not.toHaveBeenCalled();
      // Never animated: on a release build a long animated slide left the feed
      // blank for good, because the list never heard where it stopped.
      expect(mockNativeScrollToEnd).toHaveBeenCalledWith({ animated: false });
    });

    /**
     * The native scroll aims at the estimated height, so it can stop short of an
     * unmeasured bottom. Only the anchor corrects that, and a drag had stopped it.
     *
     * Mutation that reddens this: drop the reset in `jumpToLatest`.
     */
    it('hands the feed back to the anchor, until the next drag', async () => {
      await showJumpToLatest();
      const list = screen.getByTestId('conversation-list');

      await fireEvent(list, 'contentSizeChange', CELL_WIDTH, 2000);
      expect(mockNativeScrollToEnd).not.toHaveBeenCalled();

      await fireEvent.press(screen.getByTestId('jump-to-latest'));
      mockNativeScrollToEnd.mockClear();
      await fireEvent(list, 'contentSizeChange', CELL_WIDTH, 2400);
      expect(mockNativeScrollToEnd).toHaveBeenCalledWith({ animated: false });

      mockNativeScrollToEnd.mockClear();
      await fireEvent(list, 'scrollBeginDrag');
      await fireEvent(list, 'contentSizeChange', CELL_WIDTH, 2800);
      expect(mockNativeScrollToEnd).not.toHaveBeenCalled();
    });
  });
});
