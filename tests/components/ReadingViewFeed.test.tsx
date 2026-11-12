/**
 * ReadingViewFeed: the chat lens for sessions without a structured transcript.
 * This covers the one thing about it that is invisible on screen and expensive
 * in the streaming path - the identity of the list's `data`.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { ReadingViewFeed } from '@/components/conversation/ReadingViewFeed';
import { useReadingViewStore } from '@/state/readingViewStore';

const capturedData: unknown[] = [];
const mockCapturedProps: {
  current: { onContentSizeChange?: () => void; onScroll?: (event: object) => void; onScrollBeginDrag?: () => void };
} = {
  current: {},
};
const mockFlashListScrollToEnd = jest.fn();
const mockNativeScrollToEnd = jest.fn();

jest.mock('@shopify/flash-list', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  return {
    __esModule: true,
    FlashList: ReactModule.forwardRef(function MockFlashList(
      props: {
        data: unknown;
        onContentSizeChange?: () => void;
        onScroll?: (event: object) => void;
        onScrollBeginDrag?: () => void;
      },
      forwardedRef: unknown,
    ) {
      capturedData.push(props.data);
      mockCapturedProps.current = props;
      ReactModule.useImperativeHandle(forwardedRef, () => ({
        scrollToEnd: mockFlashListScrollToEnd,
        getNativeScrollRef: () => ({ scrollToEnd: mockNativeScrollToEnd }),
      }));
      return null;
    }),
  };
});

async function renderFeed(): Promise<{ rerender: () => Promise<void> }> {
  const view = await render(
    <ThemeProvider>
      <ReadingViewFeed sessionId="sess-1" agentLabel="codex" />
    </ThemeProvider>,
  );
  return {
    rerender: () =>
      view.rerender(
        <ThemeProvider>
          <ReadingViewFeed sessionId="sess-1" agentLabel="codex" />
        </ThemeProvider>,
      ),
  };
}

/**
 * FlashList's own scrollToEnd is the walk behind Sentry MOBILE-F; the transcript
 * feed's half of this is tests/components/ConversationTab.anchorLoop.test.tsx.
 *
 * Mutation that reddens these: make `scrollFeedToEnd` call `list?.scrollToEnd`.
 */
