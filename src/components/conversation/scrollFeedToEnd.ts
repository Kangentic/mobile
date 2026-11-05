import type { FlashListRef } from '@shopify/flash-list';

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
 * size settles, which is what both feeds' `onContentSizeChange` does.
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
  list?.getNativeScrollRef()?.scrollToEnd({ animated: false });
}
