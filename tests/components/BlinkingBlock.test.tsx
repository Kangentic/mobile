import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { BlinkingBlock } from '@/components/motion/BlinkingBlock';

/**
 * `BlinkingBlock`'s own contract, direct: a two-state toggle on a JS
 * interval, never a Reanimated mapper (see motion-conventions.md's
 * "an animation that never stops" section - the cursor blink is sanctioned
 * ONLY because it is cheap and stops). Its composed behaviour (the veil's
 * cursor toggling on the theme's waitCursorBlink timing, resting under
 * reduced motion or while blurred) is pinned through SessionSwapVeil.test.tsx;
 * this file covers the component in isolation, in particular the unmount
 * cleanup nothing else exercises.
 */
describe('BlinkingBlock', () => {
  const baseStyle = { width: 8, height: 8 };

  it('starts lit and toggles opacity between max and min on the interval', () => {
    jest.useFakeTimers();
    try {
      render(<BlinkingBlock testID="blink" baseStyle={baseStyle} intervalMs={500} opacityMin={0.2} opacityMax={0.9} />);

      const opacity = (): number => StyleSheet.flatten(screen.getByTestId('blink').props.style).opacity as number;
      expect(opacity()).toBe(0.9);

      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(opacity()).toBe(0.2);

      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(opacity()).toBe(0.9);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The motion-conventions.md exception for a never-ending animation is
   * granted on the premise that it is cheap and stoppable. An interval that
   * outlives its component is neither: it keeps firing (and keeps the
   * component's closure reachable) for as long as the process runs. Fake
   * timers make the leak directly observable as a still-pending timer,
   * independent of whether a `setState` on an unmounted component happens to
   * warn - it does not, on the React version this project pins, so that
   * would not be a discriminating assertion.
   *
   * Mutation seen failing: removing the `return () => clearInterval(handle)`
   * cleanup from BlinkingBlock's effect left one pending timer after unmount
   * instead of zero - "expected 1 to be 0".
   */
  it('clears its interval on unmount, leaving no pending timer', () => {
    jest.useFakeTimers();
    try {
      const { unmount } = render(
        <BlinkingBlock testID="blink" baseStyle={baseStyle} intervalMs={500} opacityMin={0.2} opacityMax={0.9} />,
      );
      expect(jest.getTimerCount()).toBe(1);

      unmount();

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
