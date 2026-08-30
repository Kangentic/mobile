/**
 * ReadingViewFeed: the chat lens for sessions without a structured transcript.
 * This covers the one thing about it that is invisible on screen and expensive
 * in the streaming path - the identity of the list's `data`.
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { ReadingViewFeed } from '@/components/conversation/ReadingViewFeed';
import { useReadingViewStore } from '@/state/readingViewStore';

const capturedData: unknown[] = [];

jest.mock('@shopify/flash-list', () => ({
  __esModule: true,
  FlashList: (props: { data: unknown }) => {
    capturedData.push(props.data);
    return null;
  },
}));

function renderFeed(): { rerender: () => void } {
  const view = render(
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
  it('hands FlashList the same rows array when the lines have not changed', () => {
    act(() => {
      useReadingViewStore.getState().applyCleanLines('sess-1', ['npm run lint', 'All checks passed'], false);
    });
    const { rerender } = renderFeed();
    rerender();

    expect(capturedData.length).toBeGreaterThanOrEqual(2);
    const [firstRows, secondRows] = capturedData;
    expect(secondRows).toBe(firstRows);
  });

  it('hands FlashList a new rows array once the lines change', () => {
    act(() => {
      useReadingViewStore.getState().applyCleanLines('sess-1', ['npm run lint'], false);
    });
    renderFeed();
    const beforeAppend = capturedData[capturedData.length - 1];

    act(() => {
      useReadingViewStore.getState().applyCleanLines('sess-1', ['All checks passed'], false);
    });

    const afterAppend = capturedData[capturedData.length - 1];
    expect(afterAppend).not.toBe(beforeAppend);
    expect(afterAppend).toHaveLength(2);
  });
});
