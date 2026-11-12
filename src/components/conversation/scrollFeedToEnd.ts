import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { FlashListRef } from '@shopify/flash-list';
import type { ScrollViewInstance } from 'react-native';

/**
 * Scrolls a chat feed to its end through the native scroll view, never through
 * FlashList's own `scrollToEnd`.
 *
 * When the last row is not rendered, FlashList's `scrollToEnd` runs
 * `scrollToIndex`, and that is the crash in Sentry MOBILE-F. Each step of it is
 * a state update queued from inside the list's layout effect, so a walk is one
 * unbroken chain of nested updates. A step restarts from the beginning whenever
 * the target has moved, and it moves every time a measurement changes the
 * estimate for the rows still unmeasured, by thousands of points on a long
 * transcript. Nothing caps the restarts, and each one passes through the commit
 * that resets FlashList's 40-render guard, so only React's limit of 50 ends it:
 * "Maximum update depth exceeded".
 *
 * A native scroll has none of that: it reports back as a scroll event, a new
 * task, so each round of measuring starts React's count from zero. It is also
 * how FlashList's own autoscroll reaches the bottom (`useBoundDetection`).
 *
 * What the native call gives up is landing exactly on an unmeasured bottom: it
 * goes to the content height as estimated right now. Keep calling it as the
 * size settles, which is what both feeds do through `useFeedEndAnchor`.
 *
 * Never animated. Animated, Jump to latest left the feed blank for good on a
 * release build, with the button still showing, so the list never heard where
 * it stopped: a long slide outruns `scrollEventThrottle`, the last event is
 * dropped (inferred from that symptom), and FlashList keeps rendering where it
 * last was. A jump is one event, which arrives. FlashList's own `scrollToEnd`
 * moves its model first (read from source), which is the walk above, and that
 * would explain why it did not blank (inferred).
 */
export function scrollFeedToEnd<Item>(list: FlashListRef<Item> | null): void {
  // flash-list 2.3.3 types the native scroll ref as the `ScrollView` component
  // value, which React Native 0.88 split from its instance type, so the typed
  // ref has no `scrollToEnd`. At runtime it is the instance, so narrow it to the
  // type RN exports for one. Drop the cast when flash-list adopts the split.
  const nativeScroll = list?.getNativeScrollRef() as unknown as ScrollViewInstance | null | undefined;
  nativeScroll?.scrollToEnd({ animated: false });
}

/**
 * The end anchor both chat feeds share: scroll to the end now, and once more on
 * the next frame unless the reader has taken over by then.
 *
 * The second scroll is the one that lands when the content grew in the same
 * commit. Read from React Native's source: on Android's new architecture a
 * content-size change reaches JS from the layout pass, before the taller content
 * is mounted, the mounting layer runs a view command AHEAD of the mount items it
 * is dispatched with (`MountItemDispatcher.kt`), and `scrollToEnd` reads the
 * content view's height when it executes (`ReactScrollViewManager.kt`). So the
 * immediate call can scroll to the OLD bottom, and no later size change comes to
 * correct it. That the next frame is late enough is inferred, and was seen on one
 * store shelf on the dev client only. The measurement is in the MOBILE-F section
 * of docs/developer-guide.md.
 *
 * The immediate call stays: it is right whenever the mount is already in, and
 * without it every growth would leave the feed a frame behind.
 */
export function useFeedEndAnchor<Item>(
  listRef: RefObject<FlashListRef<Item> | null>,
  userTookOverScrollRef: RefObject<boolean>,
): () => void {
  const pendingFrameRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (pendingFrameRef.current !== null) cancelAnimationFrame(pendingFrameRef.current);
    },
    [],
  );

  return useCallback(() => {
    scrollFeedToEnd(listRef.current);
    if (pendingFrameRef.current !== null) cancelAnimationFrame(pendingFrameRef.current);
    pendingFrameRef.current = requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      if (userTookOverScrollRef.current) return;
      scrollFeedToEnd(listRef.current);
    });
  }, [listRef, userTookOverScrollRef]);
}
