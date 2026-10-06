/**
 * SectionLandingPulse: the Agents feed's tint when a row lands in a new section.
 *
 * Three behaviours here are silent when broken:
 *
 *   A TINT THAT OUTLIVES ITS FADE. On 2026-10-05 an iOS card kept the overlay's
 *   first write (alpha 0.16, measured from the screenshot) until the app was
 *   force-killed, because the overlay was mounted for good and only Reanimated
 *   frames could clear it. Jest's Reanimated mock never advances a tween, so
 *   every test here runs in exactly that stuck state: the overlay holds full
 *   strength until the gate's JS timer unmounts it, and nothing else can.
 *
 *   A MAPPER ON A RESTING ROW. A registered mapper is walked on every frame,
 *   dirty or not (~0.47 CPU points each, measured on a release build; see
 *   motion-conventions.md). An overlay that rendered nothing visible but kept
 *   its useAnimatedStyle would pass every rendering assertion, which is why the
 *   "registered mappers" block asserts the hook itself, copied from
 *   AgentStatusIcon.test.tsx.
 *
 *   A TIMER THAT OUTLIVES ITS ROW. A recycled or scrolled-away row unmounts the
 *   gate mid-pulse, and the timer must go with it.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import * as Reanimated from 'react-native-reanimated';
import { ThemeProvider, darkTerminalTheme } from '@/components';
import { SectionLandingPulse } from '@/screens/home/SectionLandingPulse';

const PULSE_TEST_ID = 'activity-row-sess-1-pulse';
const { windowMs: SECTION_PULSE_WINDOW_MS, opacityMax: SECTION_PULSE_MAX_OPACITY, durationMs, unmountMarginMs } =
  darkTerminalTheme.motion.sectionPulse;
/** How long the overlay stays mounted: the fade plus the unmount margin. */
const SECTION_PULSE_MOUNT_MS = durationMs + unmountMarginMs;

function renderPulse(changedAtMs: number): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <SectionLandingPulse changedAtMs={changedAtMs} testID={PULSE_TEST_ID} />
    </ThemeProvider>,
  );
}

function pulseOpacity(): unknown {
  return StyleSheet.flatten(screen.getByTestId(PULSE_TEST_ID).props.style).opacity;
}

