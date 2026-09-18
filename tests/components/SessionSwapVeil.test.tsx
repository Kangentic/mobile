import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import * as Reanimated from 'react-native-reanimated';
import { ThemeProvider, darkTerminalTheme } from '@/components';
import { ScreenMotionOverride } from '@/components/motion/ScreenMotion';
import {
  SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL,
  SESSION_SWAP_WAITING_ACCESSIBILITY_LABEL,
  SessionSwapVeil,
} from '@/screens/task/SessionSwapVeil';

const { opacityMin, opacityMax } = darkTerminalTheme.motion.swapVeilPulse;

/**
 * The veil's own contract: silent, covering, breathing only when motion is
 * allowed. What OPENS and RELEASES it is SessionScreen's, pinned in
 * SessionScreen.session-swap.test.tsx.
 */
describe('SessionSwapVeil', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * The whole ask: nothing to read. A caption or title added "for clarity"
   * would pass every other test here and fail exactly this one.
   */
  it('renders no text at all', () => {
    render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('session-swap-veil')).toBeTruthy();
    expect(screen.UNSAFE_queryAllByType(Text)).toHaveLength(0);
  });

  it('is one modal, busy progress stop for a screen reader, with a descriptive label', () => {
    render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    const veil = screen.getByTestId('session-swap-veil');
    expect(veil.props.accessibilityViewIsModal).toBe(true);
    expect(veil.props.accessibilityRole).toBe('progressbar');
    expect(veil.props.accessibilityLabel).toBe(SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL);
    expect(veil.props.accessibilityState).toEqual({ busy: true });
  });

  /**
   * The veil must swallow a tap on the covered pane (a tap on the terminal
   * WebView toggles the keyboard for a dead PTY), so its root keeps the
   * default pointer behaviour. `pointerEvents="none"` on the root would look
   * harmless and let taps fall through.
   */
  it('keeps its root tappable so the covered pane cannot be reached', () => {
    render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('session-swap-veil').props.pointerEvents).not.toBe('none');
  });

  /** Above the panes' zIndex: 1, the same stacking pin the two text overlays carry. */
  it('stacks above the session panes', () => {
    render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil').props.style);
    expect(typeof flattenedStyle.zIndex).toBe('number');
    expect(flattenedStyle.zIndex).toBeGreaterThanOrEqual(2);
  });

  it('starts the pulse at the max opacity over the theme background when motion is allowed', () => {
    render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil-scrim').props.style);
    expect(flattenedStyle.opacity).toBe(opacityMax);
    expect(flattenedStyle.backgroundColor).toBe(darkTerminalTheme.colors.background);
  });

  /**
   * The waiting phase: the same veil, with the empty terminal painted UNDER
   * its scrim in place of the dead session's last frame, the scrim held
   * STILL, a cursor breathing above it at the grid's origin, the waiting
   * label, and still nothing to read. The desktop's launch overlay is a
   * spinner over a blank terminal area; this is the terminal's own version.
   */
  describe('the waiting phase', () => {
    it('paints the empty terminal under a static scrim with a cursor above it, and still renders no text', () => {
      render(
        <ThemeProvider>
          <SessionSwapVeil waiting />
        </ThemeProvider>,
      );

      const veil = screen.getByTestId('session-swap-veil');
      expect(veil.props.accessibilityLabel).toBe(SESSION_SWAP_WAITING_ACCESSIBILITY_LABEL);
      const emptyLayer = screen.getByTestId('session-swap-veil-empty');
      expect(StyleSheet.flatten(emptyLayer.props.style).backgroundColor).toBe(
        darkTerminalTheme.colors.terminalBackground,
      );
      expect(emptyLayer.props.pointerEvents).toBe('none');
      // Painted in this order: the empty terminal, the scrim that dims it,
      // then the cursor ABOVE the scrim so the scrim does not dim it away.
      const layerOrder = veil.children.map((child) => (typeof child === 'string' ? child : child.props.testID));
      expect(layerOrder).toEqual(['session-swap-veil-empty', 'session-swap-veil-scrim', 'session-swap-veil-cursor']);
      const cursorStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil-cursor').props.style);
      expect(cursorStyle.backgroundColor).toBe(darkTerminalTheme.colors.textSecondary);
      expect(cursorStyle.opacity).toBe(darkTerminalTheme.motion.waitCursorBlink.opacityMax);
      expect(screen.UNSAFE_queryAllByType(Text)).toHaveLength(0);
    });

    /**
     * The performance finding behind the cursor's shape, measured on the
     * release build (emulator, 2026-09-18) with the pane hidden under the
     * cleared veil: a tweened breath on the cell-sized cursor drew a whole
     * window frame per vsync (57 a second at 24-28% of a core), the same cost
     * the full-screen scrim breath had, while the identical veil held static
     * drew nothing (1.5-4%). A frame costs what it costs however small the
     * view that changed. So once the pane has cleared the scrim is the static
     * branch and the cursor is a two-state toggle on a JS interval: NO
     * Reanimated mapper in the waiting phase at all, one commit per
     * half-period, lit then dim.
     */
    it('holds the scrim static once cleared, registers no mapper, and blinks the cursor on the interval', () => {
      jest.useFakeTimers();
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
      const { intervalMs, opacityMin: cursorMin, opacityMax: cursorMax } = darkTerminalTheme.motion.waitCursorBlink;

      try {
        render(
          <ThemeProvider>
            <ScreenMotionOverride active={true}>
              <SessionSwapVeil waiting />
            </ScreenMotionOverride>
          </ThemeProvider>,
        );

        const scrimStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil-scrim').props.style);
        expect(scrimStyle.opacity).toBe((opacityMin + opacityMax) / 2);
        expect(animatedStyleSpy).not.toHaveBeenCalled();

        const cursorOpacity = (): number =>
          StyleSheet.flatten(screen.getByTestId('session-swap-veil-cursor').props.style).opacity as number;
        expect(cursorOpacity()).toBe(cursorMax);
        act(() => {
          jest.advanceTimersByTime(intervalMs);
        });
        expect(cursorOpacity()).toBe(cursorMin);
        act(() => {
          jest.advanceTimersByTime(intervalMs);
        });
        expect(cursorOpacity()).toBe(cursorMax);
      } finally {
        jest.useRealTimers();
      }
    });

    it('rests the cursor at its mid opacity, never toggling, under OS reduced motion', () => {
      jest.useFakeTimers();
      jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
      const { intervalMs, opacityMin: cursorMin, opacityMax: cursorMax } = darkTerminalTheme.motion.waitCursorBlink;

      try {
        render(
          <ThemeProvider>
            <SessionSwapVeil waiting />
          </ThemeProvider>,
        );

        const cursorOpacity = (): number =>
          StyleSheet.flatten(screen.getByTestId('session-swap-veil-cursor').props.style).opacity as number;
        expect(cursorOpacity()).toBe((cursorMin + cursorMax) / 2);
        act(() => {
          jest.advanceTimersByTime(intervalMs * 2);
        });
        expect(cursorOpacity()).toBe((cursorMin + cursorMax) / 2);
        expect(animatedStyleSpy).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('rests the cursor at its mid opacity, never toggling, while the screen is blurred', () => {
      jest.useFakeTimers();
      const { intervalMs, opacityMin: cursorMin, opacityMax: cursorMax } = darkTerminalTheme.motion.waitCursorBlink;

      try {
        render(
          <ThemeProvider>
            <ScreenMotionOverride active={false}>
              <SessionSwapVeil waiting />
            </ScreenMotionOverride>
          </ThemeProvider>,
        );

        const cursorOpacity = (): number =>
          StyleSheet.flatten(screen.getByTestId('session-swap-veil-cursor').props.style).opacity as number;
        expect(cursorOpacity()).toBe((cursorMin + cursorMax) / 2);
        act(() => {
          jest.advanceTimersByTime(intervalMs * 2);
        });
        expect(cursorOpacity()).toBe((cursorMin + cursorMax) / 2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('paints no empty layer and no cursor through the quiet phase, where the last frame is the point', () => {
      render(
        <ThemeProvider>
          <SessionSwapVeil />
        </ThemeProvider>,
      );

      expect(screen.queryByTestId('session-swap-veil-empty')).toBeNull();
      expect(screen.queryByTestId('session-swap-veil-cursor')).toBeNull();
      expect(screen.getByTestId('session-swap-veil').props.accessibilityLabel).toBe(
        SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL,
      );
    });
  });

  /**
   * The mechanism assertion, copied from Skeleton's motion-gate block: a veil
   * that never animates still renders a correct-looking static scrim, so the
   * rendered output cannot tell a gated pulse from a mapper silently
   * registered behind it. The per-vsync Reanimated flush walks every
   * REGISTERED mapper, dirty or not (~0.47 CPU points each, measured on a
   * release build), so the hooks must live in the child that is mounted
   * only on the animating branch.
   */
  describe('the motion gate', () => {
    it('rests at the mid opacity and registers no animated mapper under OS reduced motion', () => {
      jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');

      render(
        <ThemeProvider>
          <SessionSwapVeil />
        </ThemeProvider>,
      );

      const flattenedStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil-scrim').props.style);
      expect(flattenedStyle.opacity).toBe((opacityMin + opacityMax) / 2);
      expect(animatedStyleSpy).not.toHaveBeenCalled();
    });

    it('rests at the mid opacity and registers no animated mapper while the screen is blurred', () => {
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');

      render(
        <ThemeProvider>
          <ScreenMotionOverride active={false}>
            <SessionSwapVeil />
          </ScreenMotionOverride>
        </ThemeProvider>,
      );

      const flattenedStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil-scrim').props.style);
      expect(flattenedStyle.opacity).toBe((opacityMin + opacityMax) / 2);
      expect(animatedStyleSpy).not.toHaveBeenCalled();
    });

    it('registers exactly one animated mapper once the screen is focused', () => {
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');

      render(
        <ThemeProvider>
          <ScreenMotionOverride active={true}>
            <SessionSwapVeil />
          </ScreenMotionOverride>
        </ThemeProvider>,
      );

      expect(animatedStyleSpy).toHaveBeenCalledTimes(1);
    });
  });
});