describe('ReadingViewFeed scrolling to the newest line', () => {
  beforeEach(async () => {
    useReadingViewStore.getState().reset();
    mockFlashListScrollToEnd.mockClear();
    mockNativeScrollToEnd.mockClear();
    await act(() => {
      useReadingViewStore.getState().applyCleanLines('sess-1', ['npm run lint', 'All checks passed'], false);
    });
    await renderFeed();
  });

  it('anchors through the native scroll, not through the list', async () => {
    await act(() => {
      mockCapturedProps.current.onContentSizeChange?.();
    });

    expect(mockNativeScrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(mockFlashListScrollToEnd).not.toHaveBeenCalled();
  });

  it('jumps through the native scroll and hands the feed back to the anchor', async () => {
    await act(() => {
      mockCapturedProps.current.onScroll?.({
        nativeEvent: {
          contentOffset: { x: 0, y: 0 },
          contentSize: { width: 400, height: 30000 },
          layoutMeasurement: { width: 400, height: 800 },
        },
      });
    });

    await fireEvent.press(screen.getByTestId('reading-view-jump-to-latest'));

    expect(mockNativeScrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(mockFlashListScrollToEnd).not.toHaveBeenCalled();
  });

  /**
   * A drag takes the feed off the anchor; Jump to latest hands it back, until the
   * next drag.
   *
   * Mutation that reddens this: delete `userTookOverScrollRef.current = false;`
   * from `jumpToLatest` in ReadingViewFeed.tsx.
   */
  it('hands the feed back to the anchor after Jump to latest, until the next drag', async () => {
    await act(() => {
      mockCapturedProps.current.onScroll?.({
        nativeEvent: {
          contentOffset: { x: 0, y: 0 },
          contentSize: { width: 400, height: 30000 },
          layoutMeasurement: { width: 400, height: 800 },
        },
      });
    });
    expect(screen.getByTestId('reading-view-jump-to-latest')).toBeTruthy();

    await act(() => {
      mockCapturedProps.current.onScrollBeginDrag?.();
    });
    await act(() => {
      mockCapturedProps.current.onContentSizeChange?.();
    });
    expect(mockNativeScrollToEnd).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('reading-view-jump-to-latest'));
    mockNativeScrollToEnd.mockClear();
    await act(() => {
      mockCapturedProps.current.onContentSizeChange?.();
    });
    expect(mockNativeScrollToEnd).toHaveBeenCalledWith({ animated: false });

    mockNativeScrollToEnd.mockClear();
    await act(() => {
      mockCapturedProps.current.onScrollBeginDrag?.();
    });
    await act(() => {
      mockCapturedProps.current.onContentSizeChange?.();
    });
    expect(mockNativeScrollToEnd).not.toHaveBeenCalled();
  });
});

/**
 * The transcript feed's half of this is in tests/components/ConversationTab.test.tsx
 * ("the end anchor lands after the mount"), with the shelf it was found on. The
 * immediate scroll can run before the taller content is mounted, so the anchor
 * scrolls once more on the next frame unless the reader has dragged by then.
 *
 * Mutations that redden these: drop the deferred `scrollFeedToEnd` from
 * `useFeedEndAnchor` (the first), or its `userTookOverScrollRef` check (the
 * second).
 */
describe('ReadingViewFeed end anchor after the mount', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    useReadingViewStore.getState().reset();
    await act(() => {
      useReadingViewStore.getState().applyCleanLines('sess-1', ['npm run lint', 'All checks passed'], false);
    });
    await renderFeed();
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
    mockNativeScrollToEnd.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('scrolls to the end again on the next frame', async () => {
    await act(() => {
      mockCapturedProps.current.onContentSizeChange?.();
    });
    expect(mockNativeScrollToEnd).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(32);
    });
    expect(mockNativeScrollToEnd).toHaveBeenCalledTimes(2);
  });

  it('leaves the feed where a drag in that frame put it', async () => {
    await act(() => {
      mockCapturedProps.current.onContentSizeChange?.();
    });
    await act(() => {
      mockCapturedProps.current.onScrollBeginDrag?.();
    });
    await act(async () => {
      jest.advanceTimersByTime(32);
    });

    expect(mockNativeScrollToEnd).toHaveBeenCalledTimes(1);
  });

  /**
   * Mutation that reddens this: delete `if (pendingFrameRef.current !== null)
   * cancelAnimationFrame(pendingFrameRef.current);` from the callback
   * `useFeedEndAnchor` returns. Two frames' worth of calls then each schedule
   * their own deferred scroll, so 4 native calls land instead of 3.
   */
  it('coalesces two anchors inside one frame into one deferred scroll', async () => {
    await act(() => {
      mockCapturedProps.current.onContentSizeChange?.();
      mockCapturedProps.current.onContentSizeChange?.();
    });
    expect(mockNativeScrollToEnd).toHaveBeenCalledTimes(2);

    await act(async () => {
      jest.advanceTimersByTime(32);
    });
    expect(mockNativeScrollToEnd).toHaveBeenCalledTimes(3);
  });

  /**
   * The mock's ref goes null on unmount, so a leaked frame's scroll would be a
   * no-op and the native call count alone cannot see it. Assert the mechanism:
   * the pending frame's id is cancelled.
   *
   * Mutation that reddens this: delete the cleanup `useEffect` in
   * `useFeedEndAnchor`. The pending frame then survives the unmount.
   */
  it('cancels the pending frame when the feed unmounts', async () => {
    const requestSpy = jest.spyOn(globalThis, 'requestAnimationFrame');
    const cancelSpy = jest.spyOn(globalThis, 'cancelAnimationFrame');
    await act(() => {
      mockCapturedProps.current.onContentSizeChange?.();
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const pendingFrameId = requestSpy.mock.results[0]?.value as number;
    mockNativeScrollToEnd.mockClear();
    cancelSpy.mockClear();

    await act(() => {
      screen.unmount();
    });
    expect(cancelSpy).toHaveBeenCalledWith(pendingFrameId);

    await act(async () => {
      jest.advanceTimersByTime(32);
    });
    expect(mockNativeScrollToEnd).not.toHaveBeenCalled();
  });

  /**
   * Mutation that reddens this: make `jumpToLatest` in ReadingViewFeed.tsx call
   * `scrollFeedToEnd(listRef.current)` directly (imported from
   * './scrollFeedToEnd') instead of `anchorToEnd()`.
   */
  it('scrolls again on the next frame after Jump to latest', async () => {
    await act(() => {
      mockCapturedProps.current.onScroll?.({
        nativeEvent: {
          contentOffset: { x: 0, y: 0 },
          contentSize: { width: 400, height: 30000 },
          layoutMeasurement: { width: 400, height: 800 },
        },
      });
    });
    await fireEvent.press(screen.getByTestId('reading-view-jump-to-latest'));
    expect(mockNativeScrollToEnd).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(32);
    });
    expect(mockNativeScrollToEnd).toHaveBeenCalledTimes(2);
    expect(mockNativeScrollToEnd).toHaveBeenLastCalledWith({ animated: false });
  });
});

describe('ReadingViewFeed list data identity', () => {
  beforeEach(() => {
    capturedData.length = 0;
    useReadingViewStore.getState().reset();
  });

  /**
   * A fresh `data` array makes FlashList re-run layout for the whole list. This
   * component re-renders on every cleaned-output revision, so rebuilding the
   * rows inline meant re-laying-out the feed on every frame of a streaming
   * turn - the hot path, not an edge case.
   */
  it('hands FlashList the same rows array when the lines have not changed', async () => {
    await act(() => {
      useReadingViewStore.getState().applyCleanLines('sess-1', ['npm run lint', 'All checks passed'], false);
    });
    const { rerender } = await renderFeed();
    await rerender();

    expect(capturedData.length).toBeGreaterThanOrEqual(2);
    const [firstRows, secondRows] = capturedData;
    expect(secondRows).toBe(firstRows);
  });

  it('hands FlashList a new rows array once the lines change', async () => {
    await act(() => {
      useReadingViewStore.getState().applyCleanLines('sess-1', ['npm run lint'], false);
    });
    await renderFeed();
    const beforeAppend = capturedData[capturedData.length - 1];

    await act(() => {
      useReadingViewStore.getState().applyCleanLines('sess-1', ['All checks passed'], false);
    });

    const afterAppend = capturedData[capturedData.length - 1];
    expect(afterAppend).not.toBe(beforeAppend);
    expect(afterAppend).toHaveLength(2);
  });
});