describe('SectionLandingPulse', () => {
  beforeEach(() => {
    // RNTL 14 awaits React's act, which schedules its flush with queueMicrotask.
    // Faked, those jobs sit on the fake clock and jest.getTimerCount() counts
    // them. Leave queueMicrotask real so the assertions below count the bound's
    // own setTimeout alone.
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    jest.setSystemTime(new Date('2026-10-05T10:29:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('the window', () => {
    it('tints a row that changed section just now, at full strength, in the accent', async () => {
      await renderPulse(Date.now());

      const overlay = screen.getByTestId(PULSE_TEST_ID);
      expect(pulseOpacity()).toBe(SECTION_PULSE_MAX_OPACITY);
      expect(StyleSheet.flatten(overlay.props.style).backgroundColor).toBe(darkTerminalTheme.colors.accent);
      // It paints over the card, so it must never take the card's press.
      expect(overlay.props.pointerEvents).toBe('none');
    });

    it('still tints a row mounted on the last millisecond of the window', async () => {
      await renderPulse(Date.now() - (SECTION_PULSE_WINDOW_MS - 1));
      expect(screen.getByTestId(PULSE_TEST_ID)).toBeTruthy();
    });

    it('mounts nothing once the window has passed', async () => {
      await renderPulse(Date.now() - SECTION_PULSE_WINDOW_MS);
      expect(screen.queryByTestId(PULSE_TEST_ID)).toBeNull();
    });
  });

  describe('the fade', () => {
    /**
     * The tint is leaving while the user watches, which is what
     * motion-conventions.md reserves the accelerate curve for. Asserted on the
     * calls because the jest mock never runs a tween, so the drawn output is
     * identical on any curve.
     */
    it('fades to 0 over the theme duration on the accelerate curve', async () => {
      // The bezier spy hands back a sentinel, so the options assertion below
      // proves the value the accelerate curve PRODUCED reached withTiming. Only
      // asserting the bezier call would pass with `easing:` dropped from the
      // options, which falls back to Reanimated's default curve. The factory
      // closure is unique to this sentinel, so the equality there is identity.
      const accelerateEasing: Reanimated.EasingFunctionFactory = { factory: () => (progress: number) => progress };
      const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
      const bezierSpy = jest.spyOn(Reanimated.Easing, 'bezier').mockReturnValue(accelerateEasing);
      await renderPulse(Date.now());

      const { x1, y1, x2, y2 } = darkTerminalTheme.motion.easing.accelerate;
      expect(bezierSpy).toHaveBeenCalledWith(x1, y1, x2, y2);
      expect(withTimingSpy).toHaveBeenCalledWith(
        0,
        expect.objectContaining({
          duration: durationMs,
          easing: accelerateEasing,
          reduceMotion: Reanimated.ReduceMotion.System,
        }),
      );
    });

    /**
     * The fade's effect cleanup stops its tween. Jest's cancelAnimation is a
     * no-op and its withTiming never runs a frame, so deleting the call leaves
     * every other test here green: the call itself is the only observable. It
     * matters on a real device, where a tween on a view that is going away keeps
     * writing to a native node that a recycled row may now own.
     *
     * The shared value is captured through a call-through spy on useSharedValue
     * and compared by identity (not by value: the mock's withTiming already
     * wrote 0 into it). The zero-calls check on the way in proves the later call
     * is the cleanup's and not the mount's.
     */
    it('cancels the fade on its own shared value when the row unmounts mid-pulse', async () => {
      const sharedValueSpy = jest.spyOn(Reanimated, 'useSharedValue');
      const cancelSpy = jest.spyOn(Reanimated, 'cancelAnimation');
      const { unmount } = await renderPulse(Date.now());
      const fadeOpacity = sharedValueSpy.mock.results[sharedValueSpy.mock.results.length - 1]?.value;
      expect(fadeOpacity).toBeDefined();
      expect(cancelSpy).not.toHaveBeenCalled();

      await unmount();
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(cancelSpy.mock.calls[0][0]).toBe(fadeOpacity);
    });

    it('cancels the fade on its own shared value when the JS timer unmounts the overlay', async () => {
      const sharedValueSpy = jest.spyOn(Reanimated, 'useSharedValue');
      const cancelSpy = jest.spyOn(Reanimated, 'cancelAnimation');
      await renderPulse(Date.now());
      const fadeOpacity = sharedValueSpy.mock.results[sharedValueSpy.mock.results.length - 1]?.value;
      expect(fadeOpacity).toBeDefined();

      await act(() => {
        jest.advanceTimersByTime(SECTION_PULSE_MOUNT_MS - 1);
      });
      expect(cancelSpy).not.toHaveBeenCalled();

      await act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(screen.queryByTestId(PULSE_TEST_ID)).toBeNull();
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(cancelSpy.mock.calls[0][0]).toBe(fadeOpacity);
    });
  });

  describe('the JS-timer bound', () => {
    it('unmounts after SECTION_PULSE_MOUNT_MS although no fade frame ever arrived', async () => {
      await renderPulse(Date.now());

      await act(() => {
        jest.advanceTimersByTime(SECTION_PULSE_MOUNT_MS - 1);
      });
      // Still the first write: the stuck iOS card's exact state.
      expect(pulseOpacity()).toBe(SECTION_PULSE_MAX_OPACITY);

      await act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(screen.queryByTestId(PULSE_TEST_ID)).toBeNull();

      await act(() => {
        jest.advanceTimersByTime(SECTION_PULSE_WINDOW_MS * 2);
      });
      expect(screen.queryByTestId(PULSE_TEST_ID)).toBeNull();
    });

    it('clears its timer when the row unmounts mid-pulse', async () => {
      const { unmount } = await renderPulse(Date.now());
      // The positive arm: proves the count can see the bound's timer at all.
      expect(jest.getTimerCount()).toBe(1);

      await unmount();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('arms no timer outside the window', async () => {
      await renderPulse(Date.now() - SECTION_PULSE_WINDOW_MS);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('registered mappers (the idle-CPU lever)', () => {
    it('registers no animated mapper outside the window', async () => {
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
      await renderPulse(Date.now() - SECTION_PULSE_WINDOW_MS);
      expect(animatedStyleSpy).not.toHaveBeenCalled();
    });

    /**
     * Reduced motion mounts nothing. ReduceMotion.System snaps the fade to 0
     * before its first write paints, so the always-mounted overlay never showed
     * a tint there either; mounting this one would paint a frame at full
     * strength and then cut.
     */
    it('mounts nothing and registers no animated mapper under reduced motion', async () => {
      jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
      await renderPulse(Date.now());
      expect(screen.queryByTestId(PULSE_TEST_ID)).toBeNull();
      expect(animatedStyleSpy).not.toHaveBeenCalled();
    });

    it('registers exactly one animated mapper while pulsing', async () => {
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
      await renderPulse(Date.now());
      expect(animatedStyleSpy).toHaveBeenCalledTimes(1);
    });
  });
});
